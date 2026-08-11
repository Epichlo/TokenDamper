import { describe, expect, it } from 'vitest';
import { ceilingReached, resolveTokenCeiling } from '../../src/core/budget';
import { optimize } from '../../src/core/engine';
import { createContextBundle, createOptimizationBudget, createOptimizationRequest } from '../../src/core/model/constructors';
import { DEFAULT_CONFIG } from '../../src/config/schema';
import type { ResolvedConfig } from '../../src/core/model/types';

/**
 * `--target-reduction-ratio` is a real target — audit H4's deferred half.
 *
 * It used to be a dial in name only: the planner read it as `> 0` to pick knapsack mode over
 * pass-through, and nothing else read it at all, so `0.01` and `0.99` produced byte-identical
 * output. It was kept when the other dead knobs were withdrawn because every document and example
 * uses it and making it real is a pipeline change rather than a flag change.
 *
 * Two things had to happen. The ratio had to *reach* the machinery — `pruning:topology-pruner`
 * gated on `maxInputTokens` and bypassed itself entirely when only a ratio was set — and
 * compression had to *stop* at the target instead of eliding everything it could.
 */

const configWith = (overrides: Partial<ResolvedConfig['budget']>): ResolvedConfig => ({
  ...DEFAULT_CONFIG,
  budget: { ...DEFAULT_CONFIG.budget, ...overrides },
});

const SOURCE = Array.from(
  { length: 8 },
  (_, i) => `export function fn${i}(values: number[]): number {
  let total = ${i};
  for (const value of values) {
    total += value;
    total = total * 2;
    total = total - 1;
    total = Math.max(total, 0);
  }
  return total;
}`,
).join('\n\n');

function runAt(ratio: number | undefined, maxInputTokens?: number) {
  const config = configWith({
    ...(ratio === undefined ? {} : { targetReductionRatio: ratio }),
    ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
  });
  const request = createOptimizationRequest(SOURCE, config, {
    requestId: 'r',
    adapterName: 'test',
    adapterVersion: '1',
    source: 'file',
    sourcePath: 'a.ts',
    language: 'typescript',
  });
  const result = optimize(request, {});
  const achieved = 1 - result.trace.tokenAfter / result.trace.tokenBefore;
  return { result, achieved };
}

describe('the ratio resolves to a token ceiling', () => {
  const bundle = createContextBundle(SOURCE, 'file', 'a.ts');

  it('converts a proportional target into an absolute ceiling', () => {
    const total = bundle.summary.tokenEstimate;
    const ceiling = resolveTokenCeiling(bundle, createOptimizationBudget({ targetReductionRatio: 0.25 }));
    expect(ceiling).toBe(Math.floor(total * 0.75));
  });

  it('takes the tighter of the two ceilings, because both are caps', () => {
    const total = bundle.summary.tokenEstimate;
    // A 0.9 ratio permits 10% of the bundle; maxInputTokens of 5 permits 5 tokens. Honouring
    // anything but the smaller would exceed a limit the caller set.
    const ceiling = resolveTokenCeiling(
      bundle,
      createOptimizationBudget({ targetReductionRatio: 0.9, maxInputTokens: 5 }),
    );
    expect(ceiling).toBe(5);
    expect(ceiling).toBeLessThan(Math.floor(total * 0.1) + 1);
  });

  it('is undefined when neither ceiling is set, so nothing changes', () => {
    expect(resolveTokenCeiling(bundle, createOptimizationBudget({}))).toBeUndefined();
    expect(ceilingReached(100, undefined)).toBe(false);
  });
});

describe('the ratio changes the output it is supposed to change', () => {
  it('produces different reductions for different ratios', () => {
    // The precise defect H4 recorded: `0.01` and `0.99` produced byte-identical output. Any
    // assertion weaker than "these differ" would have passed against the broken build.
    const low = runAt(0.1);
    const high = runAt(0.9);

    expect(low.result.fallbackUsed).toBe(false);
    expect(high.result.fallbackUsed).toBe(false);
    expect(low.result.emittedOutput).not.toBe(high.result.emittedOutput);
    expect(low.achieved).toBeLessThan(high.achieved);
  });

  it('a modest target removes strictly less than a maximal one', () => {
    // Overshooting is not a bonus: every extra elision spends fidelity, raises drift, and is
    // irreversible on the CLI. A modest target must remove less than "as much as possible".
    //
    // "As much as possible" is expressed as a near-1.0 ratio, not as `maxInputTokens: 1`. That
    // was the first version of this test and it asserted against 0%: a 1-token ceiling leaves
    // the knapsack nothing selectable — every item is pinned by prefix locking (invariant 7) —
    // so the run reduces nothing at all. The test failed for a reason that had nothing to do
    // with the behaviour being tested.
    const modest = runAt(0.1);
    const maximal = runAt(0.99);
    expect(modest.achieved).toBeLessThan(maximal.achieved);
    expect(modest.achieved).toBeGreaterThan(0);
  });

  it('never reduces less than nothing, and never falls back merely for having a target', () => {
    for (const ratio of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const { result, achieved } = runAt(ratio);
      expect(result.fallbackUsed).toBe(false);
      expect(achieved).toBeGreaterThan(0);
    }
  });

  it('is monotonic: a larger target never reduces less', () => {
    const ratios = [0.1, 0.2, 0.3, 0.5, 0.7, 0.9];
    const achieved = ratios.map((r) => runAt(r).achieved);
    for (let i = 1; i < achieved.length; i++) {
      expect(achieved[i]!).toBeGreaterThanOrEqual(achieved[i - 1]!);
    }
  });
});

describe('what the target does not promise', () => {
  it('may overshoot, because a region is the smallest thing it can remove', () => {
    // Stated as a test rather than left for a user to discover. Elision granularity is one
    // region — typically a whole function body — and files commonly have one dominant region:
    // measured across three of this repo's sources, the largest was 58%, 61% and 83% of the file.
    // When the target needs more than the small regions provide, the dominant one goes in whole
    // and the result overshoots. Measured on the frozen corpus at target 30%: 21 of 66 reducing
    // files landed in 25-35%, and 23 still exceeded 50%.
    //
    // This test documents the limit; it is not an aspiration to loosen. Closing it needs
    // sub-region elision, which is a separate piece of work.
    const { achieved } = runAt(0.05);
    expect(achieved).toBeGreaterThan(0);
    // Deliberately not asserting `achieved <= 0.05` — that would be asserting a guarantee the
    // implementation does not make.
  });
});
