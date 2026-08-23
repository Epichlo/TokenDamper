import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { plan } from '../../src/core/planner';
import { getBuiltInStageCatalog } from '../../src/core/stage-registry';
import { createBundleFromItems, createContextItem, createOptimizationBudget } from '../../src/core/model/constructors';
import { loadConfig } from '../../src/config/load';
import type { ResolvedConfig } from '../../src/core/model/types';

/**
 * `ARCHITECTURE.md` says of itself that it is the canonical, frozen reference — audit OX-M11.
 *
 * Its pipeline diagram listed the execution order as "Session Deduplication (TokenHasher) → Delta
 * Compression (Myers Diff) → Workspace Topology Pruning". Every clause was wrong: that is not the
 * knapsack order, `cleanup:constraint-preservation` was missing from the front of it,
 * `cleanup:session-dedup` is not in that plan at all (it is a separate single-stage plan the
 * Gateway pins), and it uses the session store rather than `TokenHasher`.
 *
 * A frozen reference that contributors and agents validate new stages against is worse when wrong
 * than when absent, so the stage lists in it are checked against the planner that produces them
 * rather than maintained by hand.
 */
describe('ARCHITECTURE.md matches the planner', () => {
  const doc = readFileSync(join(__dirname, '..', '..', 'ARCHITECTURE.md'), 'utf8');
  const config = loadConfig();

  const bundleOf = () =>
    createBundleFromItems([
      createContextItem({ id: 'arch-doc-item', content: 'export const alpha = 1;\n', kind: 'file', path: 'a.ts' }),
    ]);

  const planFor = (budgetOptions: Parameters<typeof createOptimizationBudget>[0], cfg: ResolvedConfig = config) =>
    plan(bundleOf(), createOptimizationBudget(budgetOptions), cfg, getBuiltInStageCatalog());

  it('documents the knapsack stage list in the order the planner emits it', () => {
    const stageIds = planFor({ riskTolerance: 'low', preserveKinds: [], targetReductionRatio: 0.3 }).stageIds;

    expect(stageIds.length).toBeGreaterThan(0);

    // Each id appears in the document, and their positions ascend in the same order the planner
    // returns them. Positional rather than textual so the prose around them stays free.
    const positions = stageIds.map((id) => doc.indexOf(id));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions]).toEqual([...positions].sort((a, b) => a - b));
  });

  it('documents session-dedup as its own single-stage plan, not part of the knapsack list', () => {
    const gatewayConfig = { ...config, planner: { ...config.planner, defaultMode: 'session_dedup' } } as ResolvedConfig;
    const dedupPlan = planFor({ riskTolerance: 'low', preserveKinds: [], targetReductionRatio: 0.3 }, gatewayConfig);
    const knapsack = planFor({ riskTolerance: 'low', preserveKinds: [], targetReductionRatio: 0.3 });

    expect(dedupPlan.stageIds).toEqual(['cleanup:session-dedup']);
    expect(knapsack.stageIds).not.toContain('cleanup:session-dedup');
    expect(doc).toContain('cleanup:session-dedup');
  });

  it('does not attribute TokenHasher to session-dedup', () => {
    // The specific false claim. `cleanup:session-dedup` works off the session store and
    // `renderSessionElisionMarker`; the two mechanisms are unrelated.
    expect(doc).not.toMatch(/Session Deduplication \(TokenHasher\)/);
  });

  it('records that a no-budget run plans nothing at all', () => {
    // The pass_through case is the one users mistake for a bug, repeatedly. It belongs in the
    // canonical diagram precisely because a guaranteed 0% looks like a defect.
    expect(planFor({ riskTolerance: 'low', preserveKinds: [] }).stageIds).toEqual([]);
    expect(doc).toContain('pass_through');
  });
});
