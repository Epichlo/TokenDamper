import type { ContextBundle, ContextItem, OptimizationBudget, StageResult } from '../../core/model/types';
import { createBundleStatistics, createStageResult, freeze, hashContent } from '../../core/model/constructors';
import {
  describeContentType,
  elideItem,
  elideRegions,
  FUNCTION_BODY_NOUN,
  renderElisionMarker,
  selectElisionRegions,
  splitRegionIntoStatements,
  type ElisionSkipReason,
} from '../../core/elision';
import { ceilingReached, resolveTokenCeiling } from '../../core/budget';
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

  // The ceiling this run is aiming at, and a running estimate of where we are against it.
  //
  // This is what makes `--target-reduction-ratio` a *target* rather than a floor. Without it the
  // stage elides everything it can and stops only when it runs out of candidates: measured on a
  // single TypeScript file, `--target-reduction-ratio 0.3` produced **44.62%**. Overshooting is
  // not a bonus — each extra elision spends semantic fidelity, raises drift, and on the CLI is
  // irreversible because no `TokenHasher` is wired in. Removing half again as much as the caller
  // asked for is a defect.
  //
  // Tracked incrementally rather than re-estimating the whole bundle per item: `map` visits items
  // in array order, so the running total is deterministic (invariant 1), and re-estimating would
  // make this O(n²) on the bundles that need it most.
  const ceiling = resolveTokenCeiling(bundle, budget);
  let runningTokens = bundle.summary.tokenEstimate;
  let itemsLeftByCeiling = 0;

  const newItems: ContextItem[] = bundle.items.map((item) => {
    // Rule 0: stop once the target is met. Checked first, so an item left alone by the ceiling
    // is not also counted as skipped for some unrelated reason.
    if (ceilingReached(runningTokens, ceiling)) {
      itemsLeftByCeiling += 1;
      return item;
    }

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
    // (`docs/phase-1d-drift-investigation.md` §6). Eliding function bodies leaves the [retired]
    // declarations that carry the symbols, so drift has something fractional to grade.
    //
    // `selectElisionRegions` returns nothing for content it cannot segment safely — JSON,
    // prose, logs, truncated code with no complete body — and the whole-item path below
    // still handles those exactly as before.
    const allRegions = selectElisionRegions(item);
    // Trimmed to what the target actually needs.
    //
    // The item-level check above cannot bind on the commonest CLI shape: `optimize one-file.ts`
    // is a single-item bundle, so that check runs once, before anything has been elided, and the
    // item then has *all* of its regions removed in one call. Measured, that made the target
    // inert exactly where it is most used — 0.1, 0.3, 0.5 and 0.7 all produced **69.09%** on the
    // same file. The ceiling has to bind at the granularity the compression happens at.
    const regions = trimRegionsToCeiling(item, allRegions, runningTokens, ceiling, markerFor, tokenizer);
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
        runningTokens -= tokensFreed(item, regionOutcome.item, tokenizer);
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
    runningTokens -= tokensFreed(item, outcome.item, tokenizer);
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
      itemsLeftByCeiling,
      ...(ceiling === undefined ? {} : { tokenCeiling: ceiling }),
    },
    notes:
      `Successfully token-hashed ${itemsHashed} context item(s) (${regionsHashed} sub-item region(s)); ` +
      `skipped ${itemsSkipped} (${skipReasons.post_condition_rejected} rejected by post-condition, ${skipReasons.no_savings} for no savings, ${skipReasons.structured_content} for structured content).` +
      (itemsLeftByCeiling > 0
        ? ` Stopped at the ${ceiling}-token target with ${itemsLeftByCeiling} item(s) left untouched.`
        : '') +
      (irreversibleElisions > 0
        ? ` ${irreversibleElisions} elision(s) are irreversible: no token hasher was supplied, so the removed content is not retained anywhere.`
        : ''),
  });
}

/**
 * Tokens an elision actually freed, measured the same way the bundle total is.
 *
 * Deliberately **not** `bytesSaved / 4`. DECISIONS §19 records what happens when one quantity
 * gets two estimators: until `1b1e999` the input side went through the tokenizer while every
 * output side used `ceil(len / 4)`, and byte-identical output reported an 11–22% saving. The
 * running total here is compared against a ceiling derived from `bundle.summary.tokenEstimate`,
 * so it has to come from the same estimator or the comparison is between two different units
 * again — the same defect in a new place.
 *
 * Clamped at 0: an elision that grew the item is refused upstream by the chokepoint, so a
 * negative here would mean a bug elsewhere, and letting it inflate the running total would make
 * the stage elide *more* in response.
 */
function tokensFreed(before: ContextItem, after: ContextItem, tokenizer: TokenizerAdapter): number {
  return Math.max(0, estimateBundleTokens([before], tokenizer) - estimateBundleTokens([after], tokenizer));
}

/**
 * Keeps only as many regions as the token ceiling needs, in positional order.
 *
 * The stop-early rule, applied at the granularity the compression actually happens at. Without
 * it the target binds only between items, which on a single-item bundle — `optimize one-file.ts`,
 * the commonest CLI invocation — means it never binds at all.
 *
 * **Smallest-first, chosen by measurement rather than taste.** Positional order was tried first
 * and adheres badly, because regions are extremely uneven: measured across three of this repo's
 * own sources, each file has one dominant region — 58%, 61%, 83% of the file — followed by
 * several small ones, and the dominant one comes first positionally. Taking regions in position
 * order therefore blows past any modest target on the first step: `0.1`, `0.2`, `0.3` and `0.5`
 * all produced **55.2%** on `planner/index.ts`. Smallest-first approaches the ceiling in fine
 * increments and only reaches for the dominant region when the target genuinely requires it.
 *
 * The cost is that the output for one ratio is no longer a prefix of the output for a larger
 * one. That property is worth less than hitting the number the caller asked for, which is the
 * entire point of the flag.
 *
 * Ties break on `start`, so the choice is a total order and the stage stays deterministic
 * (invariant 1). The kept regions are returned in **positional** order regardless, because
 * `elideRegions` splices with a forward cursor and refuses ranges that arrive out of order.
 *
 * With no ceiling, every region is returned in its original order and the stage behaves exactly
 * as it did.
 */
function trimRegionsToCeiling(
  item: ContextItem,
  regions: ReadonlyArray<{ readonly start: number; readonly end: number }>,
  runningTokens: number,
  ceiling: number | undefined,
  markerFor: (regionText: string, describes: string, blockType: string) => string,
  tokenizer: TokenizerAdapter,
): ReadonlyArray<{ readonly start: number; readonly end: number }> {
  if (ceiling === undefined || regions.length === 0) {
    return regions;
  }

  let needed = runningTokens - ceiling;
  if (needed <= 0) {
    return [];
  }

  // Candidates are statements, not whole bodies — but only here, where a ceiling exists.
  //
  // A region is usually one function body and cannot be taken in part, so a modest target
  // either misses the dominant body or blows past it: measured over the frozen corpus at
  // target 0.3, whole-region granularity leaves 36 of 99 files above 50% achieved. Dividing
  // each region into its statements takes that to 12 and moves the mean from 45.8% to 30.8%
  // against a 30% target.
  //
  // **Subdivision is deliberately confined to the ceiling path.** With no ceiling the stage
  // takes every region whole, which is both what it has always done and the better choice
  // there: one marker per body rather than nine, since every elision spends a marker and
  // nothing is asking for a specific figure. Keeping the two paths separate is also what makes
  // the corpus A/B meaningful — every no-ceiling row must come out byte-identical.
  //
  // A region that does not divide into more than one usable span yields `[]`, and the whole
  // region is kept as the candidate. "Did not divide" is not "nothing to elide".
  const candidates = regions.flatMap((region) => {
    const statements = splitRegionIntoStatements(item, region);
    return statements.length > 1 ? statements : [region];
  });

  // The marker is rendered, not assumed: it is variable-length and self-describing, so its cost
  // depends on the region it replaces. Estimating a saving without it would overstate every
  // region by the marker's own size.
  const withCost = candidates.map((region) => {
    const text = item.content.slice(region.start, region.end);
    const marker = markerFor(text, FUNCTION_BODY_NOUN, item.kind);
    const freed = Math.max(
      0,
      estimateBundleTokens([{ ...item, content: text }], tokenizer) -
        estimateBundleTokens([{ ...item, content: marker }], tokenizer),
    );
    return { region, freed };
  });

  const bySize = [...withCost].sort((a, b) => a.freed - b.freed || a.region.start - b.region.start);

  const kept: Array<{ readonly start: number; readonly end: number }> = [];
  for (const candidate of bySize) {
    if (needed <= 0) break;
    kept.push(candidate.region);
    needed -= candidate.freed;
  }

  return kept.sort((a, b) => a.start - b.start);
}
