import { beforeAll, describe, expect, it } from 'vitest';

import { createDeepBackends } from '../../packages/deep/src/index';
import { createContextItem } from '../../src/core/model/constructors';
import type { ParserAdapter } from '../../src/core/parser/types';
import { registerParserBackend, clearParserBackends } from '../../src/core/parser/registry';
import { selectValidator } from '../../src/core/validation/ast';

/**
 * R3 step 2 — Deep `check()`, and the control that says it examined anything.
 *
 * **§60 is the standard and its second half is the one that gets skipped.** A disagreement rate
 * is not evidence on its own, because **0 findings is also what a validator that examines
 * nothing reports**. So every language gets an *inverse* control: break the file in a way that
 * language's grammar must reject, and assert the validator catches it. §60 ran exactly this on
 * Go — delete the last column-0 `}` — and measured 99.66%.
 *
 * The Fast path's advertised guarantee is unchanged by any of this. §46 and §75 are explicit:
 * the shipped claim stays **bracket/quote integrity**, and `validator-guarantee.test.ts` — which
 * asserts that English prose *passes* the TypeScript lexer — stays exactly as written. Deep
 * being stricter is Deep's property, and the two are only ever compared, never merged.
 */

let backends: Map<string, ParserAdapter>;

beforeAll(async () => {
  backends = new Map((await createDeepBackends()).map((b) => [b.language, b]));
});

const VALID: Record<string, string> = {
  typescript: 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
  javascript: 'export function add(a, b) {\n  return a + b;\n}\n',
  python: 'def add(a, b):\n    return a + b\n',
  go: 'package math\n\nfunc Add(a int, b int) int {\n\treturn a + b\n}\n',
};

/**
 * One mutation per language that the grammar must reject.
 *
 * Brace deletion is §60's and it is meaningless for Python, which has no braces — so Python gets
 * the equivalent structural break, a `def` header with its colon removed. Reusing the brace
 * mutation there would have produced a file Python's grammar accepts and an inverse control that
 * silently proved nothing.
 */
const BROKEN: Record<string, string> = {
  typescript: 'export function add(a: number, b: number): number {\n  return a + b;\n',
  javascript: 'export function add(a, b) {\n  return a + b;\n',
  python: 'def add(a, b)\n    return a + b\n',
  go: 'package math\n\nfunc Add(a int, b int) int {\n\treturn a + b\n',
};

describe('deep check() accepts valid source', () => {
  for (const [language, content] of Object.entries(VALID)) {
    it(`passes well-formed ${language}`, () => {
      const result = backends.get(language)!.check(content);

      expect(result.valid, `issues: ${result.issues.map((i) => i.code).join(', ')}`).toBe(true);
      expect(result.issues).toEqual([]);
      expect(typeof result.durationMs).toBe('number');
    });
  }
});

describe('the inverse control: deep check() catches a break the grammar must reject', () => {
  for (const [language, content] of Object.entries(BROKEN)) {
    it(`rejects structurally broken ${language}`, () => {
      const result = backends.get(language)!.check(content);

      // Without this assertion the suite above is satisfied by a `check()` that returns
      // `valid: true` unconditionally — §60's point exactly.
      expect(result.valid).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0]?.code).toMatch(/^DEEP_/);
    });
  }
});

describe('an issue carries a position, so a finding can be looked at', () => {
  it('reports a line for the broken construct', () => {
    const issue = backends.get('typescript')!.check(BROKEN.typescript!).issues[0];

    expect(issue?.line).toBeTypeOf('number');
    expect(issue?.line).toBeGreaterThan(0);
    expect(issue?.column).toBeTypeOf('number');
  });
});

describe('deep is stricter than Fast, and that is the measurement rather than a bug', () => {
  it('the shipped TypeScript lexer passes English prose; deep does not', () => {
    // `validator-guarantee.test.ts` pins the first half as shipped behaviour. This asserts the
    // two differ, which is the whole reason a disagreement rate is worth measuring — if Deep
    // agreed with a lexer that accepts prose, it would not be a second opinion.
    const prose = 'The quick brown fox jumps over the lazy dog, and then it rests.\n';
    const fast = selectValidator(
      createContextItem({ id: 'p', kind: 'file', content: prose, language: 'typescript' }),
    );

    expect(fast?.validate(prose).valid).toBe(true);
    expect(backends.get('typescript')!.check(prose).valid).toBe(false);
  });
});

describe('deep check() reaches the pipeline through the seam in deep mode only', () => {
  it('validateItemAst uses the backend when the mode asks for it', () => {
    try {
      registerParserBackend(backends.get('typescript')!);
      const item = createContextItem({
        id: 'x',
        kind: 'file',
        content: BROKEN.typescript!,
        language: 'typescript',
      });

      // Fast: the shipped lexer. It catches this one too (an unbalanced brace is exactly what
      // it does check), so the assertion is on *which* code comes back, not on the verdict.
      const fast = selectValidator(item, 'fast')!.validate(item.content);
      expect(fast.issues.every((i) => !i.code.startsWith('DEEP_'))).toBe(true);

      const deep = selectValidator(item, 'deep')!.validate(item.content);
      expect(deep.valid).toBe(false);
      expect(deep.issues.some((i) => i.code.startsWith('DEEP_'))).toBe(true);
    } finally {
      clearParserBackends();
    }
  });
});
