import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { renderBenchTable } from '../../../src/cli/bench-table-renderer';
import { runCli } from '../../../src/cli/main';
import type { BenchmarkReport } from '../../../src/bench/types';

describe('CLI Bench Subcommand & Renderer', () => {
  let tempDir: string;
  let tempReportPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tokendamper-bench-test-'));
    tempReportPath = join(tempDir, 'report.json');
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('renderBenchTable', () => {
    const mockReport: BenchmarkReport = {
      timestamp: '2026-07-26T12:00:00.000Z',
      datasetName: 'combined',
      totalFixtures: 2,
      overallSummary: {
        totalFixtures: 2,
        totalRuns: 2,
        avgReductionRatio: 0.45,
        fallbackRate: 0,
        avgLatencyMs: 5.2,
        p95LatencyMs: 8.1,
        syntaxPassRate: 1.0,
        totalValidationIssues: 0,
      },
      sweepResults: [
        {
          sweepId: 'sweep-1',
          budget: {
            maxInputTokens: 100,
            targetReductionRatio: 0.5,
            riskTolerance: 'medium',
            preserveKinds: ['prompt', 'file', 'diff'],
          },
          summary: {
            totalFixtures: 2,
            totalRuns: 2,
            avgReductionRatio: 0.45,
            fallbackRate: 0,
            avgLatencyMs: 5.2,
            p95LatencyMs: 8.1,
            syntaxPassRate: 1.0,
            totalValidationIssues: 0,
          },
          itemResults: [
            {
              fixtureId: 'f1',
              sweepId: 'sweep-1',
              inputTokens: 100,
              outputTokens: 55,
              tokenReductionRatio: 0.45,
              fallbackUsed: false,
              latencyMs: 5.2,
              validationPassed: true,
              validationIssues: [],
            },
          ],
        },
      ],
      environment: {
        nodeVersion: 'v22.0.0',
        platform: 'win32',
        tokendamperVersion: '0.1.0',
      },
    };

    it('renders plain text table when color option is false', () => {
      const output = renderBenchTable(mockReport, { color: false });
      expect(output).toContain('TokenDamper Benchmark Execution Report');
      expect(output).toContain('Dataset Name:       combined');
      expect(output).toContain('Total Fixtures:     2');
      expect(output).toContain('OVERALL METRICS SUMMARY');
      expect(output).toContain('Aggregate Token Reduction:  45.0%');
      expect(output).toContain('PER-SWEEP BREAKDOWN');
      expect(output).toContain('100');
      expect(output).toContain('50%');
      expect(output).toContain('medium');
      expect(output).not.toContain('\x1b[');
    });

    it('renders ANSI colored table when color option is true', () => {
      const output = renderBenchTable(mockReport, { color: true });
      expect(output).toContain('TokenDamper Benchmark Execution Report');
      expect(output).toContain('\x1b[');
    });
  });

  describe('runCli bench command', () => {
    it('executes bench command cleanly, outputs table, and writes report JSON', () => {
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
      const stdoutText = stdoutChunks.join('');
      expect(stdoutText).toContain('TokenDamper Benchmark Execution Report');
      expect(stdoutText).toContain('OVERALL METRICS SUMMARY');

      expect(existsSync(tempReportPath)).toBe(true);
      const fileContent = readFileSync(tempReportPath, 'utf8');
      const jsonReport = JSON.parse(fileContent) as BenchmarkReport;

      expect(jsonReport.datasetName).toBeDefined();
      expect(jsonReport.totalFixtures).toBeGreaterThan(0);
      expect(jsonReport.overallSummary).toBeDefined();
      expect(jsonReport.overallSummary.totalRuns).toBeGreaterThan(0);
      expect(jsonReport.sweepResults.length).toBeGreaterThan(0);
      expect(jsonReport.environment).toBeDefined();
      expect(jsonReport.environment.tokendamperVersion).toBe('0.1.0');
    });

    it('suppresses table output when --quiet flag is provided', () => {
      const stdoutChunks: string[] = [];
      const mockIo = {
        stdout: {
          write: (chunk: unknown) => {
            stdoutChunks.push(String(chunk));
            return true;
          },
        } as never,
        stderr: {
          write: () => true,
        } as never,
      };

      const exitCode = runCli(['bench', 'humaneval', '--quiet'], mockIo, process.cwd());

      expect(exitCode).toBe(0);
      expect(stdoutChunks.join('')).toBe('');
    });

    it('parses custom budget flags when executing benchmark', () => {
      const stdoutChunks: string[] = [];
      const mockIo = {
        stdout: {
          write: (chunk: unknown) => {
            stdoutChunks.push(String(chunk));
            return true;
          },
        } as never,
        stderr: {
          write: () => true,
        } as never,
      };

      const exitCode = runCli(
        [
          'bench',
          'humaneval',
          '--max-input-tokens',
          '200',
          '--target-reduction-ratio',
          '0.4',
          '--risk-tolerance',
          'low',
          '--report-json',
          tempReportPath,
        ],
        mockIo,
        process.cwd(),
      );

      expect(exitCode).toBe(0);
      expect(existsSync(tempReportPath)).toBe(true);
      const jsonReport = JSON.parse(readFileSync(tempReportPath, 'utf8')) as BenchmarkReport;
      expect(jsonReport.sweepResults[0]?.budget.maxInputTokens).toBe(200);
      expect(jsonReport.sweepResults[0]?.budget.targetReductionRatio).toBe(0.4);
      expect(jsonReport.sweepResults[0]?.budget.riskTolerance).toBe('low');
    });

    it('executes bench mode via --mode bench flag', () => {
      const stdoutChunks: string[] = [];
      const mockIo = {
        stdout: {
          write: (chunk: unknown) => {
            stdoutChunks.push(String(chunk));
            return true;
          },
        } as never,
        stderr: {
          write: () => true,
        } as never,
      };

      const exitCode = runCli(
        ['optimize', 'humaneval', '--mode', 'bench', '--report-json', tempReportPath],
        mockIo,
        process.cwd(),
      );

      expect(exitCode).toBe(0);
      expect(stdoutChunks.join('')).toContain('TokenDamper Benchmark Execution Report');
      expect(existsSync(tempReportPath)).toBe(true);
    });
  });
});
