import { describe, expect, it } from 'vitest';
import { optimize } from '../../src/core/engine';
import { executeBuiltInStage, getBuiltInStageCatalog } from '../../src/core/stage-registry';
import { TokenHasher } from '../../src/core/hashing/token-hasher';
import {
  DEFAULT_TOKENIZER,
  estimateBundleTokens,
  estimateTokens,
  type TokenizerAdapter,
} from '../../src/core/hashing/tokenizer';
import { createBundleFromItems, createContextItem, createOptimizationBudget } from '../../src/core/model/constructors';
import { loadConfig } from '../../src/config/load';
import { fixtureToOptimizationRequest, loadBenchmarkFixtures } from '../../src/bench/fixtures/loader';

/**
 * Regression guard for the estimator-mismatch class of bug.
 *
 * Two independent token estimators once coexisted — `EnhancedHeuristicTokenizer` on the
 * input side of a bundle and an inline `ceil(len / 4)` on every output side. A reduction
 * ratio computed across that seam reported an 11-22% saving on output that was
 * byte-identical to its input, and the benchmark published it as `avgReduction: 7.82%`.
 *
 * The property that makes such a figure impossible is simple and worth pinning directly:
 * identical bytes must measure identically. Every test below is a way of asserting that
 * on a path a user's numbers actually come from.
 */
describe('token estimator unity', () => {
  const config = loadConfig();
  const budget = createOptimizationBudget({ riskTolerance: 'low', preserveKinds: [], targetReductionRatio: 0.3 });

  describe('the seam', () => {
    it('measures a single item exactly as it measures its text', () => {
      const text = 'export function widget(a: number): number {\n  return a * 2;\n}\n';
      expect(estimateBundleTokens([{ content: text }])).toBe(estimateTokens(text));
    });

    it('measures a bundle as the newline-joined render of its items', () => {
      const items = [{ content: 'alpha beta' }, { content: 'gamma delta' }, { content: 'epsilon' }];
      const joined = items.map((i) => i.content).join('\n');

      // The separators are part of the measurement. Summing item lengths instead — which
      // is what the Gateway did via `statistics.totalCharacters` — omits the N-1 newlines
      // and gives a different answer for the same bundle.
      expect(estimateBundleTokens(items)).toBe(estimateTokens(joined));
    });

    it('returns 0 for empty text and at least 1 for any non-empty text', () => {
      expect(estimateTokens('')).toBe(0);
      expect(estimateBundleTokens([])).toBe(0);
      expect(estimateTokens('x')).toBeGreaterThanOrEqual(1);
    });

    it('is the single injection point a replacement tokenizer plugs into', () => {
      // A pluggable TokenizerAdapter (e.g. the tiktoken adapter the roadmap schedules)
      // must be able to change every measurement by replacing one argument. If a second
      // estimator existed, this stub would be ignored by whichever sites hardcode theirs.
      const stub: TokenizerAdapter = { name: 'stub', isExact: true, countTokens: () => 7 };

      expect(estimateTokens('anything at all', stub)).toBe(7);
      expect(estimateBundleTokens([{ content: 'a' }, { content: 'b' }], stub)).toBe(7);
      expect(estimateTokens('anything at all', DEFAULT_TOKENIZER)).not.toBe(7);
    });
  });

  describe('every stage reports its bundle in the canonical unit', () => {
    it('agrees with estimateBundleTokens for every stage in the catalog', () => {
      const items = [
        createContextItem({
          id: 'i1',
          kind: 'file',
          contentType: 'code',
          content: 'export function alpha(value: number): number {\n  return value + 1;\n}\n',
          path: 'src/alpha.ts',
          language: 'typescript',
        }),
        createContextItem({
          id: 'i2',
          kind: 'file',
          contentType: 'code',
          content: 'export function beta(value: number): number {\n  return value * 3;\n}\n',
          path: 'src/beta.ts',
          language: 'typescript',
        }),
        createContextItem({
          id: 'i3',
          kind: 'prompt',
          contentType: 'text',
          content: 'Always preserve the public API surface.',
        }),
      ];
      const bundle = createBundleFromItems(items, 'text');
      expect(bundle.summary.tokenEstimate).toBe(estimateBundleTokens(items));

      let stagesRun = 0;
      for (const stage of getBuiltInStageCatalog()) {
        const result = executeBuiltInStage(stage.stageId, bundle, budget, undefined, {
          tokenHashingOptions: { tokenHasher: new TokenHasher() },
        });
        if (result.status === 'failed') {
          continue;
        }
        stagesRun++;

        // Whether or not the stage changed anything, the bundle it hands on must measure
        // itself the same way the rest of the pipeline will measure it.
        expect(
          result.bundle.summary.tokenEstimate,
          `${stage.stageId} reported a token estimate inconsistent with estimateBundleTokens`,
        ).toBe(estimateBundleTokens(result.bundle.items));

        // And an unchanged item set must carry the input's estimate forward untouched.
        const unchanged =
          result.bundle.items.length === bundle.items.length &&
          result.bundle.items.every((item, idx) => item.content === bundle.items[idx]?.content);
        if (unchanged) {
          expect(result.bundle.summary.tokenEstimate, `${stage.stageId} re-measured identical items differently`).toBe(
            bundle.summary.tokenEstimate,
          );
        }
      }

      // Invariant 10: confirm the check ran. A catalog that failed every stage would
      // satisfy every assertion above vacuously.
      expect(stagesRun).toBe(getBuiltInStageCatalog().length);
    });
  });

  describe('byte-identical output reports exactly 0% reduction', () => {
    it('holds on the engine path for every bench fixture that round-trips unchanged', () => {
      const fixtures = loadBenchmarkFixtures();
      expect(fixtures.fixtures.length).toBeGreaterThan(0);

      let identicalCount = 0;
      let stagesPlanned = 0;

      for (const fixture of fixtures.fixtures) {
        const request = fixtureToOptimizationRequest(
          fixture,
          budget,
          config,
          `unity-${fixture.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        );
        const result = optimize(request, { tokenHasher: new TokenHasher() });
        stagesPlanned += result.trace.stageCount;

        const emitted = result.finalBundle.items.map((i) => i.content).join('\n');
        if (emitted !== request.rawInput) {
          continue;
        }
        identicalCount++;

        const label = `${fixture.id} emitted byte-identical output`;

        // The benchmark's ratio (src/bench/runner.ts) — bundle summary against bundle summary.
        expect(result.finalBundle.summary.tokenEstimate, label).toBe(request.bundle.summary.tokenEstimate);

        // The MCP/CLI ratio (src/adapters/mcp/tools.ts) — trace before against trace after.
        // This pair spans the seam: `tokenBefore` is a bundle estimate, `tokenAfter`
        // re-measures the emitted string. It reported a saving even on pure fallbacks.
        expect(result.trace.tokenAfter, label).toBe(result.trace.tokenBefore);
        expect(result.trace.outputTokenEstimate, label).toBe(result.trace.inputTokenEstimate);
      }

      // Invariant 10 again: this test is only meaningful if the corpus produced
      // byte-identical outputs to check, and only exercises the pipeline if the planner
      // actually selected stages. With no budget the planner returns `pass_through` with
      // zero stages and every assertion above would pass without measuring anything.
      expect(identicalCount, 'no fixture produced byte-identical output — nothing was asserted').toBeGreaterThan(0);
      expect(stagesPlanned, 'the planner selected no stages — the pipeline never ran').toBeGreaterThan(0);
    });

    it('holds on the fallback path, where the emitted text is the raw input verbatim', () => {
      // Forced deterministically rather than by picking a fixture that happens to fail:
      // a `minimumConfidence` above 1.0 is unsatisfiable, so the engine falls back
      // regardless of what the corpus does. On fallback it emits `request.rawInput` and
      // returns `request.bundle`, so before and after are the same bytes by construction —
      // the ratio must be 0, not the ~9% the mismatched estimators used to report here.
      const fixtures = loadBenchmarkFixtures();
      const fixture = fixtures.fixtures[0];
      expect(fixture).toBeDefined();

      const unsatisfiable = { ...config, validation: { ...config.validation, minimumConfidence: 2 } };
      const request = fixtureToOptimizationRequest(fixture!, budget, unsatisfiable, 'unity-forced-fallback');
      const result = optimize(request, { tokenHasher: new TokenHasher() });

      expect(result.fallbackUsed, 'the fallback path was not exercised').toBe(true);
      expect(result.emittedOutput).toBe(request.rawInput);
      expect(result.trace.tokenAfter).toBe(result.trace.tokenBefore);
      expect(result.finalBundle.summary.tokenEstimate).toBe(request.bundle.summary.tokenEstimate);
    });
  });
});
