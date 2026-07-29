import type { ContextBundle, ContextItem, OptimizationBudget, StageResult } from '../../core/model/types';
import { createBundleStatistics, createContextItem, createStageResult, freeze, hashContent } from '../../core/model/constructors';
import { TokenHasher } from '../../core/hashing/token-hasher';
import EnhancedHeuristicTokenizer, { type TokenizerAdapter } from '../../core/hashing/tokenizer';

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
  const tokenizer = options?.tokenizer ?? new EnhancedHeuristicTokenizer();

  const preserveKinds = new Set(budget.preserveKinds);
  let changed = false;
  let itemsHashed = 0;
  let bytesSaved = 0;

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

    const placeholder = hasher.createBlockPlaceholder(item.content, { blockType: item.kind });
    const originalLength = item.content.length;

    // Skip if placeholder is not shorter than raw content
    if (placeholder.length >= originalLength) {
      return item;
    }

    changed = true;
    itemsHashed += 1;
    bytesSaved += originalLength - placeholder.length;

    const match = /^<BLOCK_HASH:([^>]+)>$/.exec(placeholder);
    const blockHash: string = match && match[1] ? match[1] : item.contentHash;

    const newContentHash = hashContent({
      originalHash: item.contentHash,
      placeholder,
    });

    return createContextItem({
      id: item.id,
      kind: item.kind,
      contentType: item.contentType,
      content: placeholder,
      origin: item.origin,
      contentHash: newContentHash,
      ...(item.role ? { role: item.role } : {}),
      ...(item.path ? { path: item.path } : {}),
      ...(item.language ? { language: item.language } : {}),
      metadata: freeze({
        ...item.metadata,
        elided: true,
        tokenHashed: true,
        blockHash,
        originalContentHash: item.contentHash,
        originalBytes: originalLength,
      }),
    });
  });

  if (!changed) {
    return createStageResult({
      stageId,
      status: 'ok',
      bundle,
      changed: false,
      metrics: {
        itemsHashed: 0,
        bytesSaved: 0,
        tokenEstimateSaved: 0,
      },
      notes: 'No context items eligible for token hashing.',
    });
  }

  const statistics = createBundleStatistics(newItems);
  const bundleHash = hashContent({
    source: bundle.source,
    items: newItems.map((entry) => entry.contentHash),
    statistics,
  });

  const rawCombined = newItems.map((i) => i.content).join('\n');
  const tokenEstimate = Math.max(1, tokenizer.countTokens(rawCombined));

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
      bytesSaved,
      tokenEstimateSaved,
    },
    notes: `Successfully token-hashed ${itemsHashed} context item(s).`,
  });
}
