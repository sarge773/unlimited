import { z } from 'zod';
import { registerEngine } from '../registry.js';
import { scanProtectedSpans } from '../preservation.js';
import { textContent, withTextContent } from '../helpers.js';
import { BUILTIN_FILTERS, type ToolFilterRule } from './filter-definitions.js';
import { loadCustomFilters } from './custom-filters.js';
import type { CompressionEngine, ToolCallOrigin } from '../types.js';

const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
export const ERROR_GUARD_RE = /\b(?:error|exception|fatal|failed|failure|traceback|panic|assert(?:ion)?|not ok|✗|×)\b/i;

function safeRegex(source: string, flags = 'i'): RegExp | null {
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

function matches(rule: ToolFilterRule, content: string, origin?: ToolCallOrigin): boolean {
  if (rule.id === 'fallback') return true;
  const name = origin?.name.toLowerCase();
  if (name && rule.detect.toolNames.some(candidate => candidate.toLowerCase() === name)) {
    if (rule.detect.content.length === 0) return true;
    // Generic shell tools still need content-shape detection.
  }
  return rule.detect.content.some(pattern => safeRegex(pattern, 'im')?.test(content));
}

function mustKeep(line: string): boolean {
  return ERROR_GUARD_RE.test(line) || scanProtectedSpans(line).length > 0;
}

function collapseRuns(lines: string[], minimum: number): string[] {
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    let end = index + 1;
    while (end < lines.length && lines[end] === lines[index]) end += 1;
    const count = end - index;
    if (count >= minimum && !mustKeep(lines[index])) {
      output.push(lines[index], `[… ${count - 2} identical lines omitted …]`, lines[end - 1]);
    } else {
      output.push(...lines.slice(index, end));
    }
    index = end;
  }
  return output;
}

function selectHeadTail(lines: string[], head: number, tail: number): string[] {
  if (lines.length <= head + tail) return lines;
  const selected = new Set<number>();
  for (let index = 0; index < Math.min(head, lines.length); index += 1) selected.add(index);
  for (let index = Math.max(0, lines.length - tail); index < lines.length; index += 1) selected.add(index);
  lines.forEach((line, index) => { if (mustKeep(line)) selected.add(index); });
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    if (selected.has(index)) {
      output.push(lines[index]);
      index += 1;
      continue;
    }
    const start = index;
    while (index < lines.length && !selected.has(index)) index += 1;
    output.push(`[… ${index - start} lines omitted …]`);
  }
  return output;
}

function enforceMaxChars(lines: string[], maxChars: number): string[] {
  const output = [...lines];
  const length = () => output.join('\n').length;
  while (output.length > 2 && length() > maxChars) {
    let removeAt = -1;
    let bestDistance = Number.NEGATIVE_INFINITY;
    const middle = (output.length - 1) / 2;
    output.forEach((line, index) => {
      if (mustKeep(line) || /^\[… \d+ (?:lines|identical lines) omitted …\]$/.test(line)) return;
      const distance = -Math.abs(index - middle);
      if (distance > bestDistance) {
        bestDistance = distance;
        removeAt = index;
      }
    });
    if (removeAt === -1) break;
    output.splice(removeAt, 1);
  }
  return output;
}

function applyRule(
  content: string,
  rule: ToolFilterRule,
  intensity: 'minimal' | 'standard' | 'aggressive',
  configuredMaxLines: number,
  configuredMaxChars: number,
): string {
  let lines = (rule.stripAnsi ? content.replace(ANSI_RE, '') : content).split('\n');
  lines = lines.filter(line => {
    if (mustKeep(line)) return true;
    for (const drop of rule.dropLines) {
      const pattern = safeRegex(drop.pattern);
      if (!pattern?.test(line)) continue;
      const unless = drop.unless ? safeRegex(drop.unless) : null;
      if (!unless || !unless.test(line)) return false;
    }
    if (rule.keepLines.length > 0) {
      return rule.keepLines.some(pattern => safeRegex(pattern)?.test(line));
    }
    return true;
  });
  if (rule.collapseRuns) lines = collapseRuns(lines, rule.collapseRuns.min);
  const budgets = {
    minimal: { head: 50, tail: 35 },
    standard: { head: 30, tail: 20 },
    aggressive: { head: 15, tail: 15 },
  }[intensity];
  const maxLines = Math.max(10, configuredMaxLines);
  if (rule.headTail && lines.length > maxLines) {
    const ratio = Math.min(1, maxLines / (budgets.head + budgets.tail));
    lines = selectHeadTail(
      lines,
      Math.max(5, Math.floor(budgets.head * ratio)),
      Math.max(5, Math.floor(budgets.tail * ratio)),
    );
  }
  lines = enforceMaxChars(lines, Math.min(configuredMaxChars, rule.maxChars ?? Infinity));
  return lines.join('\n');
}

const toolFilterEngine: CompressionEngine = {
  id: 'toolfilter',
  priority: 10,
  lossless: false,
  targets: ['tool-results'],
  configSchema: z.object({
    enabled: z.boolean(),
    intensity: z.enum(['minimal', 'standard', 'aggressive']).default('standard'),
    maxLinesPerResult: z.number().int().positive().default(120),
    maxCharsPerResult: z.number().int().positive().default(12_000),
    disabledFilters: z.array(z.string()).default([]),
  }).passthrough(),
  apply({ messages, config, context }) {
    const intensity = config.intensity === 'minimal' || config.intensity === 'aggressive'
      ? config.intensity
      : 'standard';
    const maxLines = typeof config.maxLinesPerResult === 'number' ? config.maxLinesPerResult : 120;
    const maxChars = typeof config.maxCharsPerResult === 'number' ? config.maxCharsPerResult : 12_000;
    const disabled = new Set(Array.isArray(config.disabledFilters) ? config.disabledFilters.filter(v => typeof v === 'string') : []);
    const rules = [
      ...loadCustomFilters(Boolean((config as Record<string, unknown>).trustProjectFilters)),
      ...BUILTIN_FILTERS,
    ].filter(rule => !disabled.has(rule.id));
    const filtersApplied: Record<string, number> = {};
    const output = messages.map((message, index) => {
      const content = textContent(message);
      if (message.role !== 'tool' || content == null || context.frozenMessageIndexes.has(index)) return message;
      const origin = message.tool_call_id ? context.toolCallOrigins.get(message.tool_call_id) : undefined;
      const rule = rules.find(candidate => matches(candidate, content, origin));
      if (!rule) return message;
      const next = applyRule(content, rule, intensity, maxLines, maxChars);
      if (next.length >= content.length) return message;
      filtersApplied[rule.id] = (filtersApplied[rule.id] ?? 0) + 1;
      return withTextContent(message, next);
    });
    return { messages: output, details: { filtersApplied } };
  },
};

registerEngine(toolFilterEngine);
