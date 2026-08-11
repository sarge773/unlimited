import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A handful of lib modules are pure by design: functions over their arguments,
// no I/O, no DB, no config. error-classify.ts says so in its own header and
// gives the reason — it is imported by the proxy, the responses path AND the
// fusion panel, so a value import there is how the fusion ↔ proxy cycle comes
// back. The others are the same shape: parsers and formatters that several
// surfaces share precisely because they depend on nothing.
//
// Nothing enforces that today. Adding `import { getDb }` to one of them
// compiles, passes every test, and quietly converts a leaf into a hub — the
// damage (an import cycle, a DB read on a hot path that must never throw, a
// unit test that suddenly needs a database) surfaces later and somewhere else.
// Same rationale as registry-drift.test.ts: make the quiet no-op a failing
// test.
//
// TYPE imports stay legal. `import type` is erased before it can create a
// cycle or pull in a runtime dependency, which is why the type-only modules
// below are on the list rather than excluded from it.

const here = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(here, '../../lib');

const PURE_MODULES = [
  'budget.ts',
  'error-classify.ts',
  'header-value.ts',
  'structured-output.ts',
  'tool-args.ts',
  'tool-call-rescue.ts',
  // Type-only imports today; listed so they stay that way.
  'client-classifier.ts',
  'content.ts',
  'think-tags.ts',
];

/** Import statements that survive compilation, i.e. everything except
 *  `import type ...`. Also catches bare side-effect imports (`import './x.js'`)
 *  and `require(...)`, which are value dependencies just as much. */
function valueImportsIn(source: string): string[] {
  const found: string[] = [];
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('//') || line.startsWith('*')) continue;
    if (/^import\s+type\b/.test(line)) continue;
    // `import { type A, type B } from` is also fully erased.
    const named = /^import\s*\{([^}]*)\}\s*from/.exec(line);
    if (named && named[1].split(',').every(s => s.trim() === '' || /^type\s/.test(s.trim()))) continue;
    if (/^import\b/.test(line)) found.push(line);
    if (/\brequire\s*\(/.test(line)) found.push(line);
  }
  return found;
}

describe('pure lib modules stay pure', () => {
  it.each(PURE_MODULES)('%s has no value imports', (filename) => {
    const source = fs.readFileSync(path.join(LIB, filename), 'utf8');

    expect(valueImportsIn(source)).toEqual([]);
  });

  it('every listed module actually exists', () => {
    // A rename that leaves the list behind would otherwise silently stop
    // guarding anything.
    for (const filename of PURE_MODULES) {
      expect(fs.existsSync(path.join(LIB, filename)), `${filename} is listed but missing`).toBe(true);
    }
  });

  it('the detector recognises the forms it has to catch', () => {
    expect(valueImportsIn("import type { A } from './a.js';")).toEqual([]);
    expect(valueImportsIn("import { type A, type B } from './a.js';")).toEqual([]);

    expect(valueImportsIn("import { getDb } from '../db/index.js';")).toHaveLength(1);
    expect(valueImportsIn("import fs from 'node:fs';")).toHaveLength(1);
    expect(valueImportsIn("import './side-effect.js';")).toHaveLength(1);
    expect(valueImportsIn("const x = require('node:fs');")).toHaveLength(1);
    expect(valueImportsIn("import { type A, getDb } from '../db/index.js';")).toHaveLength(1);
  });
});
