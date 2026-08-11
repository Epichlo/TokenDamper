import { describe, expect, it } from 'vitest';
import { optimize } from '../../src/core/engine';
import {
  createBundleFromItems,
  createMultiItemRequest,
  createOptimizationRequest,
} from '../../src/core/model/constructors';
import { validate } from '../../src/core/validation';
import { DEFAULT_CONFIG } from '../../src/config/schema';
import type { OptimizationPlan, ResolvedConfig } from '../../src/core/model/types';

const PLAN: OptimizationPlan = {
  planId: 'p',
  mode: 'topology_knapsack',
  stageIds: Object.freeze([]),
  revalidationPoints: Object.freeze(['end']),
  fallbackPolicy: 'original_input',
};

/**
 * Phase 1c — per-item repair. Validation is bundle-scoped and fallback was all-or-nothing, so
 * one bad item reverted every good one.
 *
 * Measured on the 45-file Python corpus before this change: the stages achieved **42.52%**, 26
 * `CONSTRAINT_DIRECTIVE_LOST` errors across 14 items reverted all 45, and the run emitted
 * **0.00%** — with drift at 0.0359 against a 0.40 gate and AST clean. After: **22.73%** through
 * the CLI, `fallbackUsed: false`, 14 items reverted, drift 0.0141.
 *
 * The safety property is that repair changes *which bundle is offered*, never *what counts as
 * valid*: the repaired bundle goes back through the same `validate` and is adopted only if it
 * passes. These tests pin both halves — that it recovers value, and that it refuses to.
 */

const config: ResolvedConfig = {
  ...DEFAULT_CONFIG,
  budget: { ...DEFAULT_CONFIG.budget, targetReductionRatio: 0.5 },
};

/** A Python file with a docstring imperative — the shape that trips constraint retention. */
const withImperative = (n: number) => `def handler_${n}(payload):
    """You must not drop this line ${n} under any circumstance whatsoever."""
    total = 0
    for entry in payload:
        total += entry
        total = total * 2
        total = total - 1
    return total
`;

/** A plain Python file with elidable bodies and no imperative to lose. */
const plain = (n: number) => `def compute_${n}(values):
    total = 0
    for value in values:
        total += value
        total = total * 3
        total = total - 2
    return total


def render_${n}(values):
    parts = []
    for value in values:
        parts.append(str(value))
        parts.append("-")
    return "".join(parts)
`;

function runMulti(files: ReadonlyArray<{ path: string; content: string }>) {
  const request = createMultiItemRequest(
    files.map((f) => ({ ...f, language: 'python' })),
    config,
    { requestId: 'r', adapterName: 'test', adapterVersion: '1', source: 'file' },
  );
  return { request, result: optimize(request, {}) };
}

describe('per-item repair recovers a bundle one item would have reverted (1c)', () => {
  it('keeps the good items and reverts only the named one', () => {
    const files = [
      { path: 'a.py', content: plain(1) },
      { path: 'b.py', content: plain(2) },
      { path: 'bad.py', content: withImperative(3) },
      { path: 'c.py', content: plain(4) },
    ];
    const { request, result } = runMulti(files);

    expect(result.fallbackUsed).toBe(false);
    expect(result.trace.tokenAfter).toBeLessThan(result.trace.tokenBefore);

    // The offending item is named, and it is the only one.
    const reverted = result.trace.itemsReverted ?? [];
    expect(reverted).toHaveLength(1);

    // The reverted item is back to its original content, byte for byte.
    const revertedItem = result.finalBundle.items.find((i) => i.id === reverted[0]);
    const originalItem = request.bundle.items.find((i) => i.id === reverted[0]);
    expect(revertedItem!.content).toBe(originalItem!.content);
    expect(revertedItem!.content).toContain('You must not drop this line 3');

    // And at least one other item really was optimized — otherwise this is a fallback wearing
    // a different name, which is the failure mode the `revertFailingItems` guard exists for.
    const changed = result.finalBundle.items.filter((item) => {
      const before = request.bundle.items.find((i) => i.id === item.id);
      return before && before.content !== item.content;
    });
    expect(changed.length).toBeGreaterThan(0);
  });

  it('reports the revert on the trace, so a partial success cannot pass for a clean one', () => {
    const { result } = runMulti([
      { path: 'a.py', content: plain(1) },
      { path: 'bad.py', content: withImperative(2) },
      { path: 'c.py', content: plain(3) },
    ]);

    // Invariant 10 applied to repair: a reduction with `fallbackUsed: false` and no other signal
    // would conceal that some items were quietly restored.
    expect(result.fallbackUsed).toBe(false);
    expect(result.trace.itemsReverted).toBeDefined();
    expect(result.trace.itemsReverted!.length).toBeGreaterThan(0);
  });

  it('says nothing about reverts when every item passed', () => {
    const { result } = runMulti([
      { path: 'a.py', content: plain(1) },
      { path: 'b.py', content: plain(2) },
    ]);
    expect(result.fallbackUsed).toBe(false);
    expect(result.trace.itemsReverted).toBeUndefined();
  });
});

describe('per-item repair refuses where it would be guessing (1c)', () => {
  it('does not turn a single failing file into a partial success', () => {
    // One item cannot be partially repaired: reverting it yields the original bundle, which is a
    // fallback. `revertFailingItems` returns undefined for that, so the run takes the real
    // fallback path — which echoes `request.rawInput` rather than re-rendering from items, and
    // that distinction is what DECISIONS §35 is about.
    const request = createOptimizationRequest(withImperative(1), config, {
      requestId: 'single',
      adapterName: 'test',
      adapterVersion: '1',
      source: 'file',
      sourcePath: 'bad.py',
      language: 'python',
    });

    const result = optimize(request, {});

    expect(result.fallbackUsed).toBe(true);
    expect(result.emittedOutput).toBe(request.rawInput);
    expect(result.trace.itemsReverted).toBeUndefined();
  });

  it('falls back fully when every item fails', () => {
    const { request, result } = runMulti([
      { path: 'a.py', content: withImperative(1) },
      { path: 'b.py', content: withImperative(2) },
    ]);

    expect(result.fallbackUsed).toBe(true);
    expect(result.trace.itemsReverted).toBeUndefined();
    // Fail-open: the caller gets their input back.
    expect(result.emittedOutput).toBe(request.rawInput);
  });

  it('attributes constraint failures to items as data, not as prose', () => {
    // The prerequisite for all of the above. Attribution existed before Phase 1c only as an
    // interpolated `"item [<id>]"` inside the message; recovering it by regex would be audit
    // M5b exactly — two places restating one format.
    //
    // Asserted against `validate()` rather than against an engine result, because a *successful*
    // repair replaces the report with the re-validated one, which passed and therefore names
    // nothing. That is correct — the final report describes the bundle that was accepted — and
    // it is the reason this test does not go through `optimize`.
    const request = createMultiItemRequest(
      [
        { path: 'a.py', content: plain(1), language: 'python' },
        { path: 'bad.py', content: withImperative(2), language: 'python' },
      ],
      config,
      { requestId: 'r', adapterName: 'test', adapterVersion: '1', source: 'file' },
    );

    // The offending item, emptied of its imperative — the exact loss the checker looks for.
    const stripped = request.bundle.items.map((item) =>
      item.content.includes('You must not drop')
        ? { ...item, content: 'def handler_2(payload):\n    return 0\n' }
        : item,
    );
    const after = createBundleFromItems(stripped, request.bundle.source);

    const report = validate(request.bundle, after, PLAN, request.budget);

    expect(report.passed).toBe(false);
    const attribution = report.attribution;
    expect(attribution).toBeDefined();
    expect(attribution!.hasUnattributableError).toBe(false);
    expect(attribution!.repairableItemIds).toHaveLength(1);

    // The id is carried on the issue itself, not only inside the message text.
    const issue = report.issues.find((i) => i.code === 'CONSTRAINT_DIRECTIVE_LOST');
    expect(issue!.itemId).toBe(attribution!.repairableItemIds[0]);
  });

  it('marks a bundle-scoped drift failure as unattributable', () => {
    // `SEMANTIC_DRIFT_EXCEEDED` is a set comparison over the whole bundle and names no item.
    // Repair must refuse rather than revert a guessed subset — the distinction that keeps this
    // from becoming the guessing this project keeps finding.
    const request = createMultiItemRequest(
      [
        { path: 'a.py', content: plain(1), language: 'python' },
        { path: 'b.py', content: plain(2), language: 'python' },
      ],
      config,
      { requestId: 'r', adapterName: 'test', adapterVersion: '1', source: 'file' },
    );

    // Gut every item: all symbols destroyed, so drift is measured and far over the gate.
    const gutted = request.bundle.items.map((item) => ({ ...item, content: 'x = 1\n' }));
    const after = createBundleFromItems(gutted, request.bundle.source);

    const report = validate(request.bundle, after, PLAN, request.budget);

    expect(report.passed).toBe(false);
    expect(report.issues.some((i) => i.code === 'SEMANTIC_DRIFT_EXCEEDED')).toBe(true);
    expect(report.attribution!.hasUnattributableError).toBe(true);
  });
});
