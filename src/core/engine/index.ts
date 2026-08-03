import type { ContextBundle, ContextItem, OptimizationRequest, OptimizationResult, StageResult } from '../model';
import {
  createOptimizationResult,
  createValidationReport,
  createStageResult,
  createContextItem,
  createBundleStatistics,
  freeze,
  hashContent,
} from '../model';
import { getBuiltInStageCatalog, executeBuiltInStage, type CompressionStageContext } from '../stage-registry';
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
    let currentBundle = request.bundle;
    let stageFailed = false;
    let failureReason: string | undefined;

    const compressionContext: CompressionStageContext = {
      ...(options?.sessionContext ? { sessionContext: options.sessionContext } : {}),
      ...(options?.tokenHasher ? { tokenHashingOptions: { tokenHasher: options.tokenHasher } } : {}),
      ...(options?.deltaOptions ? { deltaOptions: options.deltaOptions } : {}),
    };

    for (const stageId of selectedPlan.stageIds) {
      try {
        const result = executeBuiltInStage(
          stageId,
          currentBundle,
          request.budget,
          options?.sessionContext,
          compressionContext,
        );
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
      });
    }

    const fallback = resolveFallback(request, validation, currentBundle);
    const emittedOutput = fallback.output;
    const trace = buildTrace(request, selectedPlan, stageResults, validation, fallback, emittedOutput, {
      debtScore: debtBreakdown.debtScore,
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
    totalBytes += typeof item.metadata.originalBytes === 'number' ? item.metadata.originalBytes : itemBytes;
    if (item.metadata.elided) {
      elidedBytes += typeof item.metadata.originalBytes === 'number' ? item.metadata.originalBytes : itemBytes;
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
    // If ledger specifies candidates, target those; otherwise rehydrate any elided placeholder item
    if (candidates && candidates.size > 0 && !candidates.has(item.id)) {
      return item;
    }

    let newContent = item.content;
    if (item.metadata.deltaCompressed && typeof item.metadata.originalContent === 'string') {
      newContent = item.metadata.originalContent as string;
    }
    if (hasher && newContent.includes('<BLOCK_HASH:')) {
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

function detectCorruptedPlaceholders(bundle: ContextBundle, hasher?: TokenHasher): string[] {
  const corruptedHashes: string[] = [];
  for (const item of bundle.items) {
    if (item.content.includes('<BLOCK_HASH:')) {
      const regex = /<BLOCK_HASH:([^>]+)>/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(item.content)) !== null) {
        const hash = match[1];
        if (hash && hasher && !hasher.hasHash(hash)) {
          corruptedHashes.push(hash);
        }
      }
    }
  }
  return corruptedHashes;
}
