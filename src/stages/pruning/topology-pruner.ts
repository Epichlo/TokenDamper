import type { ContextBundle, ContextItem, OptimizationBudget, StageResult } from '../../core/model/types';
import { resolveTokenCeiling } from '../../core/budget';
import { createBundleStatistics, createStageResult, freeze, hashContent } from '../../core/model/constructors';
import { inspectGitWorkspace } from '../../core/topology/git-inspector';
import { buildDependencyGraph } from '../../core/topology/dependency-graph';
import { scoreBundleTopology } from '../../core/topology/topology-scorer';
import { applyCacheAwarePrefixLocking } from '../../core/planner/cache-aware';
import { solve01Knapsack } from '../../core/planner/knapsack';
import { DEFAULT_TOKENIZER, estimateBundleTokens, type TokenizerAdapter } from '../../core/hashing/tokenizer';

/**
 * Built-in stage: `pruning:topology-pruner` (v0.1.0).
 * Performs topology-aware context pruning using git workspace inspection,
 * code dependency graph distance, cache prefix locking, and 0/1 knapsack allocation.
 */
export function runTopologyPrunerStage(
  bundle: ContextBundle,
  budget: OptimizationBudget,
  workspaceRoot?: string,
  tokenizer: TokenizerAdapter = DEFAULT_TOKENIZER
): StageResult {
  const stageId = 'pruning:topology-pruner';

  try {
    // Resolved rather than read straight off `maxInputTokens`, so `targetReductionRatio` reaches
    // the solver at all. It never did: this branch bypassed pruning entirely whenever only a
    // ratio was set, which is why a 45-file bundle at `--target-reduction-ratio 0.3` reported
    // "maxInputTokens not specified in budget; topology pruning bypassed" and selected nothing.
    const maxTokens = resolveTokenCeiling(bundle, budget);
    if (typeof maxTokens !== 'number' || maxTokens <= 0) {
      return createStageResult({
        stageId,
        status: 'ok',
        bundle,
        changed: false,
        metrics: {
          itemsPruned: 0,
          tokensSaved: 0,
          pinnedCount: 0,
          selectedCount: bundle.items.length,
        },
        notes: 'No token ceiling in budget (neither maxInputTokens nor targetReductionRatio); topology pruning bypassed.',
      });
    }

    // 1. Inspect Git workspace
    const gitStatus = inspectGitWorkspace(workspaceRoot);

    // 2. Build dependency graph
    const graph = buildDependencyGraph(bundle.items);

    // 3. Score item topology
    const scores = scoreBundleTopology(bundle, gitStatus, graph, budget);

    // 4. Lock prompt cache prefixes
    const knapsackItems = applyCacheAwarePrefixLocking(bundle.items, scores, budget, undefined, tokenizer);

    // 5. Solve 0/1 Knapsack
    const knapsackResult = solve01Knapsack(knapsackItems, maxTokens);

    // 6. Select pruned items
    const selectedItems: ContextItem[] = bundle.items.filter((item) =>
      knapsackResult.selectedItemIds.has(item.id),
    );

    const itemsPruned = bundle.items.length - selectedItems.length;

    if (itemsPruned === 0) {
      const pinnedCount = knapsackItems.filter((i) => i.isPinned).length;
      const bundleTokens = knapsackItems.reduce((sum, i) => sum + i.weight, 0);

      // Say which of the two very different reasons produced "nothing pruned".
      //
      // This unconditionally reported "All items fit within token budget; no pruning required."
      // — which is a factual claim, and it was false in the case that matters. `solve01Knapsack`
      // places pinned items outside the candidate set and always selects them, and
      // `applyCacheAwarePrefixLocking` pins everything inside the first 1,024 tokens; on the
      // one-item bundle `createContextBundle` builds for CLI, MCP and bench, item 0 is therefore
      // always pinned. Measured: a 4,600-token file at `maxInputTokens: 10` reported "all items
      // fit" — 4,600 tokens do not fit in 10. It announced that pruning was unnecessary for a
      // case where pruning was impossible. (audit M6, H5)
      const everythingPinned = pinnedCount === knapsackItems.length && knapsackItems.length > 0;
      const overBudget = bundleTokens > maxTokens;
      const notes = everythingPinned && overBudget
        ? `Nothing prunable: all ${pinnedCount} item(s) are pinned by cache-prefix locking, but the bundle is ${bundleTokens} tokens against a budget of ${maxTokens}. Pinned items bypass the knapsack (invariant 7), so the budget could not be enforced.`
        : overBudget
          ? `No items pruned, but the bundle is ${bundleTokens} tokens against a budget of ${maxTokens}; the knapsack selected every candidate.`
          : `All items fit within token budget (${bundleTokens} of ${maxTokens} tokens); no pruning required.`;

      return createStageResult({
        stageId,
        status: 'ok',
        bundle,
        changed: false,
        metrics: {
          itemsPruned: 0,
          tokensSaved: 0,
          pinnedCount,
          selectedCount: bundle.items.length,
          bundleTokens,
          maxTokens,
        },
        notes,
      });
    }

    // 7. Calculate graph distance metric
    let totalGraphDistance = 0;
    let scoredCount = 0;
    for (const item of selectedItems) {
      const scoreObj = scores.get(item.id);
      if (scoreObj && scoreObj.graphDistance < Infinity) {
        totalGraphDistance += scoreObj.graphDistance;
        scoredCount++;
      }
    }
    const graphDistanceAvg = scoredCount > 0 ? totalGraphDistance / scoredCount : 0;

    // 8. Reconstruct new ContextBundle
    const statistics = createBundleStatistics(selectedItems);
    const bundleHash = hashContent({
      source: bundle.source,
      items: selectedItems.map((entry) => entry.contentHash),
      statistics,
    });

    const rawCombined = selectedItems.map((i) => i.content).join('\n');
    const tokenEstimate = estimateBundleTokens(selectedItems, tokenizer);
    const tokensSaved = Math.max(0, bundle.summary.tokenEstimate - tokenEstimate);

    const newBundle: ContextBundle = freeze({
      id: bundleHash,
      bundleId: bundleHash,
      source: bundle.source,
      items: freeze(selectedItems),
      summary: freeze({
        itemCount: selectedItems.length,
        tokenEstimate,
        preview: rawCombined.slice(0, 80),
      }),
      statistics,
      contentHash: bundleHash,
    });

    const strategyCode =
      knapsackResult.strategyUsed === 'dp'
        ? 1
        : knapsackResult.strategyUsed === 'greedy_density'
        ? 2
        : 0;

    return createStageResult({
      stageId,
      status: 'ok',
      bundle: newBundle,
      changed: true,
      metrics: {
        itemsPruned,
        tokensSaved,
        pinnedCount: knapsackItems.filter((i) => i.isPinned).length,
        selectedCount: selectedItems.length,
        graphDistanceAvg,
        knapsackStrategy: strategyCode,
      },
      notes: `Pruned ${itemsPruned} item(s) using ${knapsackResult.strategyUsed} knapsack solver. Saved ${tokensSaved} tokens.`,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return createStageResult({
      stageId,
      status: 'failed',
      bundle,
      changed: false,
      metrics: {
        itemsPruned: 0,
        tokensSaved: 0,
        pinnedCount: 0,
        selectedCount: bundle.items.length,
      },
      notes: `Topology pruner stage failed: ${errorMsg}`,
    });
  }
}
