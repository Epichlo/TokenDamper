import type { ContextItem, OptimizationBudget } from '../model/types';
import type { TopologyScoreMap } from '../topology/topology-scorer';
import type { KnapsackItem } from './knapsack';

export interface CacheAwareConfig {
  readonly provider: 'anthropic' | 'openai' | 'generic';
  readonly minCacheBlockTokens: number; // Default: 1024
  readonly prefixPinHorizonTokens: number; // Default: 1024
}

const DEFAULT_CACHE_CONFIG: CacheAwareConfig = {
  provider: 'generic',
  minCacheBlockTokens: 1024,
  prefixPinHorizonTokens: 1024,
};

const IMPERATIVE_KEYWORD_REGEX = /\b(MUST|NEVER|ONLY IF|DO NOT)\b/;

/**
 * Calculates estimated token count for a context item.
 */
function estimateItemTokens(item: ContextItem): number {
  return Math.max(1, Math.ceil(item.content.length / 4));
}

/**
 * Applies cache-aware prefix locking to context items before knapsack selection.
 * Returns an array of KnapsackItems with updated isPinned flags.
 */
export function applyCacheAwarePrefixLocking(
  items: ReadonlyArray<ContextItem>,
  scores: TopologyScoreMap,
  budget: OptimizationBudget,
  config?: Partial<CacheAwareConfig>,
): ReadonlyArray<KnapsackItem> {
  const mergedConfig: CacheAwareConfig = {
    ...DEFAULT_CACHE_CONFIG,
    ...config,
  };

  const preserveKinds = new Set(budget.preserveKinds || []);
  const result: KnapsackItem[] = [];

  let accumulatedPrefixTokens = 0;

  for (const item of items) {
    const weight = estimateItemTokens(item);
    const scoreObj = scores.get(item.id);
    const value = scoreObj ? scoreObj.score : 10.0;

    // Rule 1: System prompt pinning (role === 'system')
    const isSystemPrompt = item.role === 'system';

    // Rule 2: Preserved kinds matching budget.preserveKinds
    const isPreservedKind = preserveKinds.has(item.kind);

    // Rule 3: Constraint items
    const hasConstraints = scoreObj?.hasConstraints ?? IMPERATIVE_KEYWORD_REGEX.test(item.content);

    // Rule 4: Prefix horizon pinning (items in early sequence up to prefixPinHorizonTokens)
    let isPrefixHorizon = false;
    if (accumulatedPrefixTokens < mergedConfig.prefixPinHorizonTokens) {
      isPrefixHorizon = true;
      accumulatedPrefixTokens += weight;
    }

    // Determine final isPinned flag
    const isPinned = isSystemPrompt || isPreservedKind || hasConstraints || isPrefixHorizon;

    result.push({
      id: item.id,
      itemId: item.id,
      weight,
      value,
      isPinned,
      kind: item.kind,
    });
  }

  return Object.freeze(result);
}

/**
 * Helper function returning the set of item IDs that are cache-pinned.
 */
export function getCachePinnedItemIds(
  items: ReadonlyArray<ContextItem>,
  scores: TopologyScoreMap,
  budget: OptimizationBudget,
  config?: Partial<CacheAwareConfig>,
): ReadonlySet<string> {
  const knapsackItems = applyCacheAwarePrefixLocking(items, scores, budget, config);
  const pinnedIds = new Set<string>();

  for (const item of knapsackItems) {
    if (item.isPinned) {
      pinnedIds.add(item.id);
    }
  }

  return pinnedIds;
}
