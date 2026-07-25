import { writeFileSync } from 'node:fs';
import type { ContextBundle, OptimizationResult } from '../core/model';

export interface HtmlReporterOptions {
  readonly title?: string;
  readonly outputPath?: string; // If specified, writes to disk
}

/**
 * Generates a standalone, self-contained HTML report with dark-mode visual diff
 * and metric gauges for optimization debt (D_k) and semantic drift (S_k).
 */
export function generateHtmlReport(
  result: OptimizationResult,
  beforeBundle: ContextBundle,
  options?: HtmlReporterOptions,
): string {
  const title = options?.title ?? 'TokenDamper Optimization & Drift Report';
  const beforeTokens = beforeBundle.summary.tokenEstimate;
  const afterTokens = result.finalBundle.summary.tokenEstimate;
  const savingsPct =
    beforeTokens > 0 ? (((beforeTokens - afterTokens) / beforeTokens) * 100).toFixed(1) : '0.0';

  const debtScore = result.trace.debtScore ?? 0.0;
  const driftReport = result.validation.driftReport;
  const driftScore = result.trace.driftScore ?? driftReport?.driftScore ?? 0.0;

  const debtStatus = debtScore > 75 ? 'HIGH' : debtScore >= 50 ? 'MEDIUM' : 'LOW';
  const debtColor = debtScore > 75 ? '#f38ba8' : debtScore >= 50 ? '#f9e2af' : '#a6e3a1';

  const driftStatus = driftScore > 0.4 ? 'HIGH DRIFT' : 'SAFE';
  const driftColor = driftScore > 0.4 ? '#f38ba8' : '#a6e3a1';

  const fallbackStatus = result.fallbackUsed ? 'FALLBACK USED' : 'PASSED';
  const fallbackColor = result.fallbackUsed ? '#f38ba8' : '#a6e3a1';

  const beforeText = beforeBundle.items.map((i) => i.content).join('\n');
  const afterText = result.finalBundle.items.map((i) => i.content).join('\n');

  const diffHtml = renderHtmlDiff(beforeText, afterText);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg-color: #1e1e2e;
      --card-bg: #181825;
      --text-color: #cdd6f4;
      --text-dim: #a6adc8;
      --border-color: #313244;
      --accent: #89b4fa;
      --added-bg: #1e3a29;
      --added-text: #a6e3a1;
      --deleted-bg: #3a1e28;
      --deleted-text: #f38ba8;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: var(--bg-color);
      color: var(--text-color);
      margin: 0;
      padding: 24px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 2px solid var(--border-color);
      padding-bottom: 16px;
      margin-bottom: 24px;
    }
    h1 {
      margin: 0;
      font-size: 24px;
      color: var(--accent);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
    }
    .card-title {
      font-size: 13px;
      color: var(--text-dim);
      text-transform: uppercase;
      margin-bottom: 8px;
    }
    .card-value {
      font-size: 28px;
      font-weight: bold;
    }
    .badge {
      margin-top: 8px;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: bold;
    }
    .gauge-container {
      position: relative;
      width: 90px;
      height: 90px;
    }
    .gauge-text {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      font-size: 16px;
      font-weight: bold;
    }
    .diff-container {
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      overflow: hidden;
    }
    .diff-header {
      background: #11111b;
      padding: 12px 16px;
      font-weight: bold;
      border-bottom: 1px solid var(--border-color);
      color: var(--accent);
    }
    .diff-table {
      width: 100%;
      border-collapse: collapse;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      font-size: 13px;
    }
    .diff-table td {
      padding: 4px 12px;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .line-no {
      width: 40px;
      color: var(--text-dim);
      text-align: right;
      user-select: none;
      border-right: 1px solid var(--border-color);
    }
    tr.added {
      background-color: var(--added-bg);
      color: var(--added-text);
    }
    tr.deleted {
      background-color: var(--deleted-bg);
      color: var(--deleted-text);
    }
    tr.hunk-header {
      background-color: #1e1e2e;
      color: var(--accent);
      font-weight: bold;
    }
    .token-placeholder {
      background: #45475a;
      color: #f9e2af;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: bold;
    }
    .token-directive {
      background: #45475a;
      color: #cba6f7;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: bold;
    }
    .token-elided {
      background: #f9e2af;
      color: #11111b;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: bold;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(title)}</h1>
    <span class="badge" style="background: ${fallbackColor}; color: #11111b;">${fallbackStatus}</span>
  </div>

  <div class="grid">
    <div class="card">
      <div class="card-title">Token Reduction</div>
      <div class="card-value" style="color: var(--accent);">${beforeTokens} &rarr; ${afterTokens}</div>
      <div class="badge" style="background: #313244; color: #a6e3a1;">${savingsPct}% Savings</div>
    </div>

    <div class="card">
      <div class="card-title">Optimization Debt (D_k)</div>
      <div class="gauge-container">
        ${renderSvgGauge(debtScore / 100, debtColor)}
        <div class="gauge-text" style="color: ${debtColor};">${debtScore.toFixed(1)}</div>
      </div>
      <div class="badge" style="background: ${debtColor}; color: #11111b;">${debtStatus}</div>
    </div>

    <div class="card">
      <div class="card-title">Semantic Drift (S_k)</div>
      <div class="gauge-container">
        ${renderSvgGauge(driftScore, driftColor)}
        <div class="gauge-text" style="color: ${driftColor};">${driftScore.toFixed(2)}</div>
      </div>
      <div class="badge" style="background: ${driftColor}; color: #11111b;">${driftStatus}</div>
    </div>

    <div class="card">
      <div class="card-title">Symbol / Struct Retention</div>
      <div class="card-value" style="color: var(--text-color);">
        ${((driftReport?.astSymbolRetentionRatio ?? 1.0) * 100).toFixed(0)}% / ${((driftReport?.structuralIntegrityRatio ?? 1.0) * 100).toFixed(0)}%
      </div>
      <div class="badge" style="background: #313244; color: var(--text-dim);">
        Symbols: ${driftReport?.symbolsAfterCount ?? 0}/${driftReport?.symbolsBeforeCount ?? 0}
      </div>
    </div>
  </div>

  <div class="diff-container">
    <div class="diff-header">Visual Context Bundle Diff</div>
    <table class="diff-table">
      ${diffHtml}
    </table>
  </div>
</body>
</html>`;

  if (options?.outputPath) {
    writeFileSync(options.outputPath, html, 'utf8');
  }

  return html;
}

function renderSvgGauge(ratio: number, color: string): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - clamped);

  return `<svg width="90" height="90" viewBox="0 0 90 90">
    <circle cx="45" cy="45" r="${radius}" stroke="#313244" stroke-width="8" fill="none" />
    <circle cx="45" cy="45" r="${radius}" stroke="${color}" stroke-width="8" fill="none"
      stroke-dasharray="${circumference.toFixed(2)}"
      stroke-dashoffset="${strokeDashoffset.toFixed(2)}"
      stroke-linecap="round"
      transform="rotate(-90 45 45)" />
  </svg>`;
}

function renderHtmlDiff(before: string, after: string): string {
  const linesBefore = before.split('\n');
  const linesAfter = after.split('\n');
  const m = linesBefore.length;
  const n = linesAfter.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (linesBefore[i - 1] === linesAfter[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  interface Op {
    type: 'keep' | 'add' | 'delete';
    line: string;
    bNo?: number;
    aNo?: number;
  }
  const ops: Op[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && linesBefore[i - 1] === linesAfter[j - 1]) {
      ops.push({ type: 'keep', line: linesBefore[i - 1]!, bNo: i, aNo: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      ops.push({ type: 'add', line: linesAfter[j - 1]!, aNo: j });
      j--;
    } else if (i > 0 && (j === 0 || dp[i]![j - 1]! < dp[i - 1]![j]!)) {
      ops.push({ type: 'delete', line: linesBefore[i - 1]!, bNo: i });
      i--;
    }
  }
  ops.reverse();

  const rows: string[] = [];
  for (const op of ops) {
    const formatted = formatHtmlLineContent(op.line);
    const bStr = op.bNo ? String(op.bNo) : '';
    const aStr = op.aNo ? String(op.aNo) : '';

    if (op.type === 'add') {
      rows.push(`<tr class="added"><td class="line-no"></td><td class="line-no">${aStr}</td><td>+ ${formatted}</td></tr>`);
    } else if (op.type === 'delete') {
      rows.push(`<tr class="deleted"><td class="line-no">${bStr}</td><td class="line-no"></td><td>- ${formatted}</td></tr>`);
    } else {
      rows.push(`<tr class="keep"><td class="line-no">${bStr}</td><td class="line-no">${aStr}</td><td>  ${formatted}</td></tr>`);
    }
  }

  return rows.join('\n');
}

function formatHtmlLineContent(text: string): string {
  let escaped = escapeHtml(text);
  // Highlight elisions
  escaped = escaped.replace(/(\[TokenDamper[^\]]*\])/g, '<span class="token-elided">$1</span>');
  // Highlight placeholders
  escaped = escaped.replace(/(&lt;BLOCK_HASH:[^&]+&gt;)/g, '<span class="token-placeholder">$1</span>');
  // Highlight directives
  escaped = escaped.replace(/(TD_PRESERVE:[^\s&]+)/g, '<span class="token-directive">✓ $1</span>');
  return escaped;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
