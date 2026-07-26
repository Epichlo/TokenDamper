import { describe, expect, it } from 'vitest';
import { renderBenchTable } from '../../../src/cli/bench-table-renderer';
import type { BenchmarkReport } from '../../../src/bench/types';

describe('Empirical Stress Testing of bench-table-renderer', () => {
  const baseReport: BenchmarkReport = {
    timestamp: '2026-07-26T12:00:00.000Z',
    datasetName: 'combined',
    totalFixtures: 5,
    overallSummary: {
      totalFixtures: 5,
      totalRuns: 10,
      avgReductionRatio: 0.45,
      fallbackRate: 0.1,
      avgLatencyMs: 12.34,
      p95LatencyMs: 45.67,
      syntaxPassRate: 0.98,
      passAt1Rate: 0.98,
      totalValidationIssues: 2,
    },
    sweepResults: [
      {
        sweepId: 'sweep-1',
        budget: {
          maxInputTokens: 500,
          targetReductionRatio: 0.5,
          riskTolerance: 'medium',
          preserveKinds: ['prompt', 'file', 'diff'],
        },
        summary: {
          totalFixtures: 5,
          totalRuns: 5,
          avgReductionRatio: 0.45,
          fallbackRate: 0.1,
          avgLatencyMs: 12.34,
          p95LatencyMs: 45.67,
          syntaxPassRate: 0.98,
          passAt1Rate: 0.98,
          totalValidationIssues: 1,
        },
        itemResults: [
          {
            fixtureId: 'f1',
            sweepId: 'sweep-1',
            inputTokens: 500,
            outputTokens: 250,
            tokenReductionRatio: 0.5,
            fallbackUsed: false,
            latencyMs: 10,
            validationPassed: true,
            validationIssues: [],
          },
          {
            fixtureId: 'f2',
            sweepId: 'sweep-1',
            inputTokens: 500,
            outputTokens: 500,
            tokenReductionRatio: 0.0,
            fallbackUsed: true,
            fallbackReason: 'Budget exceeded',
            latencyMs: 15,
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

  it('checks standard report line lengths for exact 80-column alignment', () => {
    const rendered = renderBenchTable(baseReport, { color: false });
    const lines = rendered.split('\n');
    
    // Line 0: top border (should be 80)
    expect(lines[0]?.length).toBe(80);
    // Line 1: Header title line (must be strictly 80)
    expect(lines[1]?.length).toBe(80);
    expect(lines[2]?.length).toBe(80);
    // Table header line (Line 20)
    expect(lines[20]?.length).toBe(80);
    // Data row line (Line 22)
    expect(lines[22]?.length).toBe(80);
  });

  it('stress tests long dataset paths', () => {
    const longPathReport: BenchmarkReport = {
      ...baseReport,
      datasetName: 'C:\\Users\\ojass\\Projects\\TokenDamper\\test\\fixtures\\bench\\very_long_directory_name_for_stress_testing\\humaneval_and_codexglue_combined_dataset_v1.json',
    };
    const rendered = renderBenchTable(longPathReport, { color: false });
    const lines = rendered.split('\n');
    const datasetLine = lines.find((l) => l.startsWith('Dataset Name:'));
    expect(datasetLine).toBeDefined();
    expect(datasetLine!.length).toBeLessThanOrEqual(80);
    expect(datasetLine).toContain('...');
  });

  it('stress tests fallback count and percentage overflow with valid medium risk tolerance', () => {
    const fallbackOverflowReport: BenchmarkReport = {
      ...baseReport,
      sweepResults: [
        {
          sweepId: 'sweep-1',
          budget: {
            maxInputTokens: 1000,
            targetReductionRatio: 0.5,
            riskTolerance: 'medium',
            preserveKinds: ['prompt', 'file', 'diff'],
          },
          summary: {
            totalFixtures: 10,
            totalRuns: 10,
            avgReductionRatio: 0.0,
            fallbackRate: 1.0,
            avgLatencyMs: 12.34,
            p95LatencyMs: 45.67,
            syntaxPassRate: 1.0,
            passAt1Rate: 1.0,
            totalValidationIssues: 0,
          },
          itemResults: Array.from({ length: 10 }, (_, i) => ({
            fixtureId: `f${i}`,
            sweepId: 'sweep-1',
            inputTokens: 1000,
            outputTokens: 1000,
            tokenReductionRatio: 0,
            fallbackUsed: true,
            latencyMs: 10,
            validationPassed: true,
            validationIssues: [],
          })),
        },
      ],
    };
    const rendered = renderBenchTable(fallbackOverflowReport, { color: false });
    const lines = rendered.split('\n');
    const rowLine = lines[lines.length - 2];
    expect(rowLine).toBeDefined();
    expect(rowLine!.length).toBe(80);
    expect(rowLine).toContain('10 (100.0%)');
    // Ensure space between fallback string and P95 latency string
    expect(rowLine).not.toContain('10 (100.0%)45.67');
  });

  it('stress tests empty sweep results', () => {
    const emptyReport: BenchmarkReport = {
      ...baseReport,
      totalFixtures: 0,
      overallSummary: {
        totalFixtures: 0,
        totalRuns: 0,
        avgReductionRatio: 0,
        fallbackRate: 0,
        avgLatencyMs: 0,
        p95LatencyMs: 0,
        syntaxPassRate: 0,
        passAt1Rate: 0,
        totalValidationIssues: 0,
      },
      sweepResults: [],
    };
    const rendered = renderBenchTable(emptyReport, { color: false });
    expect(rendered).toContain('PER-SWEEP BREAKDOWN');
  });
});
