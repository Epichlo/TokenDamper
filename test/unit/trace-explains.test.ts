import { describe, expect, it } from 'vitest';
import { parse } from '../../src/adapters/cli';
import { loadConfig } from '../../src/config/load';
import { optimize } from '../../src/core/engine';

/**
 * The explainability trace has to explain — audit M6.
 *
 * `buildTrace` projected each `StageResult` down to `{ stageId, status, durationMs: 0, changed }`,
 * discarding every stage's `metrics` and `notes` and hardcoding the duration. The stages compute
 * that telemetry carefully — `itemsHashed`, `bytesSaved`, `regionsHashed`, `irreversibleElisions`,
 * `skippedPostConditionRejected` — and the trace threw all of it away. A reader could see *that*
 * `compression:token-hashing` ran and changed something, but not what it removed, how much, or
 * whether the elision was reversible. `--diff` and `--diff-html` partially compensated on the
 * CLI; the MCP `get_optimization_trace` tool and the Gateway had nothing else.
 *
 * That is a problem for a product whose stated thesis is auditability, and it is the same shape
 * as invariant 10 — a field that reports `0` whether or not anything was measured.
 */
describe('the trace carries what the stages actually computed', () => {
  const runOn = (content: string, path: string, budget: Record<string, number>) => {
    const config = loadConfig();
    const request = parse(content, config, { sourceKind: 'file', sourcePath: path });
    return optimize({ ...request, budget: { ...request.budget, ...budget } });
  };

  const TS_SOURCE = [
    'export function alpha(a: number, b: number): number {',
    '  let total = 0;',
    '  for (let i = 0; i < a; i++) {',
    '    total += i * b;',
    '  }',
    '  return total;',
    '}',
    '',
    'export function beta(values: string[]): string {',
    '  const parts: string[] = [];',
    '  for (const value of values) {',
    '    parts.push(value.trim());',
    '  }',
    '  return parts.join(", ");',
    '}',
    '',
  ].join('\n');

  it('carries per-stage metrics and notes rather than projecting them away', () => {
    const result = runOn(TS_SOURCE, 'src/sample.ts', { targetReductionRatio: 0.5 });

    // Invariant 10: none of the below means anything if no stage ran.
    expect(result.trace.stageCount).toBeGreaterThan(0);

    for (const stage of result.trace.stageTraces) {
      expect(stage.metrics).toBeDefined();
      expect(typeof stage.metrics).toBe('object');
    }

    // At least one stage must have produced non-empty telemetry, or this test would pass
    // against a trace that carried `{}` for everything.
    const withMetrics = result.trace.stageTraces.filter((s) => Object.keys(s.metrics).length > 0);
    expect(withMetrics.length).toBeGreaterThan(0);

    const withNotes = result.trace.stageTraces.filter((s) => typeof s.notes === 'string' && s.notes.length > 0);
    expect(withNotes.length).toBeGreaterThan(0);
  });

  it('reports whether an elision was reversible, which was previously unknowable from the trace', () => {
    // No `TokenHasher` is supplied here, which is the CLI's situation: the removed bytes are
    // retained nowhere. The stage has always known this; the trace could not say it.
    const result = runOn(TS_SOURCE, 'src/sample.ts', { targetReductionRatio: 0.5 });

    const hashing = result.trace.stageTraces.find((s) => s.stageId === 'compression:token-hashing');
    expect(hashing).toBeDefined();
    expect(hashing?.changed).toBe(true);
    expect(hashing?.metrics.irreversibleElisions).toBeGreaterThan(0);
    expect(hashing?.notes).toContain('irreversible');
  });

  it('measures stage duration instead of reporting a hardcoded zero', () => {
    const result = runOn(TS_SOURCE, 'src/sample.ts', { targetReductionRatio: 0.5 });

    for (const stage of result.trace.stageTraces) {
      expect(stage.durationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(stage.durationMs)).toBe(true);
    }

    // Sub-millisecond resolution is the point: with `Date.now()` every one of these would be a
    // flat 0 and the field would be exactly as uninformative as the constant it replaced.
    const anyPositive = result.trace.stageTraces.some((s) => s.durationMs > 0);
    expect(anyPositive).toBe(true);
  });

  it('does not claim items fit a budget they exceed', () => {
    // The audit's reproduction. `applyCacheAwarePrefixLocking` pins everything inside the first
    // 1,024 tokens, `solve01Knapsack` always selects pinned items, and `createContextBundle`
    // builds a one-item bundle — so item 0 is always pinned and `itemsPruned` is always 0. The
    // stage reported "All items fit within token budget; no pruning required." for a bundle
    // hundreds of times over budget: not a vague note but a false factual claim, and one that
    // concealed the fact that pruning was impossible rather than unnecessary.
    const big = Array.from({ length: 400 }, (_, i) => `export const value${i} = ${i};`).join('\n');
    const result = runOn(big, 'src/big.ts', { maxInputTokens: 10 });

    const pruner = result.trace.stageTraces.find((s) => s.stageId === 'pruning:topology-pruner');
    expect(pruner).toBeDefined();
    expect(pruner?.metrics.itemsPruned).toBe(0);

    expect(pruner?.metrics.bundleTokens).toBeGreaterThan(10);
    expect(pruner?.metrics.maxTokens).toBe(10);
    expect(pruner?.notes).not.toContain('All items fit');
    expect(pruner?.notes).toContain('pinned');
  });
});
