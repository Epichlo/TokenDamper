import { optimize } from '../core/engine';
import { TOKENDAMPER_VERSION } from '../version';
import { BenchmarkEvaluator } from './evaluator';
import { fixtureToOptimizationRequest } from './fixtures/loader';
import type { BenchmarkFixtureSet } from './fixtures/types';
import type {
  BenchmarkMetricSummary,
  BenchmarkReport,
  BenchmarkRunnerConfig,
  FixtureRunResult,
  SweepResult,
} from './types';

export class BenchmarkRunner {
  /**
   * Executes deterministic offline benchmark sweeps across fixtures and generates a BenchmarkReport.
   */
  public static run(
    fixtureSet: BenchmarkFixtureSet,
    config: BenchmarkRunnerConfig,
  ): BenchmarkReport {
    if (!fixtureSet || !Array.isArray(fixtureSet.fixtures)) {
      throw new Error('Invalid fixture set provided to BenchmarkRunner.run()');
    }

    if (!config || !Array.isArray(config.sweeps) || config.sweeps.length === 0) {
      throw new Error('BenchmarkRunner.run() requires at least one sweep configuration in config.sweeps');
    }

    const runsPerFixture = config.runsPerFixture && config.runsPerFixture > 0 ? config.runsPerFixture : 1;
    const evaluateQuality = config.evaluateQuality !== false;

    const sweepResults: SweepResult[] = [];
    const allRunResults: FixtureRunResult[] = [];

    for (const sweep of config.sweeps) {
      const itemResults: FixtureRunResult[] = [];

      for (const fixture of fixtureSet.fixtures) {
        for (let runIdx = 0; runIdx < runsPerFixture; runIdx++) {
          const reqId = `bench-${sweep.sweepId}-${fixture.id.replace(/[^a-zA-Z0-9_-]/g, '_')}-r${runIdx}`;
          const request = fixtureToOptimizationRequest(fixture, sweep.budget, config.baseConfig, reqId);

          const startTime = performance.now();
          const result = optimize(request);
          const endTime = performance.now();

          const durationMs = Math.max(0, endTime - startTime);
          const inputTokens = request.bundle.summary.tokenEstimate;
          const outputTokens = result.finalBundle.summary.tokenEstimate;
          const tokenReductionRatio = inputTokens > 0 ? Math.max(0, (inputTokens - outputTokens) / inputTokens) : 0;

          const qualityResult = evaluateQuality
            ? BenchmarkEvaluator.evaluateFixture(fixture, result)
            : undefined;

          const runResult: FixtureRunResult = Object.freeze({
            fixtureId: fixture.id,
            sweepId: sweep.sweepId,
            inputTokens,
            outputTokens,
            tokenReductionRatio,
            fallbackUsed: result.fallbackUsed,
            ...(result.trace.fallbackReason ? { fallbackReason: result.trace.fallbackReason } : {}),
            latencyMs: durationMs,
            validationPassed: result.validation.passed,
            validationIssues: Object.freeze([...result.validation.issues]),
            ...(qualityResult ? { qualityResult } : {}),
          });

          itemResults.push(runResult);
          allRunResults.push(runResult);
        }
      }

      const sweepSummary = computeMetricSummary(fixtureSet.count, itemResults);
      sweepResults.push(
        Object.freeze({
          sweepId: sweep.sweepId,
          budget: sweep.budget,
          summary: sweepSummary,
          itemResults: Object.freeze(itemResults),
        }),
      );
    }

    const overallSummary = computeMetricSummary(fixtureSet.count, allRunResults);

    return Object.freeze({
      timestamp: new Date().toISOString(),
      datasetName: fixtureSet.datasetName,
      totalFixtures: fixtureSet.count,
      overallSummary,
      sweepResults: Object.freeze(sweepResults),
      environment: Object.freeze({
        nodeVersion: process.version,
        platform: process.platform,
        tokendamperVersion: config.baseConfig.appVersion || TOKENDAMPER_VERSION,
      }),
    });
  }
}

/**
 * Computes aggregated metric summary statistics over a list of fixture run results.
 */
export function computeMetricSummary(
  totalFixtures: number,
  runResults: ReadonlyArray<FixtureRunResult>,
): BenchmarkMetricSummary {
  const totalRuns = runResults.length;
  if (totalRuns === 0) {
    return Object.freeze({
      totalFixtures,
      totalRuns: 0,
      avgReductionRatio: 0,
      fallbackRate: 0,
      avgLatencyMs: 0,
      p95LatencyMs: 0,
      syntaxPassRate: 0,
      passAt1Rate: 0,
      totalValidationIssues: 0,
    });
  }

  let sumReduction = 0;
  let fallbackCount = 0;
  let sumLatency = 0;
  let syntaxPassedCount = 0;
  let passAt1Count = 0;
  let totalValidationIssues = 0;

  const latencies: number[] = [];

  for (const item of runResults) {
    sumReduction += item.tokenReductionRatio;
    if (item.fallbackUsed) {
      fallbackCount++;
    }
    sumLatency += item.latencyMs;
    latencies.push(item.latencyMs);

    const isValid = item.qualityResult ? item.qualityResult.optimizedSyntaxValid : item.validationPassed;
    if (isValid) {
      syntaxPassedCount++;
    }

    const passAt1 = item.qualityResult ? item.qualityResult.overallPassed : item.validationPassed;
    if (passAt1) {
      passAt1Count++;
    }

    totalValidationIssues += item.validationIssues.length;
  }

  latencies.sort((a, b) => a - b);
  const p95Idx = Math.min(totalRuns - 1, Math.floor(0.95 * totalRuns));
  const p95LatencyMs = latencies[p95Idx] ?? 0;


  return Object.freeze({
    totalFixtures,
    totalRuns,
    avgReductionRatio: sumReduction / totalRuns,
    fallbackRate: fallbackCount / totalRuns,
    avgLatencyMs: sumLatency / totalRuns,
    p95LatencyMs,
    syntaxPassRate: syntaxPassedCount / totalRuns,
    passAt1Rate: passAt1Count / totalRuns,
    totalValidationIssues,
  });
}
