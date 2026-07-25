import { describe, expect, it } from 'vitest';
import { solve01Knapsack, solveKnapsack, type KnapsackItem } from '../../src/core/planner/knapsack';
import { plan } from '../../src/core/planner';
import { createContextBundle, createOptimizationBudget } from '../../src/core/model';
import type { ResolvedConfig } from '../../src/core/model';

describe('knapsack 0/1 solver', () => {
  it('returns pass_through when all items fit within maxTokens', () => {
    const items: KnapsackItem[] = [
      { id: '1', itemId: '1', weight: 50, value: 80, isPinned: false, kind: 'file' },
      { id: '2', itemId: '2', weight: 100, value: 60, isPinned: false, kind: 'file' },
    ];

    const result = solve01Knapsack(items, 200);

    expect(result.strategyUsed).toBe('pass_through');
    expect(result.selectedItemIds.size).toBe(2);
    expect(result.totalWeight).toBe(150);
    expect(result.overflowTokens).toBe(0);
  });

  it('solves knapsack using DP algorithm when candidates <= 100 and capacity <= 10000', () => {
    const items: KnapsackItem[] = [
      { id: 'item-1', itemId: 'item-1', weight: 40, value: 50, isPinned: false, kind: 'file' },
      { id: 'item-2', itemId: 'item-2', weight: 30, value: 40, isPinned: false, kind: 'file' },
      { id: 'item-3', itemId: 'item-3', weight: 20, value: 30, isPinned: false, kind: 'file' },
    ];

    // Capacity 50 -> Optimal choice is item-2 (30, 40) + item-3 (20, 30) = weight 50, value 70
    // item-1 (40, 50) + item-3 (20, 30) = weight 60 (exceeds)
    const result = solveKnapsack(items, 50);

    expect(result.strategyUsed).toBe('dp');
    expect(result.selectedItemIds.has('item-2')).toBe(true);
    expect(result.selectedItemIds.has('item-3')).toBe(true);
    expect(result.selectedItemIds.has('item-1')).toBe(false);
    expect(result.totalWeight).toBe(50);
    expect(result.totalValue).toBe(70);
  });

  it('solves knapsack using Greedy Density algorithm for large capacities', () => {
    const candidates: KnapsackItem[] = Array.from({ length: 110 }, (_, i) => ({
      id: `candidate-${i}`,
      itemId: `candidate-${i}`,
      weight: 100,
      value: (i % 10) * 10 + 10,
      isPinned: false,
      kind: 'file' as const,
    }));

    const result = solve01Knapsack(candidates, 500);

    expect(result.strategyUsed).toBe('greedy_density');
    expect(result.selectedItemIds.size).toBe(5);
    expect(result.totalWeight).toBe(500);
  });

  it('reserves pinned items unconditionally and optimizes residual capacity', () => {
    const items: KnapsackItem[] = [
      { id: 'sys-prompt', itemId: 'sys-prompt', weight: 100, value: 100, isPinned: true, kind: 'prompt' },
      { id: 'opt-1', itemId: 'opt-1', weight: 80, value: 90, isPinned: false, kind: 'file' },
      { id: 'opt-2', itemId: 'opt-2', weight: 40, value: 50, isPinned: false, kind: 'file' },
    ];

    // Max tokens 150 -> pinned sys-prompt (100) consumes 100 tokens, residual capacity is 50.
    // opt-2 (40) fits, opt-1 (80) does not.
    const result = solve01Knapsack(items, 150);

    expect(result.selectedItemIds.has('sys-prompt')).toBe(true);
    expect(result.selectedItemIds.has('opt-2')).toBe(true);
    expect(result.selectedItemIds.has('opt-1')).toBe(false);
    expect(result.pinnedWeight).toBe(100);
    expect(result.candidateWeight).toBe(40);
    expect(result.totalWeight).toBe(140);
    expect(result.overflowTokens).toBe(0);
  });

  it('selects topology_knapsack optimization mode in planner when maxInputTokens is active', () => {
    const bundle = createContextBundle('test context content', 'text');
    const budget = createOptimizationBudget({ maxInputTokens: 1000, riskTolerance: 'low' });
    const config: ResolvedConfig = {
      appName: 'TokenDamper',
      appVersion: '0.1.0',
      appMode: 'optimize',
      traceOutput: 'stderr',
      planner: { defaultMode: 'pass_through' },
      budget,
      validation: { minimumConfidence: 1 },
      logging: { level: 'info' },
    };

    const optimizationPlan = plan(bundle, budget, config, []);

    expect(optimizationPlan.mode).toBe('topology_knapsack');
    expect(optimizationPlan.stageIds).toContain('pruning:topology-pruner');
  });
});
