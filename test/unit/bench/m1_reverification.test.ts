import { describe, expect, it } from 'vitest';
import { loadBenchmarkFixtures, fixtureToOptimizationRequest } from '../../../src/bench/fixtures/loader';
import { BenchmarkRunner } from '../../../src/bench/runner';
import { computeKeySymbolPreservation } from '../../../src/bench/evaluator';
import { createOptimizationBudget } from '../../../src/core/model/constructors';
import type { BenchmarkRunnerConfig } from '../../../src/bench/types';
import type { ResolvedConfig } from '../../../src/core/model/types';

describe('M1 Challenger Re-verification Suite', () => {
  const humanevalFixtures = loadBenchmarkFixtures('humaneval');

  describe('Requirement 1: Partial baseConfig handling', () => {
    it('handles partial baseConfig with budget.maxInputTokens without throwing or fallbacks', () => {
      const runnerConfig: BenchmarkRunnerConfig = {
        baseConfig: { budget: { maxInputTokens: 500 } } as unknown as ResolvedConfig,
        sweeps: [
          {
            sweepId: 'sweep-partial-budget',
            budget: createOptimizationBudget({ targetReductionRatio: 0.1, riskTolerance: 'low' }),
          },
        ],
      };

      const report = BenchmarkRunner.run(humanevalFixtures, runnerConfig);
      expect(report.sweepResults.length).toBe(1);
      const sweep = report.sweepResults[0]!;
      expect(sweep.summary.totalRuns).toBe(humanevalFixtures.count);
      // Restored to 0, which is what the test name asserts. `aba84df` inverted this to
      // 1 and blamed Issue 3 (the drift threshold). The real cause was BenchmarkRunner
      // calling optimize() with no TokenHasher, which left the engine's rehydration
      // recovery path switched off. See docs/phase-1d-drift-investigation.md §10.
      expect(sweep.summary.fallbackRate).toBe(0);
    });

    it('handles partial baseConfig with validation object only', () => {
      const runnerConfig: BenchmarkRunnerConfig = {
        baseConfig: { validation: { minimumConfidence: 0.8 } } as unknown as ResolvedConfig,
        sweeps: [
          {
            sweepId: 'sweep-partial-validation',
            budget: createOptimizationBudget({ targetReductionRatio: 0.1, riskTolerance: 'low' }),
          },
        ],
      };

      const report = BenchmarkRunner.run(humanevalFixtures, runnerConfig);
      const sweep = report.sweepResults[0]!;
      // See comment above: restored to 0, the recovery valve is now enabled.
      expect(sweep.summary.fallbackRate).toBe(0);
    });

    it('handles empty baseConfig object {}', () => {
      const runnerConfig: BenchmarkRunnerConfig = {
        baseConfig: {} as unknown as ResolvedConfig,
        sweeps: [
          {
            sweepId: 'sweep-empty-config',
            budget: createOptimizationBudget({ targetReductionRatio: 0.1, riskTolerance: 'low' }),
          },
        ],
      };

      const report = BenchmarkRunner.run(humanevalFixtures, runnerConfig);
      const sweep = report.sweepResults[0]!;
      expect(sweep.summary.totalRuns).toBe(humanevalFixtures.count);
      // See comment above: restored to 0, the recovery valve is now enabled.
      expect(sweep.summary.fallbackRate).toBe(0);
    });

    it('ensures fixtureToOptimizationRequest merges defaults for missing top-level fields', () => {
      const fixture = humanevalFixtures.fixtures[0]!;
      const budget = createOptimizationBudget({ riskTolerance: 'low' });

      const request = fixtureToOptimizationRequest(fixture, budget, { budget: { maxInputTokens: 300 } } as unknown as ResolvedConfig);

      expect(request.config).toBeDefined();
      expect(request.config.appName).toBe('TokenDamper');
      expect(request.config.planner).toBeDefined();
      expect(request.config.planner.defaultMode).toBe('pass_through');
      expect(request.config.validation).toBeDefined();
      expect(request.config.validation.minimumConfidence).toBe(1);
      expect(request.config.logging).toBeDefined();
      expect(request.config.logging.level).toBe('info');
    });
  });

  describe('Requirement 2: Symbol preservation word boundary logic', () => {
    it('avoids false positives when identifier is a prefix (e.g. user vs username_val)', () => {
      const ratio = computeKeySymbolPreservation('user', 'def process(username_val):', 'python');
      expect(ratio).toBe(0);
    });

    it('avoids false positives when identifier is a suffix (e.g. val vs username_val)', () => {
      const ratio = computeKeySymbolPreservation('val', 'def process(username_val):', 'python');
      expect(ratio).toBe(0);
    });

    it('avoids false positives when identifier has underscore continuation (e.g. user vs user_name)', () => {
      const ratio = computeKeySymbolPreservation('user', 'def process(user_name):', 'python');
      expect(ratio).toBe(0);
    });

    it('avoids false positives when identifier has numeric suffix (e.g. item vs item1)', () => {
      const ratio = computeKeySymbolPreservation('item', 'def process(item1):', 'python');
      expect(ratio).toBe(0);
    });

    it('correctly matches exact identifier bounded by non-word characters', () => {
      const ratio = computeKeySymbolPreservation('user', 'def process(user):', 'python');
      expect(ratio).toBe(1.0);
    });

    it('correctly matches exact identifier in dot notation (e.g. user in user.name)', () => {
      const ratio = computeKeySymbolPreservation('user', 'return user.name;', 'typescript');
      expect(ratio).toBe(1.0);
    });

    it('correctly matches exact identifier enclosed in brackets/quotes', () => {
      const ratio1 = computeKeySymbolPreservation('token', 'const x = [token];', 'typescript');
      expect(ratio1).toBe(1.0);

      const ratio2 = computeKeySymbolPreservation('key', 'const obj = { key: "val" };', 'typescript');
      expect(ratio2).toBe(1.0);
    });

    it('correctly calculates partial preservation score across multiple symbols', () => {
      const prompt = 'function processData(user, account, session) {}';
      const output = 'function processData(username_val, account, session_id) {}';

      // Prompt symbols: processData, user, account, session (4 symbols)
      // Output contains: processData (match), username_val (user no match), account (match), session_id (session no match)
      // Preserved: 2 out of 4 = 0.5
      const ratio = computeKeySymbolPreservation(prompt, output, 'typescript');
      expect(ratio).toBe(0.5);
    });

    it('returns 1.0 for prompt with no key symbols (only keywords/short words)', () => {
      const ratio = computeKeySymbolPreservation('if true return for in', 'anything');
      expect(ratio).toBe(1.0);
    });
  });
});
