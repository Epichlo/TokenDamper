import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { loadBenchmarkFixtures } from '../../src/bench/fixtures';
import { BenchmarkRunner } from '../../src/bench/runner';
import type { BenchmarkReport, BenchmarkRunnerConfig } from '../../src/bench/types';
import { runCli } from '../../src/cli/main';
import { loadConfig } from '../../src/config';
import { createOptimizationBudget } from '../../src/core/model/constructors';

interface ObservedMetrics {
  readonly avgReductionRatio: number;
  readonly fallbackRate: number;
}

interface BaselineConfig {
  readonly version: string;
  readonly dataset: string;
  readonly measured: {
    readonly at: string;
    readonly commit: string;
    readonly fixtureCount: number;
  };
  readonly thresholds: {
    readonly minTokenReductionRatio: number;
    readonly maxFallbackRate: number;
    readonly maxAvgLatencyMs: number;
    readonly minSyntaxPassRate: number;
  };
  /**
   * The exact behaviour of the shipped fixture set, asserted for **equality**.
   *
   * A `>=` assertion against a measured floor of 0.0 is vacuously true and can never fail —
   * which is the defect this block exists to close, not a style preference. Equality means an
   * improvement trips the suite too, and whoever improves it records the new number here on
   * purpose. That is what makes this a ratchet rather than a rubber stamp.
   */
  readonly observed: {
    readonly combined: ObservedMetrics & {
      readonly syntaxPassRate: number;
      readonly passAt1Rate: number;
    };
    readonly combinedTightBudget: ObservedMetrics;
    readonly humanevalOnly: ObservedMetrics;
    readonly codexglueOnly: ObservedMetrics;
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
    expect(baseline.version).toBe('1.1.0');
    expect(baseline.dataset).toBe('combined_humaneval_codexglue');
    expect(baseline.thresholds).toBeDefined();

    // The shipped set, which is what `tokendamper bench` runs and what `baseline.dataset`
    // has always claimed. Until 2026-08-09 every test in this file loaded `'humaneval'`
    // instead — half the fixtures, and the half that never falls back.
    const fixtures = loadBenchmarkFixtures();
    expect(fixtures.count).toBeGreaterThan(0);
    expect(fixtures.count).toBe(baseline.measured.fixtureCount);

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
    expect(report.datasetName).toBe('combined');
    expect(report.totalFixtures).toBe(fixtures.count);
    expect(report.overallSummary).toBeDefined();
    expect(report.sweepResults.length).toBe(1);
    expect(report.environment.tokendamperVersion).toBeDefined();
  });

  // This test used to construct a private two-fixture set inline and assert 40% against it.
  //
  // It measured 58.8% and passed for four months, while the set the product actually ships —
  // and that `baseline.dataset` names — reduces **0.00%** under the identical budget, with a
  // 90% fallback rate. The 40% was real; it was just a property of two hand-written Python
  // functions under an artificially tiny `maxInputTokens: 50`, not of TokenDamper. A
  // regression test whose corpus the product does not ship cannot regress when the product
  // does. See max_audit.md H3, and CLAUDE.md invariant 10 — this is that invariant applied to
  // the guardrail rather than to the engine.
  //
  // The inline fixtures are deleted rather than kept alongside: they were the reason nobody
  // looked at the shipped numbers. What they demonstrated (sub-item body elision produces real
  // reduction on small Python under a tight budget) is covered by `test/unit/bench/*` and by
  // the region-elision suites, which is where a unit-scale claim belongs.
  it('Test 2: Pin aggregate token reduction on the SHIPPED fixture set (measured, not aspirational)', () => {
    const fixtures = loadBenchmarkFixtures();

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

    const report = BenchmarkRunner.run(fixtures, runnerConfig);

    // Equality, not `>=`. The measured floor is 0.0, so `>=` could never fail — it would be a
    // green light wired to nothing, which is the exact pattern being fixed here. When someone
    // closes C1/H6 and this number moves, this test is *supposed* to break so the new baseline
    // gets recorded deliberately in `baseline.json`.
    expect(report.overallSummary.avgReductionRatio).toBeCloseTo(
      baseline.observed.combinedTightBudget.avgReductionRatio,
      4,
    );
    expect(report.overallSummary.fallbackRate).toBeCloseTo(
      baseline.observed.combinedTightBudget.fallbackRate,
      4,
    );

    // The floor CI enforces, kept as a separate statement so the gap between what the product
    // does (`thresholds`) and what it is meant to do (`aspirational`) stays legible.
    expect(report.overallSummary.avgReductionRatio).toBeGreaterThanOrEqual(
      baseline.thresholds.minTokenReductionRatio,
    );
  });

  it('Test 3: Pin fallback rate on the SHIPPED fixture set, and keep the humaneval finding scoped', () => {
    const baseConfig = loadConfig();
    const sweepBudget = createOptimizationBudget({
      targetReductionRatio: baseline.expectedMetrics.targetReductionRatio,
      riskTolerance: 'low',
    });
    const runnerConfig: BenchmarkRunnerConfig = {
      baseConfig,
      sweeps: [{ sweepId: 'fallback-sweep', budget: sweepBudget }],
    };

    // The historical finding, preserved and now explicitly scoped to the subset it was true of.
    //
    // `aba84df` inverted this assertion to expect a 100% fallback rate, attributing that to
    // Issue 3 (the drift threshold being wrong for code). That attribution was incorrect: the
    // fallbacks came from `BenchmarkRunner` calling `optimize(request)` with no options, so no
    // `TokenHasher` reached the engine and `attemptAutomatedRehydration` returned immediately
    // on `if (!hasher && !ledger)` — the recovery path never ran. With the hasher supplied, the
    // engine rehydrates the placeholder, re-validates, and passes on every humaneval fixture.
    // That remains true and is still asserted below. See docs/phase-1d-drift-investigation.md §10. [retired]
    //
    // What was wrong was not the assertion but its **scope**. `maxFallbackRate: 0` was read as
    // a statement about the product; it was only ever a statement about humaneval, which is
    // half the shipped set and the half that cannot fall back. codexglue sits at 0.80 and was
    // never run here. Note also what the humaneval pass costs: zero fallbacks *and* zero
    // reduction, because rehydration restores what elision removed. A 0% fallback rate is not
    // evidence of success when the successful path is a round trip. (max_audit.md H3.)
    const humanevalReport = BenchmarkRunner.run(loadBenchmarkFixtures('humaneval'), runnerConfig);
    const humanevalFallbacks = humanevalReport.sweepResults[0]!.itemResults.filter(
      (item) => item.fallbackUsed,
    );
    expect(humanevalFallbacks.length).toBe(0);
    expect(humanevalReport.overallSummary.fallbackRate).toBeCloseTo(
      baseline.observed.humanevalOnly.fallbackRate,
      4,
    );
    expect(humanevalReport.overallSummary.avgReductionRatio).toBeCloseTo(
      baseline.observed.humanevalOnly.avgReductionRatio,
      4,
    );

    // codexglue, run here for the first time. This is the half that was hiding the 40%.
    const codexglueReport = BenchmarkRunner.run(loadBenchmarkFixtures('codexglue'), runnerConfig);
    expect(codexglueReport.overallSummary.fallbackRate).toBeCloseTo(
      baseline.observed.codexglueOnly.fallbackRate,
      4,
    );

    // The shipped set — what `tokendamper bench` prints and what CI now enforces.
    const report = BenchmarkRunner.run(loadBenchmarkFixtures(), runnerConfig);
    expect(report.overallSummary.fallbackRate).toBeCloseTo(
      baseline.observed.combined.fallbackRate,
      4,
    );
    expect(report.overallSummary.fallbackRate).toBeLessThanOrEqual(
      baseline.thresholds.maxFallbackRate,
    );
  });

  it('Test 4: Assert average execution latency <= baseline.thresholds.maxAvgLatencyMs (< 50ms)', () => {
    const fixtures = loadBenchmarkFixtures();
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

  it('Test 5: Assert aggregate AST syntax pass rate, and pin what that 100% does NOT mean', () => {
    const fixtures = loadBenchmarkFixtures();
    const baseConfig = loadConfig();
    const runnerConfig: BenchmarkRunnerConfig = {
      baseConfig,
      sweeps: [
        {
          sweepId: 'syntax-sweep',
          budget: baseConfig.budget,
        },
      ],
      // Asked for by name, because this test asserts on the *execution*-derived pass rate.
      // The runner defaults it off since audit OX-M15 — without this line the assertion below
      // reads 0.6, the validation-derived figure, and would be pinning a different quantity
      // under the same name.
      evaluateQuality: true,
    };

    const report = BenchmarkRunner.run(fixtures, runnerConfig);

    expect(report.overallSummary.syntaxPassRate).toBeGreaterThanOrEqual(
      baseline.thresholds.minSyntaxPassRate,
    );
    expect(report.overallSummary.syntaxPassRate).toBe(1.0);
    expect(report.overallSummary.passAt1Rate).toBeGreaterThanOrEqual(
      baseline.thresholds.minSyntaxPassRate,
    );

    // `syntaxPassRate: 1.0` is not evidence that the pipeline preserved syntax.
    //
    // Syntax is evaluated on the emitted output, and on fallback the emitted output *is* the
    // input — so this metric reads 1.0 whenever the engine does nothing, which is precisely
    // when it is least informative. Asserting the two together is the point: a reader who sees
    // 100% here should also see the 40% fallback rate sitting next to it. If a future change
    // makes syntax meaningful (by driving the fallback rate down), this pairing breaks and
    // forces the claim to be restated rather than silently inherited. max_audit.md H3, §3.3.
    expect(report.overallSummary.fallbackRate).toBeCloseTo(
      baseline.observed.combined.fallbackRate,
      4,
    );
    expect(report.overallSummary.avgReductionRatio).toBeCloseTo(
      baseline.observed.combined.avgReductionRatio,
      4,
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

    // `--evaluate-quality` for the same reason as Test 5: the thresholds below are
    // execution-derived, and plain `bench` no longer executes fixture code (audit OX-M15).
    const exitCode = runCli(
      ['bench', 'test/fixtures/bench', '--report-json', tempReportPath, '--evaluate-quality'],
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

