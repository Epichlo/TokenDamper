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

  describe('mathematical identity & exact item selections', () => {
    it('selects optimal combination matching mathematical knapsack solution', () => {
      const items: KnapsackItem[] = [
        { id: 'item-A', itemId: 'item-A', weight: 10, value: 60, isPinned: false, kind: 'file' },
        { id: 'item-B', itemId: 'item-B', weight: 20, value: 100, isPinned: false, kind: 'file' },
        { id: 'item-C', itemId: 'item-C', weight: 30, value: 120, isPinned: false, kind: 'file' },
      ];

      // Capacity 50: B (20, 100) + C (30, 120) = weight 50, value 220
      // A (10, 60) + C (30, 120) = weight 40, value 180
      // A (10, 60) + B (20, 100) = weight 30, value 160
      const result = solve01Knapsack(items, 50);

      expect(result.strategyUsed).toBe('dp');
      expect(result.selectedItemIds.has('item-B')).toBe(true);
      expect(result.selectedItemIds.has('item-C')).toBe(true);
      expect(result.selectedItemIds.has('item-A')).toBe(false);
      expect(result.totalWeight).toBe(50);
      expect(result.totalValue).toBe(220);
    });

    it('handles tie-breaking deterministically when multiple items have identical values/weights', () => {
      const items: KnapsackItem[] = [
        { id: 'dup-1', itemId: 'dup-1', weight: 10, value: 50, isPinned: false, kind: 'file' },
        { id: 'dup-2', itemId: 'dup-2', weight: 10, value: 50, isPinned: false, kind: 'file' },
      ];

      // Capacity 10 -> exactly one item fits
      const result = solve01Knapsack(items, 10);

      expect(result.strategyUsed).toBe('dp');
      expect(result.selectedItemIds.size).toBe(1);
      expect(result.totalWeight).toBe(10);
      expect(result.totalValue).toBe(50);
    });

    it('applies Math.ceil to fractional item weights correctly', () => {
      const items: KnapsackItem[] = [
        { id: 'frac-1', itemId: 'frac-1', weight: 10.1, value: 30, isPinned: false, kind: 'file' }, // ceil => 11
        { id: 'frac-2', itemId: 'frac-2', weight: 10.9, value: 40, isPinned: false, kind: 'file' }, // ceil => 11
        { id: 'frac-3', itemId: 'frac-3', weight: 10.0, value: 20, isPinned: false, kind: 'file' }, // ceil => 10
      ];

      // Capacity 21:
      // frac-1 (11) + frac-2 (11) = 22 > 21 (does not fit)
      // frac-2 (11) + frac-3 (10) = 21 <= 21 (fits, value 60)
      // frac-1 (11) + frac-3 (10) = 21 <= 21 (fits, value 50)
      const result = solve01Knapsack(items, 21);

      expect(result.strategyUsed).toBe('dp');
      expect(result.selectedItemIds.has('frac-2')).toBe(true);
      expect(result.selectedItemIds.has('frac-3')).toBe(true);
      expect(result.selectedItemIds.has('frac-1')).toBe(false);
      expect(result.totalValue).toBe(60);
      expect(result.totalWeight).toBe(20.9); // exact float weights 10.9 + 10.0
    });

    it('handles zero-weight candidate items without infinite loops or invalid indices', () => {
      const items: KnapsackItem[] = [
        { id: 'zero-1', itemId: 'zero-1', weight: 0, value: 50, isPinned: false, kind: 'file' },
        { id: 'zero-2', itemId: 'zero-2', weight: 0, value: 30, isPinned: false, kind: 'file' },
        { id: 'norm-1', itemId: 'norm-1', weight: 20, value: 40, isPinned: false, kind: 'file' },
      ];

      // Capacity 15 -> zero-1 (0, 50) and zero-2 (0, 30) fit, norm-1 (20) exceeds capacity
      const result = solve01Knapsack(items, 15);

      expect(result.strategyUsed).toBe('dp');
      expect(result.selectedItemIds.has('zero-1')).toBe(true);
      expect(result.selectedItemIds.has('zero-2')).toBe(true);
      expect(result.selectedItemIds.has('norm-1')).toBe(false);
      expect(result.totalValue).toBe(80);
      expect(result.totalWeight).toBe(0);
    });
  });

  describe('boundary limits & fallback gating', () => {
    it('executes DP solver at exact maximum limits (N=100, W=10000)', () => {
      const items: KnapsackItem[] = Array.from({ length: 100 }, (_, i) => ({
        id: `limit-item-${i}`,
        itemId: `limit-item-${i}`,
        weight: 150,
        value: i + 1,
        isPinned: false,
        kind: 'file',
      }));

      // Total weight = 15,000 > maxTokens = 10,000 -> triggers DP
      const result = solve01Knapsack(items, 10000);

      expect(result.strategyUsed).toBe('dp');
      expect(result.selectedItemIds.size).toBe(66);
      expect(result.totalWeight).toBe(9900); // 66 * 150
    });

    it('falls back to greedy_density when N > 100', () => {
      const items: KnapsackItem[] = Array.from({ length: 101 }, (_, i) => ({
        id: `item-${i}`,
        itemId: `item-${i}`,
        weight: 10,
        value: 20,
        isPinned: false,
        kind: 'file',
      }));

      // Total weight = 1,010 > maxTokens = 500 -> triggers fallback greedy_density because N = 101 > 100
      const result = solve01Knapsack(items, 500);

      expect(result.strategyUsed).toBe('greedy_density');
    });

    it('falls back to greedy_density when residual capacity > 10000', () => {
      const items: KnapsackItem[] = [
        { id: 'item-1', itemId: 'item-1', weight: 15000, value: 100, isPinned: false, kind: 'file' },
      ];

      // Total weight = 15,000 > maxTokens = 10,001 -> triggers fallback greedy_density because residual capacity = 10001 > 10000
      const result = solve01Knapsack(items, 10001);

      expect(result.strategyUsed).toBe('greedy_density');
    });
  });

  describe('fuzz testing vs brute force reference', () => {
    function solveBruteForce(
      candidates: ReadonlyArray<KnapsackItem>,
      capacity: number,
    ): { bestValue: number; bestWeight: number; bestSet: Set<string> } {
      const N = candidates.length;
      let bestValue = 0;
      let bestWeight = 0;
      let bestSet = new Set<string>();

      const totalCombos = 1 << N;
      for (let mask = 0; mask < totalCombos; mask++) {
        let weight = 0;
        let value = 0;
        const set = new Set<string>();

        for (let i = 0; i < N; i++) {
          if ((mask & (1 << i)) !== 0) {
            const item = candidates[i]!;
            weight += Math.ceil(item.weight);
            value += item.value;
            set.add(item.id);
          }
        }

        if (weight <= capacity) {
          if (value > bestValue) {
            bestValue = value;
            bestWeight = weight;
            bestSet = set;
          }
        }
      }

      return { bestValue, bestWeight, bestSet };
    }

    it('produces optimal total value across 20 randomized knapsack instances', () => {
      // Deterministic pseudo-random generator seed for reproducible fuzzing
      let seed = 123456789;
      function pseudoRandom() {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      }

      for (let run = 0; run < 20; run++) {
        const N = 15;
        const candidates: KnapsackItem[] = Array.from({ length: N }, (_, i) => ({
          id: `fuzz-${run}-${i}`,
          itemId: `fuzz-${run}-${i}`,
          weight: Math.floor(pseudoRandom() * 25) + 1,
          value: Math.floor(pseudoRandom() * 100) + 1,
          isPinned: false,
          kind: 'file',
        }));

        const capacity = Math.floor(pseudoRandom() * 100) + 20;

        const dpResult = solve01Knapsack(candidates, capacity);
        const refResult = solveBruteForce(candidates, capacity);

        expect(dpResult.strategyUsed).toBe('dp');
        expect(dpResult.totalValue).toBe(refResult.bestValue);
        expect(dpResult.totalWeight).toBeLessThanOrEqual(capacity);

        // Verify selected items sum up to totalValue and totalWeight
        let reconstructedValue = 0;
        let reconstructedWeight = 0;
        for (const item of candidates) {
          if (dpResult.selectedItemIds.has(item.id)) {
            reconstructedValue += item.value;
            reconstructedWeight += item.weight;
          }
        }
        expect(reconstructedValue).toBe(refResult.bestValue);
        expect(reconstructedWeight).toBe(dpResult.totalWeight);
      }
    });
  });
});
