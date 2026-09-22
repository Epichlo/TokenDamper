import { afterEach, describe, expect, it } from 'vitest';
import { optimize } from '../../src/core/engine';
import { clearParserBackends, registerParserBackend } from '../../src/core/parser/registry';
import {
  createBundleFromItems,
  createContextBundle,
  createContextItem,
  createOptimizationBudget,
} from '../../src/core/model/constructors';
import { loadConfig } from '../../src/config/load';
import { TOKENDAMPER_VERSION } from '../../src/version';
import type { OptimizationRequest } from '../../src/core/model';
import type { ParserAdapter } from '../../src/core/parser/types';

// Over MIN_REGION_BYTES (104), so Fast genuinely elides it — the third assertion below
// depends on fast mode changing the output.
const SRC =
  'export function f(a: number) {\n' +
  '  const doubled = a * 2;\n' +
  '  const shifted = doubled + 1;\n' +
  '  const scaled = shifted * 3;\n' +
  '  const clamped = Math.min(scaled, 1000);\n' +
  '  return clamped;\n' +
  '}\n';

/** Finds nothing to elide. Distinguishable from Fast, which finds the body. */
const stub: ParserAdapter = {
  name: 'stub',
  language: 'typescript',
  symbols: () => new Set<string>(),
  check: () => ({ valid: true, issues: [], durationMs: 0 }),
  regions: () => [],
};

// The object-literal `OptimizationRequest` shape, copied from
// `test/unit/block-hash-false-positive.test.ts:25-34`, which is this repo's working pattern for
// driving `optimize()` directly. `createOptimizationRequest` takes
// (rawInput, config, options, tokenizer?) and is the adapter-facing constructor — it does not
// accept `{ bundle, budget, rawInput }`.
const request = (): OptimizationRequest => ({
  requestId: 'engine-mode-test',
  rawInput: SRC,
  bundle: createContextBundle(SRC, 'file', 'sample.ts'),
  budget: createOptimizationBudget({ targetReductionRatio: 0.3 }),
  config: loadConfig({ env: {} }),
  adapterName: 'test',
  adapterVersion: TOKENDAMPER_VERSION,
});

afterEach(() => clearParserBackends());

describe('engineMode', () => {
  it('defaults to fast and reports it on the trace', () => {
    const result = optimize(request());
    expect(result.trace.parserCoverage?.mode).toBe('fast');
    expect(result.trace.parserCoverage?.backendAnswered).toBe(0);
  });

  it('reports a registered backend as having answered in deep mode', () => {
    registerParserBackend(stub);
    const result = optimize(request(), { engineMode: 'deep' });
    expect(result.trace.parserCoverage?.mode).toBe('deep');
    expect(result.trace.parserCoverage?.backendAnswered).toBe(1);
  });

  it('uses the backend spans rather than silently falling back to Fast spans', () => {
    registerParserBackend(stub);
    expect(optimize(request(), { engineMode: 'deep' }).emittedOutput).toBe(SRC);
    expect(optimize(request()).emittedOutput).not.toBe(SRC);
  });
});

// Regression for Fix round 1: at the `inputNotRepresentable` trace-assembly site (engine
// `optimize()`, the block that forces `shouldFallback: true` when an adapter has flagged the
// input as not representable as UTF-8), `parserCoverage` used to be recomputed fresh over
// `request.bundle` — the *pre-pruning* item set — instead of carried forward from the
// `ValidationReport` the run already produced, the way `astCoverage` is. That counted items the
// planner had already dropped as though a validator (Fast or, worse, a registered Deep backend)
// had examined them, when nothing ever did: `parserCoverage`'s own reason for existing is telling
// apart "we looked and found none" from "nothing looked," and the old code collapsed exactly that
// distinction at this one site.
//
// A two-item bundle where a tight `maxInputTokens` forces the knapsack to prune one item
// reproduces it: `itemA` is large enough to consume the whole 1,024-token cache-prefix-pin
// horizon (`applyCacheAwarePrefixLocking`) by itself, which pins it and bypasses the knapsack for
// it (invariant 7); `itemB` is small and arrives after the horizon is already spent, so it is not
// pinned and is the one the knapsack drops to fit under `maxInputTokens: 40`. That leaves
// `currentBundle` — what `validate()` actually examines — with 1 item, while `request.bundle`
// still has 2.
describe('parserCoverage at the inputNotRepresentable trace site (Fix round 1)', () => {
  const itemA = createContextItem({
    id: 'prune-item-a',
    kind: 'file',
    content: 'export const alpha = "a value that takes up a bit of room in the bundle here";\n'.repeat(150),
    path: '/tmp/prune-a.ts',
    language: 'typescript',
  });

  const itemB = createContextItem({
    id: 'prune-item-b',
    kind: 'file',
    content: 'export const beta = 1;\n',
    path: '/tmp/prune-b.ts',
    language: 'typescript',
  });

  const pruningRequest = (): OptimizationRequest => ({
    requestId: 'engine-mode-prune-test',
    rawInput: 'not used: inputNotRepresentable forces the fallback before rawInput matters here',
    bundle: createBundleFromItems([itemA, itemB]),
    budget: createOptimizationBudget({ maxInputTokens: 40 }),
    config: loadConfig({ env: {} }),
    adapterName: 'test',
    adapterVersion: TOKENDAMPER_VERSION,
  });

  it('agrees with astCoverage on the surviving-item count, in fast mode', () => {
    const result = optimize(pruningRequest(), { inputNotRepresentable: 'forced for this test' });

    // Meaningful only if pruning actually happened — otherwise this would pass on a run where
    // nothing was dropped, which proves nothing about the site.
    const pruner = result.trace.stageTraces.find((s) => s.stageId === 'pruning:topology-pruner');
    expect(pruner?.metrics.itemsPruned).toBe(1);

    // `astCoverage` is computed from `currentBundle` (the post-pruning, 1-item bundle) and is
    // the trusted reference: it already existed before this task and nothing here changed how
    // it is populated at this site.
    expect(result.trace.astCoverage).toEqual({ checked: 1, unchecked: 0, uncheckedContentTypes: [] });

    // If site C reverts to `parserCoverage(request.bundle, ...)`, this bundle has 2 items, so
    // `fastAnswered` would read 2 here instead of 1 — a silent disagreement with `astCoverage`'s
    // total of 1, with nothing on the trace flagging it. Asserting the exact shape, not just
    // that the two totals match, so that failure is unambiguous about which side moved.
    expect(result.trace.parserCoverage).toEqual({
      mode: 'fast',
      registeredLanguages: [],
      backendAnswered: 0,
      fastAnswered: 1,
    });
  });

  it('does not claim a Deep backend answered for the item the planner pruned', () => {
    registerParserBackend(stub);
    const result = optimize(pruningRequest(), { inputNotRepresentable: 'forced for this test', engineMode: 'deep' });

    const pruner = result.trace.stageTraces.find((s) => s.stageId === 'pruning:topology-pruner');
    expect(pruner?.metrics.itemsPruned).toBe(1);
    expect(result.trace.astCoverage).toEqual({ checked: 1, unchecked: 0, uncheckedContentTypes: [] });

    // The sharper failure mode the reviewer named: recomputing over `request.bundle` in deep
    // mode does not just miscount, it claims the registered stub examined `itemB` — an item
    // that was pruned before the first `validate()` call and that no backend, Fast or Deep,
    // ever received. `backendAnswered` must reflect only the 1 item `currentBundle` actually
    // held, not the 2 items the pre-pruning bundle started with.
    expect(result.trace.parserCoverage).toEqual({
      mode: 'deep',
      registeredLanguages: ['typescript'],
      backendAnswered: 1,
      fastAnswered: 0,
    });
  });
});
