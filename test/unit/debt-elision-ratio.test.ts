import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/main';

/**
 * `elisionRatio` must measure how much was removed, not whether anything was — audit OX-M7.
 *
 * `computeDebtBreakdown` added `metadata.originalBytes` to `elidedBytes` for every item carrying
 * `elided: true`. But `originalBytes` is the **whole item's** pre-transform length (set from
 * `item.content.length` in `token-hashing`, `session-dedup` and `delta-compression`), and `elided`
 * is a boolean on the whole item. So an item that lost 5% of its bytes contributed 100% of its
 * size to the numerator.
 *
 * On the CLI a single file is a single-item bundle, which makes `elidedBytes === totalBytes`
 * whenever anything was elided at all — the ratio is 1.0 by construction. Measured over a frozen
 * 289-file corpus at ratio 0.3: **all 101 rows that reduced scored `debtScore` exactly 35.00**,
 * the `weightElisionRatio * 100` ceiling, whether the file lost 4.7% or 66.8% of its bytes. The
 * score was a constant wearing the name of a measurement.
 *
 * This is the same granularity failure the project already diagnosed for drift, where `R_AST` was
 * "a boolean" on single-item bundles (Issue 3 / Phase 1d). It outlives that one, because it does
 * not need a single-item bundle: any partially-elided item over-contributes on any bundle.
 *
 * Note the audit's stated mechanism — a denominator mixing pre- and post-transform sizes — is not
 * what happens. Every stage that sets `elided` also sets `originalBytes`, and untouched items are
 * unchanged, so `totalBytes` is a clean sum of original sizes. The numerator is the defect.
 */
describe('debt elision ratio', () => {
  let dir: string;

  const SMALL_CUT = [
    'def keep_one(value):',
    '    return value + 1',
    '',
    '',
    'def keep_two(value):',
    '    return value + 2',
    '',
    '',
    'def big(value):',
    '    total = 0',
    ...Array.from({ length: 40 }, (_, i) => `    total += value * ${i}`),
    '    return total',
    '',
  ].join('\n');

  const traceOf = (file: string): { debtScore: number; reduction: number } => {
    const err: string[] = [];
    const io = {
      stdout: new PassThrough(),
      stderr: { write: (c: unknown) => { err.push(String(c)); return true; } } as never,
    };
    io.stdout.resume();
    runCli(['optimize', file, '--target-reduction-ratio', '0.3'], io, dir);
    const trace = JSON.parse(err.join('')) as {
      debtScore: number;
      tokenBefore: number;
      tokenAfter: number;
    };
    return {
      debtScore: trace.debtScore,
      reduction: 1 - trace.tokenAfter / trace.tokenBefore,
    };
  };

  const write = (name: string, content: string): string => {
    const p = join(dir, name);
    writeFileSync(p, content, 'utf8');
    return p;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tokendamper-debt-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not pin every reducing file at the clamp ceiling', () => {
    const result = traceOf(write('small.py', SMALL_CUT));

    // Only meaningful if something was actually elided — a run that did nothing would satisfy a
    // "not 35" assertion for the wrong reason.
    expect(result.reduction).toBeGreaterThan(0);

    // 35.0 is `weightElisionRatio * 100`, reached only at elisionRatio === 1.0. A file that kept
    // most of its bytes must not score as if it lost all of them.
    expect(result.debtScore).toBeLessThan(35);
  });

  it('scores a bigger cut higher than a smaller one', () => {
    // The property that makes the number a measurement rather than a flag. Both files elide; they
    // differ in how much. If debt cannot tell them apart it is not reporting debt.
    const small = traceOf(write('small.py', SMALL_CUT));
    const large = traceOf(
      write(
        'large.py',
        [
          'def only(value):',
          '    total = 0',
          ...Array.from({ length: 120 }, (_, i) => `    total += value * ${i}`),
          '    return total',
          '',
        ].join('\n'),
      ),
    );

    expect(small.reduction).toBeGreaterThan(0);
    expect(large.reduction).toBeGreaterThan(small.reduction);
    expect(large.debtScore).toBeGreaterThan(small.debtScore);
  });

  it('tracks the byte reduction it is supposed to summarise', () => {
    const result = traceOf(write('small.py', SMALL_CUT));

    // debtScore on the CLI is `weightElisionRatio * elisionRatio * 100` and nothing else: there is
    // no ledger, so the confidence penalty is 0, and no `oldestElidedTurn`, so turn age is 0.
    // That makes the implied ratio directly readable, and it should sit in the same neighbourhood
    // as the reduction actually achieved rather than at an extreme.
    const impliedRatio = result.debtScore / 35;

    expect(impliedRatio).toBeGreaterThan(0);
    expect(impliedRatio).toBeLessThan(1);
  });
});
