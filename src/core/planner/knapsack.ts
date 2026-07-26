import type { ContextItemKind } from '../model/types';

export interface KnapsackItem {
  readonly id: string;
  readonly itemId: string;
  readonly weight: number; // Token estimate
  readonly value: number; // Relevance score V_i
  readonly isPinned: boolean;
  readonly kind: ContextItemKind;
}

export interface KnapsackResult {
  readonly selectedItemIds: ReadonlySet<string>;
  readonly totalWeight: number;
  readonly totalValue: number;
  readonly pinnedWeight: number;
  readonly candidateWeight: number;
  readonly overflowTokens: number;
  readonly strategyUsed: 'dp' | 'greedy_density' | 'pass_through';
}

/**
 * Solves 0/1 Knapsack optimization using Dynamic Programming.
 */
function solveKnapsackDP(
  candidates: ReadonlyArray<KnapsackItem>,
  capacity: number,
): ReadonlyArray<KnapsackItem> {
  const N = candidates.length;
  const W = Math.floor(capacity);
  if (N === 0 || W <= 0) return [];

  const dp = new Float64Array(W + 1);
  const bitset = new Uint8Array(Math.ceil((N * (W + 1)) / 8));

  for (let i = 0; i < N; i++) {
    const item = candidates[i];
    if (!item) continue;
    const w = Math.ceil(item.weight);
    const v = item.value;

    for (let cap = W; cap >= w; cap--) {
      const take = dp[cap - w]! + v;
      const skip = dp[cap]!;
      if (take > skip) {
        dp[cap] = take;
        const bitIdx = i * (W + 1) + cap;
        bitset[bitIdx >> 3]! |= 1 << (bitIdx & 7);
      }
    }
  }

  let cap = W;
  const selected: KnapsackItem[] = [];
  for (let i = N - 1; i >= 0; i--) {
    const bitIdx = i * (W + 1) + cap;
    if ((bitset[bitIdx >> 3]! & (1 << (bitIdx & 7))) !== 0) {
      const item = candidates[i];
      if (item) {
        selected.push(item);
        cap -= Math.ceil(item.weight);
      }
    }
  }

  return selected;
}

/**
 * Solves 0/1 Knapsack optimization using Density Greedy algorithm with swap check.
 */
function solveKnapsackGreedy(
  candidates: ReadonlyArray<KnapsackItem>,
  capacity: number,
): ReadonlyArray<KnapsackItem> {
  if (candidates.length === 0 || capacity <= 0) return [];

  // Sort candidates by density (value / weight) descending
  const sorted = [...candidates].sort((a, b) => {
    const ratioA = a.value / Math.max(1, a.weight);
    const ratioB = b.value / Math.max(1, b.weight);
    if (Math.abs(ratioA - ratioB) > 1e-9) {
      return ratioB - ratioA;
    }
    return b.value - a.value;
  });

  const selected: KnapsackItem[] = [];
  let currentWeight = 0;
  let currentValue = 0;

  for (const item of sorted) {
    if (currentWeight + item.weight <= capacity) {
      selected.push(item);
      currentWeight += item.weight;
      currentValue += item.value;
    }
  }

  // Branch & Bound heuristic check: compare with best single item that fits
  let bestSingleItem: KnapsackItem | null = null;
  for (const item of candidates) {
    if (item.weight <= capacity) {
      if (!bestSingleItem || item.value > bestSingleItem.value) {
        bestSingleItem = item;
      }
    }
  }

  if (bestSingleItem && bestSingleItem.value > currentValue) {
    return [bestSingleItem];
  }

  return selected;
}

/**
 * Solves the 0/1 Knapsack problem for context items under a maximum token budget.
 */
export function solve01Knapsack(
  items: ReadonlyArray<KnapsackItem>,
  maxTokens: number,
): KnapsackResult {
  const pinnedItems: KnapsackItem[] = [];
  const candidateItems: KnapsackItem[] = [];
  let totalItemWeight = 0;

  for (const item of items) {
    totalItemWeight += item.weight;
    if (item.isPinned) {
      pinnedItems.push(item);
    } else {
      candidateItems.push(item);
    }
  }

  const pinnedWeight = pinnedItems.reduce((acc, i) => acc + i.weight, 0);
  const pinnedValue = pinnedItems.reduce((acc, i) => acc + i.value, 0);

  // Case 1: Pass-through if total weight fits in maxTokens
  if (totalItemWeight <= maxTokens) {
    const selectedIds = new Set(items.map((i) => i.id));
    const totalValue = items.reduce((acc, i) => acc + i.value, 0);
    return {
      selectedItemIds: selectedIds,
      totalWeight: totalItemWeight,
      totalValue,
      pinnedWeight,
      candidateWeight: totalItemWeight - pinnedWeight,
      overflowTokens: 0,
      strategyUsed: 'pass_through',
    };
  }

  const residualCapacity = Math.max(0, maxTokens - pinnedWeight);

  let selectedCandidates: ReadonlyArray<KnapsackItem> = [];
  let strategyUsed: 'dp' | 'greedy_density' = 'dp';

  // Strategy selection
  if (candidateItems.length <= 100 && residualCapacity <= 10000) {
    strategyUsed = 'dp';
    selectedCandidates = solveKnapsackDP(candidateItems, residualCapacity);
  } else {
    strategyUsed = 'greedy_density';
    selectedCandidates = solveKnapsackGreedy(candidateItems, residualCapacity);
  }

  const selectedItemIds = new Set<string>();
  for (const item of pinnedItems) {
    selectedItemIds.add(item.id);
  }
  for (const item of selectedCandidates) {
    selectedItemIds.add(item.id);
  }

  const candidateWeight = selectedCandidates.reduce((acc, i) => acc + i.weight, 0);
  const candidateValue = selectedCandidates.reduce((acc, i) => acc + i.value, 0);
  const totalWeight = pinnedWeight + candidateWeight;
  const totalValue = pinnedValue + candidateValue;
  const overflowTokens = Math.max(0, totalWeight - maxTokens);

  return {
    selectedItemIds,
    totalWeight,
    totalValue,
    pinnedWeight,
    candidateWeight,
    overflowTokens,
    strategyUsed,
  };
}

/**
 * Alias for solve01Knapsack.
 */
export function solveKnapsack(
  items: ReadonlyArray<KnapsackItem>,
  maxTokens: number,
): KnapsackResult {
  return solve01Knapsack(items, maxTokens);
}
