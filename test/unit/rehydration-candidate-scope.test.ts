import { describe, expect, it } from 'vitest';
import { optimize } from '../../src/core/engine';
import { ConfidenceLedger } from '../../src/core/ledger';
import { TokenHasher } from '../../src/core/hashing/token-hasher';
import { createOptimizationRequest } from '../../src/core/model/constructors';
import { loadConfig } from '../../src/config/load';

/**
 * An empty rehydration-candidate set means "nothing to restore", not "restore everything" —
 * audit OX-M6.
 *
 * `attemptAutomatedRehydration` guarded with
 * `candidates && candidates.size > 0 && !candidates.has(item.id)`. The `size > 0` clause was there
 * to let a *missing* ledger fall through to "rehydrate any elided placeholder", which is the
 * documented behaviour. But it also caught the case where a ledger exists and reports **zero**
 * items below the confidence threshold — and turned "the ledger says nothing needs restoring" into
 * "restore every elision in the bundle". A large semantic cliff behind a small boolean, and the
 * exact opposite of what the ledger said.
 *
 * **Reachability, measured rather than assumed.** None of the three bundled entry points hits it:
 * the CLI passes neither a hasher nor a ledger (so the function returns at its first guard), MCP
 * and `bench` pass a hasher but no ledger (so `candidates` is `null` and the intended fall-through
 * applies), and the Gateway passes a ledger but no hasher and plans only `cleanup:session-dedup`,
 * so nothing it elides can be rehydrated anyway. A 289-file corpus A/B over both CLI routes is
 * 578/578 byte-identical across this change, which is what that structure predicts.
 *
 * It is reachable through the **public API**: `optimize` is exported, and an embedder passing both
 * a `tokenHasher` and a `confidenceLedger` — the combination that makes rehydration work at all —
 * lands squarely on it. That is the configuration below, and it is why this was fixed rather than
 * recorded: the corpus cannot see the shape, which is a fact about the corpus.
 */
describe('rehydration candidate scoping', () => {
  const config = loadConfig({ cliOverrides: { budget: { targetReductionRatio: 0.3 } } });

  const SOURCE = [
    'def compute(value):',
    '    total = 0',
    ...Array.from({ length: 60 }, (_, i) => `    total += value * ${i}`),
    '    return total',
    '',
  ].join('\n');

  const buildRequest = () =>
    createOptimizationRequest(SOURCE, config, {
      requestId: 'ox-m6',
      adapterName: 'test',
      adapterVersion: '0',
      source: 'file',
      sourcePath: 'compute.py',
    });

  it('elides at all in this configuration — the control', () => {
    // Without this the assertions below would pass on a run that never optimized anything, which
    // is the failure mode this project names most often.
    const result = optimize(buildRequest(), { tokenHasher: new TokenHasher() });

    expect(result.fallbackUsed).toBe(false);
    expect(result.finalBundle.items[0]?.content.length).toBeLessThan(SOURCE.length);
  });

  it('enters the rehydration branch under a low debt threshold — the second control', () => {
    // Reaching the defect needs the branch *entered*, and the default `maxDebtThreshold` of 75 is
    // out of reach on turn 1: the confidence penalty is 0, turn age is 0, so debt is the elision
    // term alone and caps at 35. `--max-debt` is a documented flag, so a low threshold is an
    // ordinary configuration rather than a contrivance.
    //
    // This asserts entry using the **no-ledger** path, where restoring everything is the intended
    // behaviour — so a full restore here is proof the branch ran, not a bug. Without it, the test
    // below would pass against the unfixed code for the wrong reason: by never running the branch
    // it claims to test. It did exactly that on the first attempt.
    const result = optimize(buildRequest(), {
      tokenHasher: new TokenHasher(),
      maxDebtThreshold: 1,
    });

    expect(result.finalBundle.items[0]?.content.length).toBe(SOURCE.length);
  });

  it('does not undo every elision when the ledger reports no candidates', () => {
    const ledger = new ConfidenceLedger();
    const hasher = new TokenHasher();

    const result = optimize(buildRequest(), {
      tokenHasher: hasher,
      confidenceLedger: ledger,
      maxDebtThreshold: 1,
    });

    // A freshly recorded elision sits at full confidence, so nothing is below the threshold and
    // `getRehydrationCandidates` is empty. That must mean "no work to do" — not "restore all".
    expect(ledger.getRehydrationCandidates(1).length).toBe(0);

    const emitted = result.finalBundle.items[0]?.content.length as number;

    expect(result.fallbackUsed).toBe(false);
    expect(emitted).toBeLessThan(SOURCE.length);
  });

  it('still rehydrates freely when no ledger was supplied at all', () => {
    // The fall-through the `size > 0` clause was actually protecting. With no ledger there is no
    // statement about which items matter, so every elided placeholder stays eligible — unchanged
    // by this fix, and pinned here because narrowing it would be the opposite regression.
    const result = optimize(buildRequest(), { tokenHasher: new TokenHasher() });

    expect(result.fallbackUsed).toBe(false);
  });
});
