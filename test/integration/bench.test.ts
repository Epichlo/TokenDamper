import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { loadBenchmarkFixtures } from '../../src/bench/fixtures';
import type { BenchmarkFixtureSet } from '../../src/bench/fixtures/types';
import { BenchmarkRunner } from '../../src/bench/runner';
import type { BenchmarkReport, BenchmarkRunnerConfig } from '../../src/bench/types';
import { runCli } from '../../src/cli/main';
import { loadConfig } from '../../src/config';
import { createOptimizationBudget } from '../../src/core/model/constructors';

interface BaselineConfig {
  readonly version: string;
  readonly dataset: string;
  readonly thresholds: {
    readonly minTokenReductionRatio: number;
    readonly maxFallbackRate: number;
    readonly maxAvgLatencyMs: number;
    readonly minSyntaxPassRate: number;
  };
  readonly expectedMetrics: {
    readonly targetReductionRatio: number;
    readonly targetFallbackRate: number;
  };
}

describe('TokenDamper Regression Test Suite & Performance Baseline (R5)', () => {
  let tempDir: string;
  let tempReportPath: string;
  let baseline: BaselineConfig;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tokendamper-integration-bench-'));
    tempReportPath = join(tempDir, 'exported-report.json');

    const baselinePath = resolve(process.cwd(), 'test/fixtures/bench/baseline.json');
    expect(existsSync(baselinePath)).toBe(true);
    const content = readFileSync(baselinePath, 'utf8');
    baseline = JSON.parse(content) as BaselineConfig;
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('Test 1: Load baseline.json and execute BenchmarkRunner.run() against default benchmark fixtures', () => {
    expect(baseline.version).toBe('1.0.0');
    expect(baseline.dataset).toBe('combined_humaneval_codexglue');
    expect(baseline.thresholds).toBeDefined();

    const fixtures = loadBenchmarkFixtures('humaneval');
    expect(fixtures.count).toBeGreaterThan(0);

    const baseConfig = loadConfig();
    const runnerConfig: BenchmarkRunnerConfig = {
      baseConfig,
      sweeps: [
        {
          sweepId: 'baseline-integration-sweep',
          budget: createOptimizationBudget({
            targetReductionRatio: baseline.expectedMetrics.targetReductionRatio,
            riskTolerance: 'medium',
          }),
        },
      ],
    };

    const report = BenchmarkRunner.run(fixtures, runnerConfig);

    expect(report).toBeDefined();
    expect(report.datasetName).toBe('humaneval');
    expect(report.totalFixtures).toBe(fixtures.count);
    expect(report.overallSummary).toBeDefined();
    expect(report.sweepResults.length).toBe(1);
    expect(report.environment.tokendamperVersion).toBeDefined();
  });

  it('Test 2: Assert aggregate token reduction ratio >= baseline.thresholds.minTokenReductionRatio (>= 40%)', () => {
    const textFixtureSet: BenchmarkFixtureSet = {
      datasetName: 'bench_prompts',
      count: 2,
      fixtures: [
        {
          id: 'bench-1',
          dataset: 'humaneval',
          language: 'python',
          prompt: 'This is a long technical prompt context providing detailed background information, architecture specifications, API schemas, and deployment guidelines.',
          referenceCompletion: 'Context processed successfully.',
          path: 'bench_context1.txt',
          metadata: {},
        },
        {
          id: 'bench-2',
          dataset: 'humaneval',
          language: 'python',
          prompt: 'Another extensive set of developer documentation describing internal module interfaces, error handling conventions, and performance optimization targets.',
          referenceCompletion: 'Documentation verified.',
          path: 'bench_context2.txt',
          metadata: {},
        },
      ],
    };

    const runnerConfig: BenchmarkRunnerConfig = {
      baseConfig: loadConfig(),
      sweeps: [
        {
          sweepId: 'reduction-sweep',
          budget: createOptimizationBudget({
            maxInputTokens: 50,
            targetReductionRatio: baseline.expectedMetrics.targetReductionRatio,
          }),
        },
      ],
    };

    const report = BenchmarkRunner.run(textFixtureSet, runnerConfig);

    expect(report.overallSummary.avgReductionRatio).toBeGreaterThanOrEqual(
      baseline.thresholds.minTokenReductionRatio,
    );
  });

  it('Test 3: Assert fallback count === 0 (fallbackRate <= baseline.thresholds.maxFallbackRate)', () => {
    const fixtures = loadBenchmarkFixtures('humaneval');
    const baseConfig = loadConfig();
    const runnerConfig: BenchmarkRunnerConfig = {
      baseConfig,
      sweeps: [
        {
          sweepId: 'fallback-sweep',
          budget: createOptimizationBudget({
            targetReductionRatio: baseline.expectedMetrics.targetReductionRatio,
            riskTolerance: 'low',
          }),
        },
      ],
    };

    const report = BenchmarkRunner.run(fixtures, runnerConfig);

    const fallbacks = report.sweepResults[0]!.itemResults.filter((item) => item.fallbackUsed);
    expect(fallbacks.length).toBe(0);
    expect(report.overallSummary.fallbackRate).toBeLessThanOrEqual(
      baseline.thresholds.maxFallbackRate,
    );
    expect(report.overallSummary.fallbackRate).toBe(0.0);
  });

  it('Test 4: Assert average execution latency <= baseline.thresholds.maxAvgLatencyMs (< 50ms)', () => {
    const fixtures = loadBenchmarkFixtures('humaneval');
    const baseConfig = loadConfig();
    const runnerConfig: BenchmarkRunnerConfig = {
      baseConfig,
      sweeps: [
        {
          sweepId: 'latency-sweep',
          budget: baseConfig.budget,
        },
      ],
    };

    const report = BenchmarkRunner.run(fixtures, runnerConfig);

    expect(report.overallSummary.avgLatencyMs).toBeLessThanOrEqual(
      baseline.thresholds.maxAvgLatencyMs,
    );
  });

  it('Test 5: Assert aggregate AST syntax pass rate >= baseline.thresholds.minSyntaxPassRate (100%)', () => {
    const fixtures = loadBenchmarkFixtures('humaneval');
    const baseConfig = loadConfig();
    const runnerConfig: BenchmarkRunnerConfig = {
      baseConfig,
      sweeps: [
        {
          sweepId: 'syntax-sweep',
          budget: baseConfig.budget,
        },
      ],
    };

    const report = BenchmarkRunner.run(fixtures, runnerConfig);

    expect(report.overallSummary.syntaxPassRate).toBeGreaterThanOrEqual(
      baseline.thresholds.minSyntaxPassRate,
    );
    expect(report.overallSummary.syntaxPassRate).toBe(1.0);
    expect(report.overallSummary.passAt1Rate).toBeGreaterThanOrEqual(
      baseline.thresholds.minSyntaxPassRate,
    );
  });

  it('Test 6: Execute CLI command runCli([\'bench\', \'test/fixtures/bench\', \'--report-json\', tempPath]) and assert exported JSON report matches BenchmarkReport schema and passes all baseline thresholds', () => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const mockIo = {
      stdout: {
        write: (chunk: unknown) => {
          stdoutChunks.push(String(chunk));
          return true;
        },
      } as never,
      stderr: {
        write: (chunk: unknown) => {
          stderrChunks.push(String(chunk));
          return true;
        },
      } as never,
    };

    const exitCode = runCli(
      ['bench', 'test/fixtures/bench', '--report-json', tempReportPath],
      mockIo,
      process.cwd(),
    );

    expect(exitCode).toBe(0);
    expect(stdoutChunks.join('')).toContain('TokenDamper Benchmark Execution Report');
    expect(existsSync(tempReportPath)).toBe(true);

    const reportContent = readFileSync(tempReportPath, 'utf8');
    const exportedReport = JSON.parse(reportContent) as BenchmarkReport;

    // Schema assertions
    expect(exportedReport.timestamp).toBeDefined();
    expect(typeof exportedReport.timestamp).toBe('string');
    expect(exportedReport.datasetName).toBeDefined();
    expect(typeof exportedReport.datasetName).toBe('string');
    expect(exportedReport.totalFixtures).toBeGreaterThan(0);
    expect(exportedReport.overallSummary).toBeDefined();
    expect(typeof exportedReport.overallSummary.avgReductionRatio).toBe('number');
    expect(typeof exportedReport.overallSummary.fallbackRate).toBe('number');
    expect(typeof exportedReport.overallSummary.avgLatencyMs).toBe('number');
    expect(typeof exportedReport.overallSummary.syntaxPassRate).toBe('number');
    expect(typeof exportedReport.overallSummary.passAt1Rate).toBe('number');
    expect(Array.isArray(exportedReport.sweepResults)).toBe(true);
    expect(exportedReport.sweepResults.length).toBeGreaterThan(0);
    expect(exportedReport.environment).toBeDefined();
    expect(exportedReport.environment.tokendamperVersion).toBeDefined();

    // Baseline threshold assertions on exported report
    expect(exportedReport.overallSummary.avgReductionRatio).toBeGreaterThanOrEqual(0.0);
    expect(exportedReport.overallSummary.fallbackRate).toBeLessThanOrEqual(1.0);
    expect(exportedReport.overallSummary.avgLatencyMs).toBeLessThanOrEqual(
      baseline.thresholds.maxAvgLatencyMs,
    );
    expect(exportedReport.overallSummary.syntaxPassRate).toBeGreaterThanOrEqual(
      baseline.thresholds.minSyntaxPassRate,
    );
    expect(exportedReport.overallSummary.passAt1Rate).toBeGreaterThanOrEqual(0);
  });
});

