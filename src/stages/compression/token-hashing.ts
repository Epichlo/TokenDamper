import type { ContextBundle, ContextItem, OptimizationBudget, StageResult } from '../../core/model/types';
import { createBundleStatistics, createStageResult, freeze, hashContent } from '../../core/model/constructors';
import { elideItem, elideRegions, selectElisionRegions, type ElisionSkipReason } from '../../core/elision';
import { TokenHasher } from '../../core/hashing/token-hasher';
import { DEFAULT_TOKENIZER, estimateBundleTokens, type TokenizerAdapter } from '../../core/hashing/tokenizer';

export interface TokenHashingStageOptions {
  readonly tokenHasher?: TokenHasher;
  readonly minContentLength?: number;
  readonly tokenizer?: TokenizerAdapter;
}

/**
 * Built-in compression stage: `compression:token-hashing`.
 * Converts eligible context items into reversible `<BLOCK_HASH:sha256>` placeholders.
 */
export function runTokenHashingStage(
  bundle: ContextBundle,
  budget: OptimizationBudget,
  options?: TokenHashingStageOptions,
): StageResult {
  const stageId = 'compression:token-hashing';
  const hasher = options?.tokenHasher ?? new TokenHasher();
  const minContentLength = options?.minContentLength ?? 40;
  const tokenizer = options?.tokenizer ?? DEFAULT_TOKENIZER;

  const preserveKinds = new Set(budget.preserveKinds);
  let changed = false;
  let itemsHashed = 0;
  let regionsHashed = 0;
  let itemsSkipped = 0;
  let bytesSaved = 0;
  const skipReasons: Record<ElisionSkipReason, number> = {
    no_savings: 0,
    post_condition_rejected: 0,
  };

  const newItems: ContextItem[] = bundle.items.map((item) => {
    // Rule 1: Never hash items matching preserveKinds in OptimizationBudget
    if (preserveKinds.has(item.kind)) {
      return item;
    }

    // Rule 2: Never hash system prompt items to preserve prompt-cache stability
    if (item.role === 'system') {
      return item;
    }

    // Rule 3: Skip items already elided
    if (item.metadata.elided) {
      return item;
    }

    // Rule 4: Skip short content where placeholder overhead yields no savings
    if (item.content.length < minContentLength) {
      return item;
    }

    const originalLength = item.content.length;

    // Rule 5: prefer sub-item granularity. Whole-item hashing replaces every byte, so every
    // symbol in a single-item code bundle dies at once, `R_AST` is a boolean and `S_k` pins
    // at 0.60 — over the gate, every time, structurally
    // (`docs/phase-1d-drift-investigation.md` §6). Eliding function bodies leaves the
    // declarations that carry the symbols, so drift has something fractional to grade.
    //
    // `selectElisionRegions` returns nothing for content it cannot segment safely — JSON,
    // prose, logs, truncated code with no complete body — and the whole-item path below
    // still handles those exactly as before.
    const regions = selectElisionRegions(item);
    if (regions.length > 0) {
      const regionOutcome = elideRegions({
        item,
        regions,
        markerFor: (regionText) => hasher.createBlockPlaceholder(regionText, { blockType: item.kind }),
        contentHash: hashContent({ originalHash: item.contentHash, regions: regions.length }),
        metadata: {
          ...item.metadata,
          elided: true,
          tokenHashed: true,
          originalContentHash: item.contentHash,
          originalBytes: originalLength,
        },
      });

      if (regionOutcome.status === 'elided') {
        changed = true;
        itemsHashed += 1;
        regionsHashed += regions.length;
        bytesSaved += regionOutcome.bytesSaved;
        return regionOutcome.item;
      }

      itemsSkipped += 1;
      skipReasons[regionOutcome.reason] += 1;
      return item;
    }

    const placeholder = hasher.createBlockPlaceholder(item.content, { blockType: item.kind });

    const match = /^<BLOCK_HASH:([^>]+)>$/.exec(placeholder);
    const blockHash: string = match && match[1] ? match[1] : item.contentHash;

    // Rule 6: content-type correctness is enforced by the chokepoint, not here. It renders
    // the placeholder in a syntax valid for this item and refuses to return anything its
    // own validator rejects, so a bare `<BLOCK_HASH:...>` can no longer be written into
    // JSON content (Issue 2). A refusal skips the item and the stage continues.
    const outcome = elideItem({
      item,
      marker: placeholder,
      contentHash: hashContent({ originalHash: item.contentHash, placeholder }),
      metadata: {
        ...item.metadata,
        elided: true,
        tokenHashed: true,
        blockHash,
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
    itemsHashed += 1;
    bytesSaved += outcome.bytesSaved;

    return outcome.item;
  });

  if (!changed) {
    return createStageResult({
      stageId,
      status: 'ok',
      bundle,
      changed: false,
      metrics: {
        itemsHashed: 0,
        itemsSkipped,
        skippedNoSavings: skipReasons.no_savings,
        skippedPostConditionRejected: skipReasons.post_condition_rejected,
        bytesSaved: 0,
        tokenEstimateSaved: 0,
      },
      notes:
        itemsSkipped > 0
          ? `No context items eligible for token hashing; skipped ${itemsSkipped} (${skipReasons.post_condition_rejected} rejected by post-condition, ${skipReasons.no_savings} for no savings).`
          : 'No context items eligible for token hashing.',
    });
  }

  const statistics = createBundleStatistics(newItems);
  const bundleHash = hashContent({
    source: bundle.source,
    items: newItems.map((entry) => entry.contentHash),
    statistics,
  });

  const rawCombined = newItems.map((i) => i.content).join('\n');
  const tokenEstimate = estimateBundleTokens(newItems, tokenizer);

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

  const tokenEstimateSaved = Math.max(0, bundle.summary.tokenEstimate - tokenEstimate);

  return createStageResult({
    stageId,
    status: 'ok',
    bundle: newBundle,
    changed: true,
    metrics: {
      itemsHashed,
      regionsHashed,
      itemsSkipped,
      skippedNoSavings: skipReasons.no_savings,
      skippedPostConditionRejected: skipReasons.post_condition_rejected,
      bytesSaved,
      tokenEstimateSaved,
    },
    notes: `Successfully token-hashed ${itemsHashed} context item(s) (${regionsHashed} sub-item region(s)); skipped ${itemsSkipped} (${skipReasons.post_condition_rejected} rejected by post-condition, ${skipReasons.no_savings} for no savings).`,
  });
}
