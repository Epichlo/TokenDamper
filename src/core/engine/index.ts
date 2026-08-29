import type { ContextBundle, ContextItem, OptimizationRequest, OptimizationResult, StageResult } from '../model';
import {
  createOptimizationResult,
  createValidationReport,
  createStageResult,
  createContextItem,
  createBundleStatistics,
  createBundleFromItems,
  freeze,
  hashContent,
} from '../model';
import { getBuiltInStageCatalog, executeBuiltInStage, type CompressionStageContext } from '../stage-registry';
import { containsElisionMarker, ELISION_MARKER_PATTERN } from '../elision';
import { plan } from '../planner';
import { resolveFallback } from '../fallback';
import { buildTrace } from '../trace';
import { validate } from '../validation';
import type { SessionDedupContext } from '../../stages/cleanup/session-dedup';
import type { TokenHasher } from '../hashing/token-hasher';
import { estimateBundleTokens } from '../hashing/tokenizer';
import type { ConfidenceLedger } from '../ledger/confidence-ledger';
import { DebtTracker, type DebtTrackerOptions } from '../ledger/debt-tracker';
import type { DeltaCompressionOptions } from '../../stages/compression/delta-compression';
import type { TokenHashingStageOptions } from '../../stages/compression/token-hashing';

export interface EngineOptimizationOptions {
  readonly sessionContext?: SessionDedupContext;
  readonly tokenHasher?: TokenHasher;
  readonly confidenceLedger?: ConfidenceLedger;
  readonly debtTracker?: DebtTracker;
  readonly debtOptions?: DebtTrackerOptions;
  readonly maxDebtThreshold?: number;
  readonly maxDriftThreshold?: number;
  readonly deltaOptions?: DeltaCompressionOptions;
  readonly currentTurn?: number;
  /**
   * Set by an adapter that holds the original bytes and has determined the string model cannot
   * represent them — currently only the CLI, which is the only adapter that reads from disk.
   *
   * The engine cannot detect this itself: by the time a request exists, `rawInput` is already a
   * decoded string and the evidence is gone. `readFileSync(path, 'utf8')` turns any invalid
   * byte into U+FFFD, which re-encodes to three bytes, so the fallback promise of "the caller
   * gets their input back" silently did not hold for a Latin-1 shell script (1,462 -> 1,466
   * bytes, `fallbackUsed: true`).
   *
   * Supplied as a reason rather than a boolean so the trace says *why* nothing ran. Forcing
   * fallback here rather than short-circuiting in the adapter is deliberate: an adapter that
   * returns early emits no trace at all, and a run with no trace is indistinguishable from a
   * silent crash to anything consuming the output — invariant 10's shape.
   */
  readonly inputNotRepresentable?: string;
  /**
   * Keep leading docstrings outside elided regions (Python only). Off by default; the CLI wires
   * it to `--keep-docstrings`. A retention/size trade the caller opts into — DECISIONS §58.
   */
  readonly keepDocstrings?: boolean;
}

/**
 * Runs the optimization flow end-to-end across planned stages.
 * Handles compression stage execution, confidence ledger tracking, debt score calculation,
 * semantic drift validation, and automated re-hydration.
 */
export function optimize(
  request: OptimizationRequest,
  options?: EngineOptimizationOptions,
): OptimizationResult {
  try {
    const stageCatalog = getBuiltInStageCatalog();
    const selectedPlan = plan(request.bundle, request.budget, request.config, stageCatalog);
    const stageResults: StageResult[] = [];
    // Wall time per stage, positionally aligned with `stageResults`.
    //
    // Measured here rather than inside the stages: a stage that read a clock would stop being a
    // pure function of its input (invariant 1). Timing an opaque call from the outside is an
    // observation about the stage, not an input to it. `performance.now()` rather than
    // `Date.now()` because most stages finish inside a millisecond, and integer-millisecond
    // resolution would report the same uninformative 0 the hardcoded value already did.
    const stageDurationsMs: number[] = [];
    let currentBundle = request.bundle;
    let stageFailed = false;
    let failureReason: string | undefined;

    // `tokenHashingOptions` carries both the (optional) store and `keepDocstrings`, so it is
    // built whenever *either* is present — the CLI supplies no hasher but can still ask for
    // docstrings to be kept, which the old `tokenHasher ? …` guard would have dropped.
    const tokenHashingOptions: TokenHashingStageOptions | undefined =
      options?.tokenHasher || options?.keepDocstrings
        ? {
            ...(options?.tokenHasher ? { tokenHasher: options.tokenHasher } : {}),
            ...(options?.keepDocstrings ? { keepDocstrings: true } : {}),
          }
        : undefined;

    const compressionContext: CompressionStageContext = {
      ...(options?.sessionContext ? { sessionContext: options.sessionContext } : {}),
      ...(tokenHashingOptions ? { tokenHashingOptions } : {}),
      ...(options?.deltaOptions ? { deltaOptions: options.deltaOptions } : {}),
    };

    for (const stageId of selectedPlan.stageIds) {
      const startedAt = performance.now();
      try {
        const result = executeBuiltInStage(
          stageId,
          currentBundle,
          request.budget,
          options?.sessionContext,
          compressionContext,
        );
        stageDurationsMs.push(performance.now() - startedAt);
        stageResults.push(result);
        if (result.status === 'ok' && result.changed) {
          currentBundle = result.bundle;
        } else if (result.status === 'failed') {
          stageFailed = true;
          failureReason = result.notes ?? `Stage '${stageId}' execution failed.`;
          break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // A stage that threw still consumed time, and a reader diagnosing a failure wants it.
        stageDurationsMs.push(performance.now() - startedAt);
        stageResults.push(
          createStageResult({
            stageId,
            status: 'failed',
            bundle: currentBundle,
            changed: false,
            metrics: {},
            notes: `Stage error: ${msg}`,
          }),
        );
        stageFailed = true;
        failureReason = `Stage '${stageId}' threw error: ${msg}`;
        break;
      }
    }

    // Record any new elisions into the confidence ledger if available
    const turn = options?.currentTurn ?? 1;
    if (options?.confidenceLedger) {
      for (const item of currentBundle.items) {
        if (item.metadata.elided) {
          const blockHash = typeof item.metadata.blockHash === 'string' ? item.metadata.blockHash : item.contentHash;
          const originalBytes =
            typeof item.metadata.originalBytes === 'number' ? item.metadata.originalBytes : item.content.length;
          options.confidenceLedger.recordElision({
            itemId: item.id,
            blockHash,
            turn,
            originalBytes,
            ...(item.path ? { path: item.path } : {}),
            kind: item.kind,
            elisionType: item.metadata.tokenHashed
              ? 'token-hashing'
              : item.metadata.deltaCompressed
                ? 'delta-compression'
                : 'session-dedup',
          });
        }
      }
    }

    const debtTracker =
      options?.debtTracker ??
      new DebtTracker({
        ...(options?.maxDebtThreshold !== undefined ? { maxDebtThreshold: options.maxDebtThreshold } : {}),
        ...options?.debtOptions,
      });

    let debtBreakdown = computeDebtBreakdown(debtTracker, currentBundle, options?.confidenceLedger, turn);

    const valOptions = options?.maxDriftThreshold !== undefined ? { maxDriftThreshold: options.maxDriftThreshold } : undefined;

    let validation = createValidationReport(
      validate(request.bundle, currentBundle, selectedPlan, request.budget, valOptions),
    );

    const minimumConfidence = request.config.validation.minimumConfidence;
    const overallLedgerConfidence = options?.confidenceLedger
      ? options.confidenceLedger.getOverallConfidence(turn)
      : 1.0;

    // Trigger automated re-hydration when debt threshold exceeded, validation failed, or confidence compromised
    if (
      (debtBreakdown.shouldRehydrate ||
        !validation.passed ||
        validation.confidence < minimumConfidence ||
        overallLedgerConfidence < minimumConfidence) &&
      !stageFailed
    ) {
      const rehydratedBundle = attemptAutomatedRehydration(
        currentBundle,
        options?.tokenHasher,
        options?.confidenceLedger,
        turn,
      );

      if (rehydratedBundle && rehydratedBundle !== currentBundle) {
        const revalidated = createValidationReport(
          validate(request.bundle, rehydratedBundle, selectedPlan, request.budget, valOptions),
        );

        if (revalidated.passed && revalidated.confidence >= minimumConfidence) {
          currentBundle = rehydratedBundle;
          validation = revalidated;
          debtBreakdown = computeDebtBreakdown(debtTracker, currentBundle, options?.confidenceLedger, turn);
        }
      }
    }

    // Per-item repair, before giving up on the whole bundle — Phase 1c.
    //
    // Validation is bundle-scoped and fallback has been all-or-nothing, so one bad item reverted
    // every good one. Measured on the 45-file Python corpus: the stages achieved **42.52%**, 26
    // `CONSTRAINT_DIRECTIVE_LOST` errors across 14 items reverted all 45, and the run emitted
    // **0.00%** — with drift at 0.0359 against a 0.40 gate and AST clean. Reverting only the 14
    // named items yields **23.14%** and re-validates clean.
    //
    // Deliberately placed after the rehydration attempt above, and shaped like it: build a
    // candidate, re-validate it with the same `validate`, and adopt it **only if it passes**.
    // Nothing here decides an item is acceptable; validation still does. This changes which
    // bundle is offered, never what counts as valid.
    //
    // **The gate is "is there a principled subset to revert?", not "is every error attributed?"**
    //
    // The stricter rule was tried first and measured too strict. The 61-file TypeScript bundle
    // fails on *both* attributable constraint losses and `SEMANTIC_DRIFT_EXCEEDED` at 0.4122,
    // barely over the 0.40 gate. Refusing because drift named no item threw away the constraint
    // attribution that did — and reverting those items lowers semantic loss, which is exactly
    // what drift measures, so the drift failure is frequently a consequence of the same items.
    //
    // Attempting the repair is safe because it decides nothing: the candidate goes back through
    // the same `validate`, and a drift score still over the gate simply fails again and falls
    // back. What would be guessing is reverting a subset when **no** error names anything —
    // there is no principled choice there, so `repairableItemIds` being empty still refuses.
    let revertedItemIds: ReadonlyArray<string> = Object.freeze([]);
    if (!validation.passed && !stageFailed) {
      const attribution = validation.attribution;
      if (attribution && attribution.repairableItemIds.length > 0) {
        const repaired = revertFailingItems(request.bundle, currentBundle, attribution.repairableItemIds);
        if (repaired) {
          const revalidated = createValidationReport(
            validate(request.bundle, repaired.bundle, selectedPlan, request.budget, valOptions),
          );

          // One pass, not a loop to fixpoint. A loop terminates — each pass reverts at least one
          // more item and the limit is the full fallback — but it costs a whole-bundle AST pass
          // per iteration, so worst case is O(n²) validations on the bundles that need it most.
          // Measured, one pass sufficed on the corpus above. If a second round of attributable
          // failures ever appears, this refuses and falls back rather than iterating.
          if (revalidated.passed && revalidated.confidence >= minimumConfidence) {
            currentBundle = repaired.bundle;
            validation = revalidated;
            revertedItemIds = repaired.revertedItemIds;
            debtBreakdown = computeDebtBreakdown(debtTracker, currentBundle, options?.confidenceLedger, turn);
          }
        }
      }
    }

    const finalLedgerConfidence = options?.confidenceLedger
      ? options.confidenceLedger.getOverallConfidence(turn)
      : 1.0;

    const corruptedBlockHashes = detectCorruptedPlaceholders(currentBundle, options?.tokenHasher);
    const hasBlockCorruption = corruptedBlockHashes.length > 0;

    if (
      !validation.passed ||
      validation.confidence < minimumConfidence ||
      finalLedgerConfidence < minimumConfidence ||
      hasBlockCorruption
    ) {
      const reason =
        validation.reason ??
        (hasBlockCorruption
          ? `Block hash corruption detected: missing block hash [${corruptedBlockHashes.join(', ')}] in token hasher.`
          : finalLedgerConfidence < minimumConfidence
            ? `Elision confidence score (${finalLedgerConfidence.toFixed(2)}) dropped below minimum threshold (${minimumConfidence}).`
            : 'Validation failed');
      const combinedIssues = [
        ...validation.issues,
        ...(hasBlockCorruption
          ? [
              {
                code: 'BLOCK_HASH_CORRUPTED',
                message: `Block hash corruption detected: missing block hash [${corruptedBlockHashes.join(', ')}] in token hasher.`,
                severity: 'error' as const,
              },
            ]
          : []),
        ...(finalLedgerConfidence < minimumConfidence
          ? [
              {
                code: 'CONFIDENCE_THRESHOLD_BELOW_MINIMUM',
                message: `Elision confidence score (${finalLedgerConfidence.toFixed(2)}) dropped below minimum threshold (${minimumConfidence}).`,
                severity: 'error' as const,
              },
            ]
          : []),
      ];
      validation = createValidationReport({
        passed: false,
        confidence: hasBlockCorruption ? 0 : Math.min(validation.confidence, finalLedgerConfidence),
        issues: combinedIssues,
        shouldFallback: true,
        reason,
        ...(validation.driftReport ? { driftReport: validation.driftReport } : {}),
        ...(validation.astCoverage ? { astCoverage: validation.astCoverage } : {}),
        ...(validation.driftCoverage ? { driftCoverage: validation.driftCoverage } : {}),
        ...(validation.languageSupport ? { languageSupport: validation.languageSupport } : {}),
      });
    }

    if (stageFailed) {
      const combinedIssues = [
        ...validation.issues,
        {
          code: 'STAGE_EXECUTION_FAILED',
          message: failureReason ?? 'Stage execution failed',
          severity: 'error' as const,
        },
      ];
      validation = createValidationReport({
        passed: false,
        confidence: 0,
        issues: combinedIssues,
        shouldFallback: true,
        reason: failureReason ?? 'Stage execution failed',
        ...(validation.driftReport ? { driftReport: validation.driftReport } : {}),
        ...(validation.astCoverage ? { astCoverage: validation.astCoverage } : {}),
        ...(validation.driftCoverage ? { driftCoverage: validation.driftCoverage } : {}),
        ...(validation.languageSupport ? { languageSupport: validation.languageSupport } : {}),
      });
    }

    // Last, so it cannot be overwritten by a later `createValidationReport` above, and so the
    // trace still records everything the stages and validators actually found on the decoded
    // string. The verdict is not negotiable — no threshold overrides it — because the question
    // is not how much was lost but whether the pipeline was ever looking at the caller's input.
    if (options?.inputNotRepresentable) {
      validation = createValidationReport({
        passed: false,
        confidence: 0,
        issues: [
          ...validation.issues,
          {
            code: 'INPUT_NOT_REPRESENTABLE',
            message: options.inputNotRepresentable,
            severity: 'error' as const,
          },
        ],
        shouldFallback: true,
        reason: options.inputNotRepresentable,
        ...(validation.driftReport ? { driftReport: validation.driftReport } : {}),
        ...(validation.astCoverage ? { astCoverage: validation.astCoverage } : {}),
        ...(validation.driftCoverage ? { driftCoverage: validation.driftCoverage } : {}),
        ...(validation.languageSupport ? { languageSupport: validation.languageSupport } : {}),
      });
    }

    const fallback = resolveFallback(request, validation, currentBundle);
    const emittedOutput = fallback.output;
    const trace = buildTrace(request, selectedPlan, stageResults, validation, fallback, emittedOutput, {
      debtScore: debtBreakdown.debtScore,
      stageDurationsMs,
      // Only meaningful when the run actually emitted the repaired bundle. On a fallback the
      // caller gets their input back and nothing was "kept", so reporting a revert list there
      // would describe a decision that had no effect on the output.
      ...(fallback.used ? {} : { itemsReverted: revertedItemIds }),
      ...(validation.driftReport?.driftScore !== undefined
        ? { driftScore: validation.driftReport.driftScore }
        : {}),
    });

    return createOptimizationResult({
      finalBundle: fallback.used ? request.bundle : currentBundle,
      emittedOutput,
      validation,
      trace,
      fallbackUsed: fallback.used,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const fallbackPlan = {
      planId: `${request.bundle.bundleId}:fallback`,
      mode: 'pass_through' as const,
      stageIds: Object.freeze([]),
      revalidationPoints: Object.freeze(['end' as const]),
      fallbackPolicy: 'original_input' as const,
    };
    const validation = createValidationReport({
      passed: false,
      confidence: 0,
      issues: [
        {
          code: 'OPTIMIZATION_ERROR',
          message: `Fatal optimization failure: ${msg}`,
          severity: 'error',
        },
      ],
      shouldFallback: true,
      reason: `Fatal optimization failure: ${msg}`,
    });
    const fallback = {
      used: true,
      output: request.rawInput,
      reason: msg,
    };
    const trace = buildTrace(request, fallbackPlan, [], validation, fallback, request.rawInput);

    return createOptimizationResult({
      finalBundle: request.bundle,
      emittedOutput: request.rawInput,
      validation,
      trace,
      fallbackUsed: true,
    });
  }
}

/**
 * Rebuilds `after` with the named items restored to their pre-optimization content.
 *
 * Returns `undefined` in the two cases where a repair is not the right answer:
 *
 *  - **Nothing to revert.** No named item actually differs from its original, so the failure is
 *    not about content this can restore.
 *  - **Everything would be reverted.** The result would be indistinguishable from the original
 *    bundle, which is a full fallback wearing a different name. Returning `undefined` sends it
 *    down the real fallback path, and that matters: fallback echoes `request.rawInput` (the CLI
 *    writes the original `Buffer`), whereas this path renders from items. DECISIONS §35 exists
 *    because those two are not the same bytes for input that is not valid UTF-8.
 *
 * "Everything" accounts for pruning. A bundle whose surviving items were all reverted is still a
 * real reduction if the planner dropped items — selection is not elision, and that saving is not
 * what any of these checks objected to.
 */
function revertFailingItems(
  before: ContextBundle,
  after: ContextBundle,
  repairableItemIds: ReadonlyArray<string>,
): { readonly bundle: ContextBundle; readonly revertedItemIds: ReadonlyArray<string> } | undefined {
  const beforeById = new Map(before.items.map((item) => [item.id, item]));
  const targets = new Set(repairableItemIds);
  const reverted: string[] = [];

  const items = after.items.map((item) => {
    if (!targets.has(item.id)) return item;
    const original = beforeById.get(item.id);
    if (!original || original.content === item.content) return item;
    reverted.push(item.id);
    return original;
  });

  if (reverted.length === 0) {
    return undefined;
  }

  const sameItemCount = items.length === before.items.length;
  const everyItemOriginal = items.every((item) => beforeById.get(item.id)?.content === item.content);
  if (sameItemCount && everyItemOriginal) {
    return undefined;
  }

  return {
    bundle: createBundleFromItems(items, after.source),
    revertedItemIds: Object.freeze([...reverted].sort()),
  };
}

function computeDebtBreakdown(
  debtTracker: DebtTracker,
  bundle: ContextBundle,
  ledger?: ConfidenceLedger,
  currentTurn = 1,
) {
  let elidedBytes = 0;
  let totalBytes = 0;
  let oldestElidedTurn: number | undefined;

  for (const item of bundle.items) {
    const itemBytes = item.content.length;
    const originalItemBytes =
      typeof item.metadata.originalBytes === 'number' ? item.metadata.originalBytes : itemBytes;

    totalBytes += originalItemBytes;

    if (item.metadata.elided) {
      // Bytes actually **removed**, not the whole size of an item that was touched at all —
      // audit OX-M7.
      //
      // `originalBytes` is the item's entire pre-transform length (every stage that sets it does
      // so from `item.content.length`), and `elided` is a boolean on the whole item. Adding the
      // former on the strength of the latter made an item that lost 5% of its bytes contribute
      // 100% of its size to the numerator. On the CLI a single file is a single-item bundle, so
      // `elidedBytes === totalBytes` whenever anything was elided and the ratio was 1.0 by
      // construction.
      //
      // Measured over a frozen 289-file corpus at ratio 0.3 before the fix: **all 101 rows that
      // reduced scored `debtScore` exactly 35.00** — the `weightElisionRatio * 100` ceiling —
      // whether the file lost 4.7% or 66.8%. `Math.min(1.0, …)` in `calculateDebt` was clamping a
      // ratio that had no business exceeding 1, which is why nothing looked wrong.
      //
      // This is the granularity failure the project already diagnosed for drift, where `R_AST`
      // was "a boolean" on single-item bundles (Issue 3 / Phase 1d). It outlives that one: it
      // needs no single-item bundle, because any partially-elided item over-contributes on any
      // bundle.
      //
      // Note the audit's stated mechanism — a denominator mixing pre- and post-transform sizes —
      // is not what happened. Every stage setting `elided` also sets `originalBytes`, and
      // untouched items are unchanged, so `totalBytes` was already a clean sum of original sizes.
      // The numerator was the defect.
      elidedBytes += Math.max(0, originalItemBytes - itemBytes);
    }
  }

  const overallConfidence = ledger ? ledger.getOverallConfidence(currentTurn) : 1.0;

  if (ledger) {
    const elisions = ledger.getAllElisions(currentTurn);
    for (const el of elisions) {
      if (oldestElidedTurn === undefined || el.elisionTurn < oldestElidedTurn) {
        oldestElidedTurn = el.elisionTurn;
      }
    }
  }

  return debtTracker.calculateDebt({
    currentTurn,
    overallConfidence,
    elidedBytes,
    totalBytes,
    ...(oldestElidedTurn !== undefined ? { oldestElidedTurn } : {}),
  });
}

/**
 * Attempts automated re-hydration of elided placeholders in the bundle when confidence is compromised.
 */
function attemptAutomatedRehydration(
  bundle: ContextBundle,
  hasher?: TokenHasher,
  ledger?: ConfidenceLedger,
  turn = 1,
): ContextBundle | undefined {
  if (!hasher && !ledger) {
    return undefined;
  }

  let rehydratedAny = false;
  const candidates = ledger ? new Set(ledger.getRehydrationCandidates(turn).map((c) => c.itemId)) : null;

  const newItems: ContextItem[] = bundle.items.map((item) => {
    // A ledger's answer is respected even when it is "none" — audit OX-M6.
    //
    // The guard used to read `candidates && candidates.size > 0 && !candidates.has(item.id)`. The
    // `size > 0` clause exists for the *missing* ledger case, where there is no statement about
    // which items matter and every elided placeholder stays eligible. But it also swallowed the
    // case where a ledger exists and reports **zero** items below the confidence threshold, and
    // turned "nothing needs restoring" into "restore everything in the bundle" — the exact
    // opposite of what the ledger said, and a whole-bundle semantic cliff behind a small boolean.
    //
    // Measured: with a hasher, a ledger, and `maxDebtThreshold` low enough to enter this branch,
    // a 1,481-byte item came back at exactly 1,481 bytes — every elision undone, and `debtScore`
    // then recomputed to 0 on the restored bundle, so the trace reported no debt either.
    //
    // `candidates === null` is the no-ledger case and still falls through. An empty set is now a
    // statement, not an absence.
    if (candidates !== null && !candidates.has(item.id)) {
      return item;
    }

    let newContent = item.content;
    if (item.metadata.deltaCompressed && typeof item.metadata.originalContent === 'string') {
      newContent = item.metadata.originalContent as string;
    }
    if (hasher && (containsElisionMarker(newContent) || newContent.includes('<BLOCK_HASH:'))) {
      newContent = hasher.rehydrateText(newContent);
    }

    if (newContent !== item.content) {
      rehydratedAny = true;
      if (ledger) {
        ledger.removeElision(item.id);
      }

      const updatedMetadata: Record<string, string | number | boolean | null> = { ...item.metadata };
      delete updatedMetadata.elided;
      delete updatedMetadata.tokenHashed;
      delete updatedMetadata.deltaCompressed;

      return createContextItem({
        id: item.id,
        kind: item.kind,
        contentType: item.contentType,
        content: newContent,
        origin: item.origin,
        contentHash: hashContent(newContent),
        ...(item.role ? { role: item.role } : {}),
        ...(item.path ? { path: item.path } : {}),
        ...(item.language ? { language: item.language } : {}),
        metadata: freeze(updatedMetadata),
      });
    }

    return item;
  });

  if (!rehydratedAny) {
    return undefined;
  }

  const statistics = createBundleStatistics(newItems);
  const bundleHash = hashContent({
    source: bundle.source,
    items: newItems.map((entry) => entry.contentHash),
    statistics,
  });

  const rawCombined = newItems.map((i) => i.content).join('\n');
  const tokenEstimate = estimateBundleTokens(newItems);

  return freeze({
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
}

/**
 * Finds markers whose content the supplied store should hold but does not.
 *
 * **Inert without a hasher, correctly.** With no store there is nothing that claims to hold
 * the content, so there is nothing to be missing — `compression:token-hashing` records that
 * case as `metadata.reversible: false` and its markers say in-band what they replaced. The
 * check is about a *broken promise*, and no promise is made on that path. It would be wrong
 * to report every CLI elision as corruption, and equally wrong to let this read as evidence
 * that CLI markers resolve: they do not, by design. See DECISIONS §24.
 */
function detectCorruptedPlaceholders(bundle: ContextBundle, hasher?: TokenHasher): string[] {
  if (!hasher) {
    return [];
  }

  const corruptedHashes: string[] = [];
  // The legacy alternative captures a **hash**, not "anything up to the next `>`".
  //
  // It was `<BLOCK_HASH:([^>]+)>`, which matched prose. This repository's own
  // `src/core/elision/regions.ts` contains the line
  //
  //     fixed width of `<BLOCK_HASH:` + 64 hex + `>`; markers are now variable-length
  //
  // so the scan captured "` + 64 hex + `" as a hash, found it absent from the store, and
  // failed the whole run as corrupted — 29.60% reduction on the CLI, 0% and a fallback on MCP.
  // Twenty-two files in this repo carry a `<BLOCK_HASH:…>`-shaped string, `ARCHITECTURE.md` and
  // `CHANGELOG.md` among them, and every one was unoptimizable over MCP.
  //
  // `createBlockPlaceholder` emits `<BLOCK_HASH:${hashContent(...)}>` — a sha256 digest — so
  // requiring hex costs no real detection while removing every prose match. The bound matches
  // `ELISION_MARKER_PATTERN`'s own `[a-f0-9]{12,64}`, which had this right all along; the two
  // alternatives sitting in one regex with different strictness is what hid it.
  //
  // **This was invisible to the corpus harness by construction.** The check returns early
  // without a hasher and the harness drives the CLI, which supplies none — so no measurement in
  // this project could see it. Found by pointing an MCP client at this repository's own source.
  // DECISIONS §57.
  const regex = new RegExp(`${ELISION_MARKER_PATTERN.source}|<BLOCK_HASH:([a-f0-9]{12,64})>`, 'g');
  for (const item of bundle.items) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(item.content)) !== null) {
      const hash = match[1] ?? match[2];
      if (hash && !hasher.hasHash(hash)) {
        corruptedHashes.push(hash);
      }
    }
  }
  return corruptedHashes;
}
