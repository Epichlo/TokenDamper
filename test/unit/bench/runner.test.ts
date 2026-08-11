import { describe, expect, it } from 'vitest';
import { loadBenchmarkFixtures } from '../../../src/bench/fixtures';
import { BenchmarkRunner, computeMetricSummary } from '../../../src/bench/runner';
import type { BenchmarkRunnerConfig, FixtureRunResult } from '../../../src/bench/types';
import type { ResolvedConfig } from '../../../src/core/model/types';
import { DEFAULT_CONFIG } from '../../../src/config/schema';
import { createOptimizationBudget } from '../../../src/core/model/constructors';

describe('BenchmarkRunner Harness', () => {
  const fixtureSet = loadBenchmarkFixtures('humaneval');

  const runnerConfig: BenchmarkRunnerConfig = {
    baseConfig: DEFAULT_CONFIG,
    sweeps: [
      {
        sweepId: 'sweep-low-risk',
        budget: createOptimizationBudget({
          targetReductionRatio: 0.1,
          riskTolerance: 'low',
        }),
      },
      {
        sweepId: 'sweep-medium-risk',
        budget: createOptimizationBudget({
          maxInputTokens: 50,
          targetReductionRatio: 0.5,
          riskTolerance: 'medium',
        }),
      },
    ],
  };

  describe('run()', () => {
    it('should execute offline deterministic benchmark sweeps', { timeout: 15000 }, () => {
      const report = BenchmarkRunner.run(fixtureSet, runnerConfig);

      expect(report.datasetName).toBe('humaneval');
      expect(report.totalFixtures).toBe(fixtureSet.count);
      expect(report.timestamp).toBeDefined();
      expect(report.environment.nodeVersion).toBe(process.version);
      expect(report.sweepResults.length).toBe(2);

      const sweep1 = report.sweepResults[0]!;
      expect(sweep1.sweepId).toBe('sweep-low-risk');
      expect(sweep1.itemResults.length).toBe(fixtureSet.count);
      expect(sweep1.summary.totalRuns).toBe(fixtureSet.count);
      expect(sweep1.summary.avgReductionRatio).toBeGreaterThanOrEqual(0);
      expect(sweep1.summary.fallbackRate).toBeGreaterThanOrEqual(0);
      expect(sweep1.summary.avgLatencyMs).toBeGreaterThanOrEqual(0);
      expect(sweep1.summary.syntaxPassRate).toBeGreaterThanOrEqual(0);

      const sweep2 = report.sweepResults[1]!;
      expect(sweep2.sweepId).toBe('sweep-medium-risk');
      expect(sweep2.itemResults.length).toBe(fixtureSet.count);
    });

    it('should respect evaluateQuality: false', () => {
      const configNoQuality: BenchmarkRunnerConfig = {
        ...runnerConfig,
        evaluateQuality: false,
      };

      const report = BenchmarkRunner.run(fixtureSet, configNoQuality);
      const sweep = report.sweepResults[0]!;
      expect(sweep.itemResults[0]!.qualityResult).toBeUndefined();
    });

    it('should execute multiple runsPerFixture when configured', () => {
      const multiRunConfig: BenchmarkRunnerConfig = {
        ...runnerConfig,
        runsPerFixture: 2,
      };

      const report = BenchmarkRunner.run(fixtureSet, multiRunConfig);
      const sweep = report.sweepResults[0]!;
      expect(sweep.itemResults.length).toBe(fixtureSet.count * 2);
      expect(sweep.summary.totalRuns).toBe(fixtureSet.count * 2);
    }, 15000);

    it('should throw an error for invalid fixture set', () => {
      // @ts-expect-error Testing invalid input
      expect(() => BenchmarkRunner.run(null, runnerConfig)).toThrow();
    });

    it('should throw an error for empty sweeps array', () => {
      const emptyConfig: BenchmarkRunnerConfig = {
        baseConfig: DEFAULT_CONFIG,
        sweeps: [],
      };
      expect(() => BenchmarkRunner.run(fixtureSet, emptyConfig)).toThrow();
    });

    it('should execute without throwing or falling back when passed a partial baseConfig', () => {
      const partialRunnerConfig = {
        baseConfig: { budget: { maxInputTokens: 500 } } as unknown as ResolvedConfig,
        sweeps: [
          {
            sweepId: 'sweep-partial-config',
            budget: createOptimizationBudget({
              targetReductionRatio: 0.1,
              riskTolerance: 'low',
            }),
          },
        ],
      };

      const report = BenchmarkRunner.run(fixtureSet, partialRunnerConfig);
      expect(report.sweepResults.length).toBe(1);

      const sweep = report.sweepResults[0]!;
      expect(sweep.summary.totalRuns).toBe(fixtureSet.count);
      // Restored to 0, which is what the test name asserts. `aba84df` inverted this to 1
      // and blamed the drift threshold; the real cause was the engine's rehydration
      // recovery path being switched off by BenchmarkRunner passing no TokenHasher.
      // See docs/phase-1d-drift-investigation.md §10. [retired]
      expect(sweep.summary.fallbackRate).toBe(0);
    });
  });

  describe('computeMetricSummary', () => {
    it('should correctly calculate summary metrics', () => {
      const sampleRuns: FixtureRunResult[] = [
        {
          fixtureId: 'f1',
          sweepId: 's1',
          inputTokens: 100,
          outputTokens: 60,
          tokenReductionRatio: 0.4,
          fallbackUsed: false,
          latencyMs: 10,
          validationPassed: true,
          validationIssues: [],
          qualityResult: {
            fixtureId: 'f1',
            rawSyntaxValid: true,
            optimizedSyntaxValid: true,
            syntaxPreserved: true,
            rawAstIssues: [],
            optimizedAstIssues: [],
            keySymbolPreservationRatio: 1.0,
            tokenSimilarityScore: 0.8,
            rawExecutionPassed: true,
            optimizedExecutionPassed: true,
            executionPassed: true,
            executionMode: 'python-subprocess',
            executionNote: 'Python subprocess check completed.',
            overallPassed: true,
          },
        },
        {
          fixtureId: 'f2',
          sweepId: 's1',
          inputTokens: 100,
          outputTokens: 100,
          tokenReductionRatio: 0.0,
          fallbackUsed: true,
          fallbackReason: 'validation_failed',
          latencyMs: 30,
          validationPassed: false,
          validationIssues: [{ code: 'TEST_ERR', message: 'Test error', severity: 'error' }],
          qualityResult: {
            fixtureId: 'f2',
            rawSyntaxValid: true,
            optimizedSyntaxValid: false,
            syntaxPreserved: false,
            rawAstIssues: [],
            optimizedAstIssues: [{ code: 'SYNTAX_ERR', message: 'Syntax error' }],
            keySymbolPreservationRatio: 0.5,
            tokenSimilarityScore: 0.5,
            rawExecutionPassed: true,
            optimizedExecutionPassed: false,
            executionPassed: false,
            executionMode: 'python-subprocess',
            executionNote: 'Python subprocess check failed.',
            overallPassed: false,
          },
        },
      ];

      const summary = computeMetricSummary(2, sampleRuns);
      expect(summary.totalFixtures).toBe(2);
      expect(summary.totalRuns).toBe(2);
      expect(summary.avgReductionRatio).toBe(0.2); // (0.4 + 0.0) / 2
      expect(summary.fallbackRate).toBe(0.5); // 1 out of 2
      expect(summary.avgLatencyMs).toBe(20); // (10 + 30) / 2
      expect(summary.p95LatencyMs).toBe(30);
      expect(summary.syntaxPassRate).toBe(0.5); // 1 out of 2 valid
      expect(summary.passAt1Rate).toBe(0.5); // 1 out of 2 passes
      expect(summary.totalValidationIssues).toBe(1);
    });

    it('should handle zero runs gracefully', () => {
      const summary = computeMetricSummary(5, []);
      expect(summary.totalFixtures).toBe(5);
      expect(summary.totalRuns).toBe(0);
      expect(summary.avgReductionRatio).toBe(0);
      expect(summary.fallbackRate).toBe(0);
      expect(summary.avgLatencyMs).toBe(0);
      expect(summary.p95LatencyMs).toBe(0);
      expect(summary.syntaxPassRate).toBe(0);
      expect(summary.passAt1Rate).toBe(0);
      expect(summary.totalValidationIssues).toBe(0);
    });
  });
});
