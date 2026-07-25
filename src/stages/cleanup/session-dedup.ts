import type { ContextBundle, ContextItem, OptimizationBudget, StageResult } from '../../core/model/types';
import { createBundleStatistics, createContextItem, createStageResult, freeze, hashContent } from '../../core/model/constructors';

export interface SessionDedupContext {
  readonly previousBlockHashes: ReadonlySet<string>;
}

/**
 * Built-in cleanup stage: `cleanup:session-dedup`.
 * Performs cross-turn session deduplication by replacing previously seen
 * context blocks with lightweight referential elision markers.
 */
export function runSessionDedupStage(
  bundle: ContextBundle,
  budget: OptimizationBudget,
  sessionContext?: SessionDedupContext,
): StageResult {
  const stageId = 'cleanup:session-dedup';

  if (!sessionContext || sessionContext.previousBlockHashes.size === 0) {
    return createStageResult({
      stageId,
      status: 'ok',
      bundle,
      changed: false,
      metrics: {
        itemsDeduped: 0,
        bytesSaved: 0,
        tokenEstimateSaved: 0,
      },
      notes: 'No previous session block hashes available for deduplication.',
    });
  }

  const preserveKinds = new Set(budget.preserveKinds);
  let changed = false;
  let itemsDeduped = 0;
  let bytesSaved = 0;

  const newItems: ContextItem[] = bundle.items.map((item) => {
    // Rule 1: Never elide items matching preserveKinds in OptimizationBudget
    if (preserveKinds.has(item.kind)) {
      return item;
    }

    // Rule 2: Never elide system prompt items to maintain prompt-cache stability
    if (item.role === 'system') {
      return item;
    }

    // Check if this item content hash was seen in previous turns
    if (sessionContext.previousBlockHashes.has(item.contentHash)) {
      const originalLength = item.content.length;
      const refId = item.contentHash.slice(0, 12);
      const elidedContent = `[TokenDamper Elided: ref=${refId} bytes=${originalLength} kind=${item.kind}]`;

      // If elision marker is actually longer than raw content, skip
      if (elidedContent.length >= originalLength) {
        return item;
      }

      changed = true;
      itemsDeduped += 1;
      bytesSaved += originalLength - elidedContent.length;

      const newContentHash = hashContent({
        originalHash: item.contentHash,
        elidedContent,
      });

      return createContextItem({
        id: item.id,
        kind: item.kind,
        contentType: item.contentType,
        content: elidedContent,
        origin: item.origin,
        contentHash: newContentHash,
        ...(item.role ? { role: item.role } : {}),
        ...(item.path ? { path: item.path } : {}),
        ...(item.language ? { language: item.language } : {}),
        metadata: freeze({
          ...item.metadata,
          elided: true,
          originalContentHash: item.contentHash,
          originalBytes: originalLength,
        }),
      });
    }

    return item;
  });

  if (!changed) {
    return createStageResult({
      stageId,
      status: 'ok',
      bundle,
      changed: false,
      metrics: {
        itemsDeduped: 0,
        bytesSaved: 0,
        tokenEstimateSaved: 0,
      },
      notes: 'No matching context blocks found from previous turns.',
    });
  }

  const statistics = createBundleStatistics(newItems);
  const bundleHash = hashContent({
    source: bundle.source,
    items: newItems.map((entry) => entry.contentHash),
    statistics,
  });

  const rawCombined = newItems.map((i) => i.content).join('\n');
  const tokenEstimate = Math.max(1, Math.ceil(rawCombined.length / 4));

  const newBundle: ContextBundle = freeze({
    id: bundleHash,
    bundleId: bundleHash,
    source: bundle.source,
    items: freeze(newItems),
    summary: freeze({
      itemCount: newItems.length,
      tokenEstimate,
      preview: rawCombined.slice(0, 80),
    }),
    statistics,
    contentHash: bundleHash,
  });

  const tokenEstimateSaved = Math.max(0, Math.ceil(bytesSaved / 4));

  return createStageResult({
    stageId,
    status: 'ok',
    bundle: newBundle,
    changed: true,
    metrics: {
      itemsDeduped,
      bytesSaved,
      tokenEstimateSaved,
    },
    notes: `Successfully elided ${itemsDeduped} context item(s) from previous turns.`,
  });
}
