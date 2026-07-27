export type ProtectedKind =
  | 'fenced-code'
  | 'inline-code'
  | 'url'
  | 'path'
  | 'json-key'
  | 'number'
  | 'stack-trace'
  | 'diff-hunk'
  | 'key-value'
  | 'error';

export interface ProtectedSpan {
  start: number;
  end: number;
  text: string;
  kinds: ProtectedKind[];
}

const RULES: Array<{ kind: ProtectedKind; regex: RegExp }> = [
  { kind: 'fenced-code', regex: /```[\s\S]*?```/g },
  { kind: 'inline-code', regex: /`[^`\n]+`/g },
  { kind: 'url', regex: /\bhttps?:\/\/[^\s<>()]+/gi },
  { kind: 'path', regex: /(?:\b[A-Za-z]:\\(?:[^\\\s:"<>|?*]+\\)*[^\\\s:"<>|?*]*|\B~?\/(?:[\w.@%+~=-]+\/)*[\w.@%+~=-]+|\B\.{1,2}\/(?:[\w.@%+~=-]+\/)*[\w.@%+~=-]+)/g },
  { kind: 'json-key', regex: /"(?:\\.|[^"\\])+"\s*:/g },
  { kind: 'number', regex: /(?<![\w])[-+]?(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)(?![\w])/g },
  { kind: 'stack-trace', regex: /^\s*at\s+.+$/gm },
  { kind: 'diff-hunk', regex: /^@@[^\n]*@@[^\n]*$/gm },
  { kind: 'key-value', regex: /\b[A-Za-z_][A-Za-z0-9_.-]*=(?:"[^"]*"|'[^']*'|[^\s]+)/g },
  { kind: 'error', regex: /^.*\b(?:error|exception|fatal|failed|failure|traceback|panic)\b.*$/gim },
];

export function mergeProtectedSpans(spans: ProtectedSpan[]): ProtectedSpan[] {
  const ordered = spans
    .filter(span => span.end > span.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: ProtectedSpan[] = [];
  for (const span of ordered) {
    const previous = merged[merged.length - 1];
    if (!previous || span.start > previous.end) {
      merged.push({ ...span, kinds: [...new Set(span.kinds)] });
      continue;
    }
    previous.end = Math.max(previous.end, span.end);
    previous.kinds = [...new Set([...previous.kinds, ...span.kinds])];
  }
  return merged;
}

export function scanProtectedSpans(text: string): ProtectedSpan[] {
  const spans: ProtectedSpan[] = [];
  for (const rule of RULES) {
    rule.regex.lastIndex = 0;
    for (const match of text.matchAll(rule.regex)) {
      if (match.index == null || !match[0]) continue;
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
        kinds: [rule.kind],
      });
    }
  }
  return mergeProtectedSpans(spans).map(span => ({ ...span, text: text.slice(span.start, span.end) }));
}

export function transformUnprotectedText(text: string, transform: (part: string) => string): string {
  const spans = scanProtectedSpans(text);
  if (spans.length === 0) return transform(text);
  const placeholders: string[] = [];
  let masked = '';
  let cursor = 0;
  spans.forEach((span, index) => {
    const placeholder = `\uE000${index.toString(36)}\uE001`;
    placeholders.push(text.slice(span.start, span.end));
    masked += text.slice(cursor, span.start);
    masked += placeholder;
    cursor = span.end;
  });
  masked += text.slice(cursor);
  let result = transform(masked);
  placeholders.forEach((value, index) => {
    result = result.replace(`\uE000${index.toString(36)}\uE001`, value);
  });
  return result;
}

export function hasProtectedContent(text: string): boolean {
  return scanProtectedSpans(text).length > 0;
}

export function protectedLines(text: string): string[] {
  return text.split('\n').filter(line => scanProtectedSpans(line).length > 0);
}

export function extractProtectedValues(text: string, kind?: ProtectedKind): string[] {
  const values: string[] = [];
  if (!kind) return scanProtectedSpans(text).map(span => span.text);
  const rule = RULES.find(entry => entry.kind === kind);
  if (!rule) return values;
  rule.regex.lastIndex = 0;
  for (const match of text.matchAll(rule.regex)) {
    if (match[0]) values.push(match[0]);
  }
  return values;
}
