import type { ContextBundle, ContextItem, OptimizationBudget, StageResult } from '../../core/model/types';
import { createBundleStatistics, createStageResult, freeze, hashContent } from '../../core/model/constructors';
import {
  describeContentType,
  elideItem,
  elideRegions,
  FUNCTION_BODY_NOUN,
  renderElisionMarker,
  selectElisionRegions,
  type ElisionSkipReason,
} from '../../core/elision';
import { DriftTracker } from '../../core/ledger/drift-tracker';
import { TokenHasher } from '../../core/hashing/token-hasher';
import { DEFAULT_TOKENIZER, estimateBundleTokens, type TokenizerAdapter } from '../../core/hashing/tokenizer';

/**
 * Whether drift would have symbols to score for this item.
 *
 * Uses `DriftTracker.extractSymbols` rather than a second extractor on purpose: the question
 * being asked is exactly "will the drift gate see symbols disappear here?", so asking any other
 * implementation would let the two answers diverge — which is DECISIONS §19's lesson about a
 * second token estimator, in a different place.
 */
function hasExtractableSymbols(item: ContextItem): boolean {
  const probe = { items: [item] } as unknown as ContextBundle;
  return new DriftTracker().extractSymbols(probe).size > 0;
}

export interface TokenHashingStageOptions {
  /**
   * The store that will retain the elided content, supplied by whoever can still reach it
   * later — an MCP session, a bench run. **Its absence is meaningful**: without it, the
   * content this stage removes is gone, and the marker must stand on its own.
   *
   * Do not default it. See the note on `runTokenHashingStage`.
   */
  readonly tokenHasher?: TokenHasher;
  readonly minContentLength?: number;
  readonly tokenizer?: TokenizerAdapter;
}

/**
 * Built-in compression stage: `compression:token-hashing`.
 *
 * Replaces content with `[TokenDamper: N <kind> lines elided, B bytes, sha256:…]` markers —
 * **reversibly only when the caller supplies a `tokenHasher` that outlives this call.**
 *
 * This used to read "converts eligible context items into reversible `<BLOCK_HASH:sha256>`
 * placeholders", and
 * line 23 used to be `options?.tokenHasher ?? new TokenHasher()`. That default made the
 * sentence true of the type and false of the CLI: the fabricated store registered every
 * elided block and was garbage-collected when the stage returned, so the markers in the
 * emitted output referred to content held by nothing, anywhere. Measured on `codebase.py`
 * through the real binary — 19 placeholders emitted, 0 resolvable by any store in the
 * process or out of it, and the engine's own `detectCorruptedPlaceholders` reported a clean
 * result because it is written `if (hash && hasher && !hasher.hasHash(hash))` and the CLI
 * passes no hasher.
 *
 * Reversibility on the CLI is not unimplemented, it is unachievable: the CLI is a one-shot
 * pipe with no session on either end, so there is nowhere for a store to live. The remedy is
 * not to manufacture one — that produces a mechanism that satisfies the sentence while the
 * reader is no better off. It is to stop claiming it, record it on the item
 * (`metadata.reversible`) and in the metrics (`irreversibleElisions`), and make the marker
 * itself carry what was removed.
 */
export function runTokenHashingStage(
  bundle: ContextBundle,
  budget: OptimizationBudget,
  options?: TokenHashingStageOptions,
): StageResult {
  const stageId = 'compression:token-hashing';
  const hasher = options?.tokenHasher;
  const reversible = hasher !== undefined;
  const minContentLength = options?.minContentLength ?? 40;
  const tokenizer = options?.tokenizer ?? DEFAULT_TOKENIZER;

  const preserveKinds = new Set(budget.preserveKinds);
  let changed = false;
  let itemsHashed = 0;
  let regionsHashed = 0;
  let itemsSkipped = 0;
  let bytesSaved = 0;
  let irreversibleElisions = 0;
  const skipReasons: Record<ElisionSkipReason, number> = {
    no_savings: 0,
    structured_content: 0,
    post_condition_rejected: 0,
  };

  /**
   * Builds the marker for one span and hands the span to the caller's store when there is
   * one. When there is not, nothing is registered — there is no store to register with, and
   * writing to a local one would only make the absence harder to see.
   *
   * The marker says what it replaced. It used to be `<BLOCK_HASH:` + the digest + `>`, which
   * on the CLI resolved to nothing and therefore told the reader nothing. Same byte budget
   * (see `ELISION_MARKER_BYTES`), and the digest is still in there — it is now a field rather
   * than the whole message.
   */
  const markerFor = (text: string, describes: string, blockType: string): string => {
    const blockHash = hashContent(text);
    if (hasher) {
      hasher.registerBlock(blockHash, text, { bytes: text.length, blockType });
    }
    return renderElisionMarker(text, describes, blockHash);
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
        markerFor: (regionText) => markerFor(regionText, FUNCTION_BODY_NOUN, item.kind),
        contentHash: hashContent({ originalHash: item.contentHash, regions: regions.length }),
        metadata: {
          ...item.metadata,
          elided: true,
          tokenHashed: true,
          reversible,
          originalContentHash: item.contentHash,
          originalBytes: originalLength,
        },
      });

      if (regionOutcome.status === 'elided') {
        changed = true;
        itemsHashed += 1;
        regionsHashed += regions.length;
        bytesSaved += regionOutcome.bytesSaved;
        if (!reversible) {
          irreversibleElisions += 1;
        }
        return regionOutcome.item;
      }

      itemsSkipped += 1;
      skipReasons[regionOutcome.reason] += 1;
      return item;
    }

    // Whole-item elision of a symbol-bearing item is refused downstream **every time**, so it is
    // not attempted — audit H5.
    //
    // Since DECISIONS §40, an unmeasured `R_struct` no longer contributes a free 0.40, so for a
    // code item `S_k = 1 - R_AST`. Destroying every symbol makes `R_AST = 0` and `S_k = 1.0`,
    // against a gate that fires above 0.40. There is no threshold, budget or flag under which
    // this elision survives validation; performing it only guarantees a fallback.
    //
    // On a one-item bundle that was invisible — the run fell back and emitted the input, which is
    // what skipping produces anyway, minus the wasted work. Multi-file ingestion made it matter:
    // validation is bundle-scoped, so a single unsegmentable-but-symbol-bearing file (a pure
    // `types.ts`, which has interfaces to lose and no function bodies to elide) took the whole
    // batch down with it. Measured on `src/core` at `maxInputTokens: 4000`, two such files were
    // destroying 100% of their symbols and forcing a fallback across all 16 retained items.
    //
    // Items with no symbols to lose are unaffected and still elided whole: JSON, prose, logs and
    // truncated code are exactly the population this path was written for, and `R_AST` has
    // nothing to score there. That case is governed by the measurement gate (§37) instead.
    if (hasExtractableSymbols(item)) {
      itemsSkipped += 1;
      skipReasons.no_savings += 1;
      return item;
    }

    const blockHash = hashContent(item.content);
    const placeholder = markerFor(item.content, describeContentType(item.contentType), item.kind);

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
        reversible,
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
    if (!reversible) {
      irreversibleElisions += 1;
    }

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
        skippedStructuredContent: skipReasons.structured_content,
        bytesSaved: 0,
        tokenEstimateSaved: 0,
        irreversibleElisions: 0,
      },
      notes:
        itemsSkipped > 0
          ? `No context items eligible for token hashing; skipped ${itemsSkipped} (${skipReasons.post_condition_rejected} rejected by post-condition, ${skipReasons.no_savings} for no savings, ${skipReasons.structured_content} for structured content).`
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
      skippedStructuredContent: skipReasons.structured_content,
      bytesSaved,
      tokenEstimateSaved,
      irreversibleElisions,
    },
    notes:
      `Successfully token-hashed ${itemsHashed} context item(s) (${regionsHashed} sub-item region(s)); ` +
      `skipped ${itemsSkipped} (${skipReasons.post_condition_rejected} rejected by post-condition, ${skipReasons.no_savings} for no savings, ${skipReasons.structured_content} for structured content).` +
      (irreversibleElisions > 0
        ? ` ${irreversibleElisions} elision(s) are irreversible: no token hasher was supplied, so the removed content is not retained anywhere.`
        : ''),
  });
}
