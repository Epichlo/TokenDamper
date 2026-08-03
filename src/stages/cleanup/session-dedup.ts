import type { ContextBundle, ContextItem, OptimizationBudget, StageResult } from '../../core/model/types';
import { createBundleStatistics, createContextItem, createStageResult, freeze, hashContent } from '../../core/model/constructors';
import { elideItem, type ElisionSkipReason } from '../../core/elision';
import { estimateBundleTokens } from '../../core/hashing/tokenizer';

export interface SessionDedupContext {
  readonly previousBlockHashes: ReadonlySet<string>;
  readonly storeContent?: ((hash: string, content: string) => void) | undefined;
  readonly getContent?: ((hashOrRef: string) => string | undefined) | undefined;
  readonly rehydrateRefs?: ReadonlySet<string> | undefined;
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

  const shouldAttemptDedup = Boolean(sessionContext && sessionContext.previousBlockHashes.size > 0);
  const shouldAttemptRehydration = Boolean(
    sessionContext?.getContent && sessionContext.rehydrateRefs && sessionContext.rehydrateRefs.size > 0,
  );

  if (!sessionContext || (!shouldAttemptDedup && !shouldAttemptRehydration)) {
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
  let itemsRehydrated = 0;
  let itemsSkipped = 0;
  let itemsElidedRecoverable = 0;
  let itemsElidedLossy = 0;
  let itemsPreservedAsReferent = 0;
  let bytesSaved = 0;
  const skipReasons: Record<ElisionSkipReason, number> = {
    no_savings: 0,
    post_condition_rejected: 0,
  };

  // How many times each content hash appears in this payload. Used to decide whether an
  // elision can be verified as recoverable — see the `recoverable` comment below.
  const totalOccurrences = new Map<string, number>();
  for (const item of bundle.items) {
    totalOccurrences.set(item.contentHash, (totalOccurrences.get(item.contentHash) ?? 0) + 1);
  }
  // Content hashes for which an intact copy has already been kept earlier in this payload.
  const survivingHashes = new Set<string>();

  const newItems: ContextItem[] = bundle.items.map((item) => {
    const rehydratedItem = maybeRehydrateItem(item, sessionContext);
    if (rehydratedItem) {
      changed = true;
      itemsRehydrated += 1;
      bytesSaved -= Math.max(0, rehydratedItem.content.length - item.content.length);
      survivingHashes.add(rehydratedItem.contentHash);
      return rehydratedItem;
    }

    // Rule 1: Never elide items matching preserveKinds in OptimizationBudget
    if (preserveKinds.has(item.kind)) {
      survivingHashes.add(item.contentHash);
      return item;
    }

    // Rule 2: Never elide system prompt items to maintain prompt-cache stability
    if (item.role === 'system') {
      survivingHashes.add(item.contentHash);
      return item;
    }

    // Check if this item content hash was seen in previous turns
    if (shouldAttemptDedup && sessionContext.previousBlockHashes.has(item.contentHash)) {
      // Rule 3: preserve the first copy of duplicated content, so the elisions that follow
      // it reference something demonstrably present in this same outbound payload.
      if (!survivingHashes.has(item.contentHash) && (totalOccurrences.get(item.contentHash) ?? 1) > 1) {
        survivingHashes.add(item.contentHash);
        itemsPreservedAsReferent += 1;
        return item;
      }

      const isRecoverable = survivingHashes.has(item.contentHash);
      const originalLength = item.content.length;
      const refId = item.contentHash.slice(0, 12);
      const elidedContent = `[TokenDamper Elided: ref=${refId} bytes=${originalLength} kind=${item.kind}]`;

      // Routed through the shared chokepoint: this marker is no more valid JSON than
      // `<BLOCK_HASH:...>` is. It only looked safe because the Gateway hardcoded
      // `contentType: 'text'`, which made `selectValidator` return null so nothing checked
      // it. A refusal skips the item and the stage continues (Issue 2).
      const outcome = elideItem({
        item,
        marker: elidedContent,
        contentHash: hashContent({ originalHash: item.contentHash, elidedContent }),
        metadata: {
          ...item.metadata,
          elided: true,
          // Set only when an intact copy of this content survives elsewhere in the SAME
          // outbound payload. That is the only form of the claim this stage can verify.
          //
          // The original rationale — "the session store can restore it, so the marker is a
          // pointer" — does not hold on the Gateway path. The consumer there is a stateless
          // provider API with no rehydration mechanism; content elided from the outbound
          // payload is not pointed at, it is deleted, and the model cannot resolve the
          // marker by any means available to it. Cross-turn elision of a sole copy is
          // therefore lossy compression, not a reference, and DriftTracker must score it.
          //
          // When a copy does survive in this payload the claim is true and checkable: the
          // model has seen the content, in this request, so the marker resolves.
          recoverable: isRecoverable,
          originalContentHash: item.contentHash,
          originalBytes: originalLength,
        },
      });

      if (outcome.status === 'skipped') {
        itemsSkipped += 1;
        skipReasons[outcome.reason] += 1;
        return item;
      }

      changed = true;
      itemsDeduped += 1;
      if (isRecoverable) {
        itemsElidedRecoverable += 1;
      } else {
        itemsElidedLossy += 1;
      }
      bytesSaved += outcome.bytesSaved;
      sessionContext.storeContent?.(item.contentHash, item.content);

      return outcome.item;
    }

    survivingHashes.add(item.contentHash);
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
        itemsRehydrated: 0,
        itemsSkipped,
        skippedNoSavings: skipReasons.no_savings,
        skippedPostConditionRejected: skipReasons.post_condition_rejected,
        bytesSaved: 0,
        tokenEstimateSaved: 0,
      },
      notes:
        itemsSkipped > 0
          ? `No context blocks deduplicated; skipped ${itemsSkipped} (${skipReasons.post_condition_rejected} rejected by post-condition, ${skipReasons.no_savings} for no savings).`
          : 'No matching context blocks found for deduplication or rehydration.',
    });
  }

  const statistics = createBundleStatistics(newItems);
  const bundleHash = hashContent({
    source: bundle.source,
    items: newItems.map((entry) => entry.contentHash),
    statistics,
  });

  const rawCombined = newItems.map((i) => i.content).join('\n');
  const tokenEstimate = estimateBundleTokens(newItems);

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

  // Derived from the two bundle estimates rather than from `ceil(bytesSaved / 4)`, so the
  // saving is expressed in the same unit as the numbers it is subtracted from. The byte
  // form was a third estimator and could disagree in sign with the bundle totals.
  const tokenEstimateSaved = Math.max(0, bundle.summary.tokenEstimate - tokenEstimate);

  return createStageResult({
    stageId,
    status: 'ok',
    bundle: newBundle,
    changed: true,
    metrics: {
      itemsDeduped,
      itemsRehydrated,
      itemsSkipped,
      itemsElidedRecoverable,
      itemsElidedLossy,
      itemsPreservedAsReferent,
      skippedNoSavings: skipReasons.no_savings,
      skippedPostConditionRejected: skipReasons.post_condition_rejected,
      bytesSaved,
      tokenEstimateSaved,
    },
    notes: `Elided ${itemsDeduped} context item(s) — ${itemsElidedRecoverable} recoverable (a copy survives in this payload), ${itemsElidedLossy} lossy (sole copy, scored by drift); preserved ${itemsPreservedAsReferent} as referent; rehydrated ${itemsRehydrated}; skipped ${itemsSkipped}.`,
  });
}

function maybeRehydrateItem(item: ContextItem, sessionContext: SessionDedupContext): ContextItem | undefined {
  if (!sessionContext.getContent || !sessionContext.rehydrateRefs || sessionContext.rehydrateRefs.size === 0) {
    return undefined;
  }

  const requestedRefs = new Set([...sessionContext.rehydrateRefs].map((ref) => normalizeSessionRef(ref)));
  const originalContentHash = typeof item.metadata.originalContentHash === 'string' ? item.metadata.originalContentHash : undefined;
  const elisionRef = extractElisionRef(item.content);
  const candidates = [originalContentHash, elisionRef, item.contentHash, item.content]
    .filter((candidate): candidate is string => Boolean(candidate))
    .map((candidate) => normalizeSessionRef(candidate));

  if (!candidates.some((candidate) => requestedRefs.has(candidate))) {
    return undefined;
  }

  const lookupRef = originalContentHash ?? elisionRef ?? item.contentHash;
  const rehydratedContent = sessionContext.getContent(lookupRef);
  if (rehydratedContent === undefined) {
    return undefined;
  }

  return createContextItem({
    id: item.id,
    kind: item.kind,
    contentType: item.contentType,
    content: rehydratedContent,
    origin: item.origin,
    contentHash: originalContentHash ?? hashContent({ rehydratedContent }),
    ...(item.role ? { role: item.role } : {}),
    ...(item.path ? { path: item.path } : {}),
    ...(item.language ? { language: item.language } : {}),
    metadata: freeze({
      ...item.metadata,
      elided: false,
      rehydrated: true,
      ...(originalContentHash ? { originalContentHash } : {}),
    }),
  });
}

function extractElisionRef(content: string): string | undefined {
  return /\bref=([A-Za-z0-9_-]+)/.exec(content)?.[1];
}

function normalizeSessionRef(ref: string): string {
  return extractElisionRef(ref) ?? ref.trim();
}
