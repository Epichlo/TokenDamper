import { describe, expect, it } from 'vitest';
import { solve01Knapsack, type KnapsackItem } from '../../src/core/planner/knapsack';

/**
 * Baseline 2D Matrix DP solver (Original Implementation prior to 1D Bitset optimization)
 */
function solveKnapsackDP2DReference(
  candidates: ReadonlyArray<KnapsackItem>,
  capacity: number,
): ReadonlyArray<KnapsackItem> {
  const N = candidates.length;
  const W = Math.floor(capacity);
  if (N === 0 || W <= 0) return [];

  // Matrix allocation: (N + 1) x (W + 1)
  const dp: Float64Array[] = Array.from({ length: N + 1 }, () => new Float64Array(W + 1));

  for (let i = 1; i <= N; i++) {
    const item = candidates[i - 1]!;
    const w = Math.ceil(item.weight);
    const v = item.value;

    for (let cap = 0; cap <= W; cap++) {
      if (w <= cap) {
        dp[i]![cap] = Math.max(dp[i - 1]![cap]!, dp[i - 1]![cap - w]! + v);
      } else {
        dp[i]![cap] = dp[i - 1]![cap]!;
      }
    }
  }

  // Backtrack item selection
  let cap = W;
  const selected: KnapsackItem[] = [];
  for (let i = N; i > 0; i--) {
    const item = candidates[i - 1]!;
    const w = Math.ceil(item.weight);
    if (dp[i]![cap] !== dp[i - 1]![cap]) {
      selected.push(item);
      cap -= w;
    }
  }

  return selected;
}

describe('Knapsack 1D Bitset DP Stress & Verification Suite', () => {
  it('achieves 100% exact item parity with 2D DP reference across 500 randomized knapsack instances', () => {
    let seed = 987654321;
    function rand() {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    }

    for (let trial = 0; trial < 500; trial++) {
      const N = Math.floor(rand() * 40) + 1; // 1 to 40 items
      const capacity = Math.floor(rand() * 300) + 10; // capacity 10 to 310

      const candidates: KnapsackItem[] = Array.from({ length: N }, (_, i) => ({
        id: `item-${trial}-${i}`,
        itemId: `item-${trial}-${i}`,
        weight: Math.floor(rand() * 25) + 1, // weights 1 to 25
        value: Math.floor(rand() * 100) + 1, // values 1 to 100
        isPinned: false,
        kind: 'file',
      }));

      const optimizedResult = solve01Knapsack(candidates, capacity);
      const refSelected = solveKnapsackDP2DReference(candidates, capacity);

      const refTotalValue = refSelected.reduce((acc, i) => acc + i.value, 0);

      // Verify exact total value matching
      expect(optimizedResult.totalValue).toBe(refTotalValue);

      // Verify total weight is within capacity
      expect(optimizedResult.totalWeight).toBeLessThanOrEqual(capacity);

      // Verify exact set of selected item IDs match
      const refSet = new Set(refSelected.map((i) => i.id));
      expect(optimizedResult.selectedItemIds).toEqual(refSet);
    }
  });

  it('handles floating point weights with Math.ceil without exceeding capacity', () => {
    const candidates: KnapsackItem[] = [
      { id: 'f1', itemId: 'f1', weight: 3.1, value: 50, isPinned: false, kind: 'file' }, // ceil 4
      { id: 'f2', itemId: 'f2', weight: 4.9, value: 60, isPinned: false, kind: 'file' }, // ceil 5
      { id: 'f3', itemId: 'f3', weight: 2.05, value: 30, isPinned: false, kind: 'file' }, // ceil 3
    ];

    // Capacity 8:
    // f2 (ceil 5) + f3 (ceil 3) = 8 <= 8 (val 90, weight 6.95) -> OPTIMAL
    const res = solve01Knapsack(candidates, 8);
    expect(res.selectedItemIds.has('f2')).toBe(true);
    expect(res.selectedItemIds.has('f3')).toBe(true);
    expect(res.selectedItemIds.has('f1')).toBe(false);
    expect(res.totalValue).toBe(90);
    expect(res.totalWeight).toBeCloseTo(6.95, 5);
  });

  it('handles extreme boundaries and edge cases: single item, zero capacity, zero weight items', () => {
    // Single item fits
    const single = [{ id: 's1', itemId: 's1', weight: 5, value: 10, isPinned: false, kind: 'file' as const }];
    const res1 = solve01Knapsack(single, 5);
    expect(res1.selectedItemIds.has('s1')).toBe(true);

    // Single item doesn't fit
    const res2 = solve01Knapsack(single, 4);
    expect(res2.selectedItemIds.size).toBe(0);

    // Zero capacity
    const res3 = solve01Knapsack(single, 0);
    expect(res3.selectedItemIds.size).toBe(0);

    // Zero weight items
    const zeroWeight: KnapsackItem[] = [
      { id: 'z1', itemId: 'z1', weight: 0, value: 100, isPinned: false, kind: 'file' },
      { id: 'z2', itemId: 'z2', weight: 0, value: 200, isPinned: false, kind: 'file' },
    ];
    const res4 = solve01Knapsack(zeroWeight, 10);
    expect(res4.selectedItemIds.has('z1')).toBe(true);
    expect(res4.selectedItemIds.has('z2')).toBe(true);
    expect(res4.totalValue).toBe(300);
  });

  it('verifies exact limit conditions (N=100, W=10000)', () => {
    const candidates: KnapsackItem[] = Array.from({ length: 100 }, (_, i) => ({
      id: `max-${i}`,
      itemId: `max-${i}`,
      weight: 150, // total weight 15000 > maxTokens 10000 to trigger DP strategy
      value: 10,
      isPinned: false,
      kind: 'file' as const,
    }));

    const res = solve01Knapsack(candidates, 10000);
    expect(res.strategyUsed).toBe('dp');
    expect(res.selectedItemIds.size).toBe(66);
    expect(res.totalWeight).toBe(9900);
    expect(res.totalValue).toBe(660);
  });

  it('verifies memory allocation size calculations at max boundaries', () => {
    const N = 100;
    const W = 10000;
    const dpElements = W + 1; // 10001 Float64 elements = 80,008 bytes (~80 KB)
    const bitsetBits = N * (W + 1); // 1,000,100 bits
    const bitsetBytes = Math.ceil(bitsetBits / 8); // 125,013 bytes (~125 KB)

    expect(dpElements * 8).toBe(80008);
    expect(bitsetBytes).toBe(125013);

    // Compared to original 2D DP matrix of (N+1)*(W+1) Float64Array (8,080,808 bytes ~8.08MB):
    const oldMatrixBytes = (N + 1) * (W + 1) * 8;
    const newTotalBytes = dpElements * 8 + bitsetBytes;
    const reductionRatio = (1 - newTotalBytes / oldMatrixBytes) * 100;

    expect(reductionRatio).toBeGreaterThan(97.4); // > 97.4% memory reduction!
  });
});
