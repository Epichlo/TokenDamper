import type { BenchmarkReport } from '../bench/types';

export interface RenderBenchTableOptions {
  /**
   * Whether to include ANSI color escape codes in the output table string.
   * Defaults to `true` (or checking `process.stdout.hasColors` / `NO_COLOR`).
   */
  readonly color?: boolean;
}

/**
  * Formats a BenchmarkReport into an 80-column ANSI terminal summary table.
  */
export function renderBenchTable(
  report: BenchmarkReport,
  options?: RenderBenchTableOptions,
): string {
  const useColor = options?.color ?? true;

  const c = (text: string, colorCode: string): string => {
    return useColor ? `${colorCode}${text}\x1b[0m` : text;
  };

  const borderDbl = c('='.repeat(80), '\x1b[1;36m');
  const borderSgl = c('-'.repeat(80), '\x1b[36m');

  const lines: string[] = [];

  // Header Box
  lines.push(borderDbl);
  lines.push(c(' '.repeat(21) + 'TokenDamper Benchmark Execution Report' + ' '.repeat(21), '\x1b[1;33m'));
  lines.push(borderDbl);

  const displayDataset =
    report.datasetName.length > 55
      ? '...' + report.datasetName.slice(-52)
      : report.datasetName;
  lines.push(`${c('Dataset Name:', '\x1b[1;33m')}       ${displayDataset}`);
  lines.push(`${c('Total Fixtures:', '\x1b[1;33m')}     ${report.totalFixtures}`);
  lines.push(`${c('Total Budget Runs:', '\x1b[1;33m')}  ${report.overallSummary.totalRuns}`);
  lines.push(
    `${c('Node / Environment:', '\x1b[1;33m')} ${report.environment.nodeVersion} (${report.environment.platform}) | TokenDamper v${report.environment.tokendamperVersion}`,
  );
  lines.push(`${c('Timestamp:', '\x1b[1;33m')}          ${report.timestamp}`);
  lines.push(borderSgl);

  // Overall Metrics Summary
  const summary = report.overallSummary;
  const aggReduction = (summary.avgReductionRatio * 100).toFixed(1) + '%';
  const totalFallbacks = report.sweepResults.reduce(
    (acc, s) => acc + s.itemResults.filter((r) => r.fallbackUsed).length,
    0,
  );
  const fallbackRateStr = (summary.fallbackRate * 100).toFixed(1) + '%';
  const meanLatencyStr = summary.avgLatencyMs.toFixed(2) + ' ms';
  const p95LatencyStr = summary.p95LatencyMs.toFixed(2) + ' ms';
  const syntaxPassStr = (summary.syntaxPassRate * 100).toFixed(1) + '%';

  lines.push(c('OVERALL METRICS SUMMARY', '\x1b[1;33m'));
  lines.push(borderSgl);

  const redColor = summary.avgReductionRatio >= 0.3 ? '\x1b[32m' : '\x1b[33m';
  const fbColor = totalFallbacks === 0 ? '\x1b[32m' : '\x1b[1;31m';
  const synColor = summary.syntaxPassRate >= 0.95 ? '\x1b[32m' : '\x1b[1;31m';

  lines.push(`  ${c('Aggregate Token Reduction:', '\x1b[1m')}  ${c(aggReduction, redColor)}`);
  lines.push(`  ${c('Fallback Count & Rate:', '\x1b[1m')}      ${c(`${totalFallbacks} (${fallbackRateStr})`, fbColor)}`);
  lines.push(`  ${c('Mean / P95 Latency:', '\x1b[1m')}         Mean: ${meanLatencyStr} | P95: ${p95LatencyStr}`);
  lines.push(`  ${c('Syntax Pass Rate:', '\x1b[1m')}           ${c(syntaxPassStr, synColor)}`);
  lines.push(`  ${c('Total Validation Issues:', '\x1b[1m')}    ${summary.totalValidationIssues}`);
  lines.push(borderSgl);

  // Per-Sweep Breakdown Table
  lines.push(c('PER-SWEEP BREAKDOWN', '\x1b[1;33m'));
  lines.push(borderSgl);

  // Column Headers (Widths: 10 + 10 + 8 + 10 + 15 + 14 + 13 = 80)
  const h1 = 'MaxInput'.padEnd(10);
  const h2 = 'TargetRed'.padEnd(10);
  const h3 = 'Risk'.padEnd(8);
  const h4 = 'Red Ratio'.padEnd(10);
  const h5 = 'Fallbacks'.padEnd(15);
  const h6 = 'P95 Latency'.padEnd(14);
  const h7 = 'Syntax Pass'.padEnd(13);
  lines.push(c(`${h1}${h2}${h3}${h4}${h5}${h6}${h7}`, '\x1b[1;33m'));
  lines.push(borderSgl);

  for (const sweep of report.sweepResults) {
    const maxIn = sweep.budget.maxInputTokens !== undefined ? String(sweep.budget.maxInputTokens) : 'unlimited';
    const targetRed =
      sweep.budget.targetReductionRatio !== undefined
        ? `${(sweep.budget.targetReductionRatio * 100).toFixed(0)}%`
        : 'N/A';
    const risk = sweep.budget.riskTolerance ?? 'medium';
    const redRatio = `${(sweep.summary.avgReductionRatio * 100).toFixed(1)}%`;
    const fbCount = sweep.itemResults.filter((r) => r.fallbackUsed).length;
    const fbStr = `${fbCount} (${(sweep.summary.fallbackRate * 100).toFixed(1)}%)`;
    const p95Str = `${sweep.summary.p95LatencyMs.toFixed(2)} ms`;
    const synStr = `${(sweep.summary.syntaxPassRate * 100).toFixed(1)}%`;

    const c1 = maxIn.length > 10 ? maxIn.slice(0, 10) : maxIn.padEnd(10);
    const c2 = targetRed.length > 10 ? targetRed.slice(0, 10) : targetRed.padEnd(10);
    const c3 = risk.length > 8 ? risk.slice(0, 8) : risk.padEnd(8);
    const c4 = redRatio.length > 10 ? redRatio.slice(0, 10) : redRatio.padEnd(10);
    const c5 = fbStr.length > 15 ? fbStr.slice(0, 15) : fbStr.padEnd(15);
    const c6 = p95Str.length > 14 ? p95Str.slice(0, 14) : p95Str.padEnd(14);
    const c7 = synStr.length > 13 ? synStr.slice(0, 13) : synStr.padEnd(13);

    if (useColor) {
      const rowRedColor = sweep.summary.avgReductionRatio >= 0.3 ? '\x1b[32m' : '\x1b[33m';
      const rowFbColor = fbCount === 0 ? '\x1b[32m' : '\x1b[1;31m';
      const rowSynColor = sweep.summary.syntaxPassRate >= 0.95 ? '\x1b[32m' : '\x1b[1;31m';

      lines.push(
        `${c1}${c2}${c3}${c(c4, rowRedColor)}${c(c5, rowFbColor)}${c6}${c(c7, rowSynColor)}`,
      );
    } else {
      lines.push(`${c1}${c2}${c3}${c4}${c5}${c6}${c7}`);
    }
  }

  lines.push(borderDbl);
  return lines.join('\n');
}
