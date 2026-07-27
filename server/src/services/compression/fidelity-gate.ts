import type { ChatMessage } from '@freellmapi/shared/types.js';
import { allMessageText, messageChars } from './helpers.js';
import { extractProtectedValues, scanProtectedSpans } from './preservation.js';

export interface FidelityResult {
  accepted: boolean;
  reason?: 'inflation' | 'fidelity';
  protectedTokenSurvival: number;
  numericLiteralsPreserved: boolean;
  jsonKeySurvival: number;
  diffHunksPreserved: boolean;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function survival(values: string[], output: string): number {
  const required = unique(values);
  if (required.length === 0) return 1;
  return required.filter(value => output.includes(value)).length / required.length;
}

function toolEnvelope(messages: ChatMessage[]): string[] {
  return messages.flatMap(message => [
    ...(message.tool_calls ?? []).map(call => JSON.stringify(call)),
    ...(message.tool_call_id ? [`result:${message.tool_call_id}`] : []),
  ]);
}

export function checkFidelity(before: ChatMessage[], after: ChatMessage[]): FidelityResult {
  const beforeChars = messageChars(before);
  const afterChars = messageChars(after);
  if (afterChars >= beforeChars) {
    return {
      accepted: false,
      reason: 'inflation',
      protectedTokenSurvival: 1,
      numericLiteralsPreserved: true,
      jsonKeySurvival: 1,
      diffHunksPreserved: true,
    };
  }

  const input = allMessageText(before);
  const output = allMessageText(after);
  // Numbers and JSON keys have their own deliberately shaped invariants below:
  // jsoncompact keeps a key in the table header (without its original colon),
  // while every numeric literal remains verbatim. Counting the original
  // `"key":` span again here would incorrectly reject that proven-lossless
  // representation.
  const protectedTokenSurvival = survival(
    scanProtectedSpans(input)
      .filter(span => !span.kinds.every(kind => kind === 'number' || kind === 'json-key'))
      .map(span => span.text),
    output,
  );
  const numericLiteralsPreserved = survival(extractProtectedValues(input, 'number'), output) === 1;
  const jsonKeySurvival = survival(
    extractProtectedValues(input, 'json-key').map(value => value.replace(/\s*:\s*$/, '')),
    output,
  );
  const diffHunksPreserved = survival(extractProtectedValues(input, 'diff-hunk'), output) === 1;
  const envelopesPreserved = toolEnvelope(before).every(value => toolEnvelope(after).includes(value));
  const accepted = protectedTokenSurvival >= 0.95
    && numericLiteralsPreserved
    && jsonKeySurvival >= 0.9
    && diffHunksPreserved
    && envelopesPreserved;

  return {
    accepted,
    ...(accepted ? {} : { reason: 'fidelity' as const }),
    protectedTokenSurvival,
    numericLiteralsPreserved,
    jsonKeySurvival,
    diffHunksPreserved,
  };
}
