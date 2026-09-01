import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBenchmarkFixtures } from '../../../src/bench/fixtures';
import { BenchmarkRunner } from '../../../src/bench/runner';
import type { BenchmarkRunnerConfig, FixtureRunResult } from '../../../src/bench/types';
import { DEFAULT_CONFIG } from '../../../src/config/schema';
import { createOptimizationBudget } from '../../../src/core/model/constructors';
import { parseArguments, runCli, SUPPORTED_FLAGS } from '../../../src/cli/main';

/**
 * Audit OX-M15. `BenchmarkRunner.run` defaulted `evaluateQuality` on, and the evaluator
 * executes fixture code through `python -c` — so an "offline, deterministic" harness
 * (`ARCHITECTURE.md`, Benchmark Philosophy) reached for an interpreter on every user-invoked
 * `bench`, with an undocumented environment variable as the only way out.
 *
 * The assertion is on `qualityResult` rather than on a spawn spy because that is the honest
 * boundary: `evaluateQuality` gates the whole `BenchmarkEvaluator.evaluateFixture` call, so
 * an absent `qualityResult` means no evaluator ran and therefore no subprocess could have
 * been spawned. Spying on `spawnSync` would pin the same fact one layer lower while coupling
 * the test to which binary the evaluator happens to reach for.
 */
describe('bench quality evaluation is opt-in (audit OX-M15)', () => {
  const fixtureSet = loadBenchmarkFixtures('humaneval');

  const baseRunnerConfig: BenchmarkRunnerConfig = {
    baseConfig: DEFAULT_CONFIG,
    sweeps: [
      {
        sweepId: 'ox-m15',
        budget: createOptimizationBudget({ targetReductionRatio: 0.3, riskTolerance: 'low' }),
      },
    ],
  };

  const allRuns = (report: ReturnType<typeof BenchmarkRunner.run>): readonly FixtureRunResult[] =>
    report.sweepResults.flatMap((sweep) => [...sweep.itemResults]);

  it('does not evaluate quality when the caller says nothing', { timeout: 20000 }, () => {
    const report = BenchmarkRunner.run(fixtureSet, baseRunnerConfig);
    const runs = allRuns(report);

    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run.qualityResult).toBeUndefined();
    }
  });

  it('evaluates quality when the caller asks for it by name', { timeout: 20000 }, () => {
    const report = BenchmarkRunner.run(fixtureSet, { ...baseRunnerConfig, evaluateQuality: true });
    const runs = allRuns(report);

    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((run) => run.qualityResult !== undefined)).toBe(true);
  });

  it('still honours an explicit false', { timeout: 20000 }, () => {
    const report = BenchmarkRunner.run(fixtureSet, { ...baseRunnerConfig, evaluateQuality: false });
    expect(allRuns(report).every((run) => run.qualityResult === undefined)).toBe(true);
  });

  it('reports a syntax pass rate from validation when quality evaluation is off', { timeout: 20000 }, () => {
    // Lines 168/173 of the runner fall back to `validationPassed`, so turning evaluation off
    // must not leave the aggregate undefined or NaN — a bench report with a hole in it would
    // be a worse outcome than the subprocess.
    const report = BenchmarkRunner.run(fixtureSet, baseRunnerConfig);
    expect(Number.isFinite(report.overallSummary.syntaxPassRate)).toBe(true);
    expect(report.overallSummary.syntaxPassRate).toBeGreaterThanOrEqual(0);
    expect(report.overallSummary.syntaxPassRate).toBeLessThanOrEqual(1);
  });

  describe('the CLI surface', () => {
    it('accepts --evaluate-quality on bench and rejects it elsewhere', () => {
      expect(SUPPORTED_FLAGS.bench.has('--evaluate-quality')).toBe(true);
      expect(SUPPORTED_FLAGS.optimize.has('--evaluate-quality')).toBe(false);
      expect(SUPPORTED_FLAGS.mcp.has('--evaluate-quality')).toBe(false);

      expect(() => parseArguments(['optimize', 'x.ts', '--evaluate-quality'], process.cwd())).toThrow(
        /Unsupported for `tokendamper optimize`.*--evaluate-quality.*applies to: bench/s,
      );
    });

    it('parses --evaluate-quality into the flag the runner reads', () => {
      expect(parseArguments(['bench', '--evaluate-quality'], process.cwd()).evaluateQuality).toBe(true);
      expect(parseArguments(['bench'], process.cwd()).evaluateQuality).toBeUndefined();
    });

    it('runs plain `bench` without any python-subprocess evaluation', { timeout: 30000 }, () => {
      const dir = mkdtempSync(join(tmpdir(), 'td-ox-m15-'));
      const reportPath = join(dir, 'report.json');
      try {
        const stderrChunks: string[] = [];
        const mockIo = {
          stdout: { write: () => true } as never,
          stderr: {
            write: (chunk: unknown) => {
              stderrChunks.push(String(chunk));
              return true;
            },
          } as never,
        };

        const code = runCli(['bench', 'humaneval', '--report-json', reportPath, '--quiet'], mockIo, process.cwd());
        expect(stderrChunks.join('')).toBe('');
        expect(code).toBe(0);

        const raw = readFileSync(reportPath, 'utf8');
        expect(raw).not.toContain('python-subprocess');
        expect(JSON.parse(raw).overallSummary.syntaxPassRate).toBeTypeOf('number');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
