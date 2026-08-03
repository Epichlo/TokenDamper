import { describe, expect, it } from 'vitest';
import { validateItemAst } from '../../src/core/validation/ast';
import { createContextItem } from '../../src/core/model/constructors';

/**
 * `validateItemAst` enforces a 5ms latency budget. Until this test was written it turned a
 * breach into `valid: false` plus an `AST_SLA_EXCEEDED` issue — so a *timing* measurement
 * decided a *syntax* verdict.
 *
 * Two things follow, and both are defects rather than trade-offs:
 *
 *  1. It is non-deterministic. The same bytes validate differently depending on machine
 *     load and JIT warmth. Measured across six fresh Node processes on a 16 KB Python file:
 *     `valid(4.06ms) INVALID(5.28ms) INVALID(6.86ms) INVALID(8.04ms) INVALID(14.70ms)
 *     INVALID(17.58ms)`. "Same input → same bytes out" is the product.
 *  2. It is the sixth instance of this project's recurring pattern in reverse: rather than a
 *     check passing without running, a check *fails* for a reason it never examined. A slow
 *     validator does not mean the content is syntactically invalid, but the engine treats it
 *     that way and falls back — which is exactly what blocked sub-item hashing from ever
 *     reaching the output on a realistically sized file.
 *
 * The budget is still measured and still reported, as an observability signal. It just no
 * longer votes on validity.
 */
describe('AST validation latency budget', () => {
  const bigValidPython = createContextItem({
    id: 'big',
    kind: 'file',
    contentType: 'code',
    // Large enough to blow a 5ms budget on a cold run, and unambiguously valid.
    content: Array.from({ length: 400 }, (_, i) => `def fn_${i}(value):\n    return value + ${i}\n`).join('\n'),
    path: 'src/big.py',
    language: 'python',
  });

  it('does not let a slow validation change the syntax verdict', () => {
    const result = validateItemAst(bigValidPython, { maxTimeMs: 0 });

    // A budget of 0ms is guaranteed to be exceeded, which makes this assertion about the
    // rule rather than about how fast this machine happens to be.
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.valid).toBe(true);
    expect(result.issues.map((issue) => issue.code)).not.toContain('AST_SLA_EXCEEDED');
  });

  it('returns the same verdict regardless of the budget it is given', () => {
    const codes = (maxTimeMs: number) =>
      validateItemAst(bigValidPython, { maxTimeMs })
        .issues.map((issue) => issue.code)
        .sort();

    expect(codes(0)).toEqual(codes(5));
    expect(codes(0)).toEqual(codes(10_000));
    expect(validateItemAst(bigValidPython, { maxTimeMs: 0 }).valid).toBe(
      validateItemAst(bigValidPython, { maxTimeMs: 10_000 }).valid,
    );
  });

  it('still reports genuine syntax errors in content that is also slow', () => {
    const broken = createContextItem({
      id: 'broken',
      kind: 'file',
      contentType: 'code',
      content: `${bigValidPython.content}\nexport function unclosed(): void {\n`,
      path: 'src/big.ts',
      language: 'typescript',
    });

    const result = validateItemAst(broken, { maxTimeMs: 0 });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('AST_UNBALANCED_BRACKET');
    expect(result.issues.map((issue) => issue.code)).not.toContain('AST_SLA_EXCEEDED');
  });

  it('still measures the budget, so the signal is not lost', () => {
    expect(validateItemAst(bigValidPython, { maxTimeMs: 0 }).slaExceeded).toBe(true);
    expect(validateItemAst(bigValidPython, { maxTimeMs: 10_000 }).slaExceeded).toBe(false);
  });
});
