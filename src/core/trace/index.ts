import type {
  OptimizationPlan,
  OptimizationRequest,
  OptimizationTrace,
  StageResult,
  ValidationReport,
} from '../model';
import { createOptimizationTrace } from '../model';
import type { FallbackOutcome } from '../fallback';

/**
 * Builds the lightweight execution trace for the final engine result.
 */
export function buildTrace(
  request: OptimizationRequest,
  plan: OptimizationPlan,
  stageResults: ReadonlyArray<StageResult>,
  validation: ValidationReport,
  fallback: FallbackOutcome,
  finalOutput: string,
  metrics?: { readonly debtScore?: number; readonly driftScore?: number },
): OptimizationTrace {
  const stageTraces = stageResults.map((stage) => ({
    stageId: stage.stageId,
    status: stage.status,
    durationMs: 0,
    changed: stage.changed,
  }));

  return createOptimizationTrace({
    requestId: request.requestId,
    bundleId: request.bundle.bundleId,
    bundleContentHash: request.bundle.contentHash,
    planMode: plan.mode,
    stageCount: stageTraces.length,
    stageTraces,
    inputTokenEstimate: request.bundle.summary.tokenEstimate,
    outputTokenEstimate: estimateTokens(finalOutput),
    tokenBefore: request.bundle.summary.tokenEstimate,
    tokenAfter: estimateTokens(finalOutput),
    bundleStatistics: request.bundle.statistics,
    fallbackUsed: fallback.used,
    ...(fallback.reason ?? validation.reason ? { fallbackReason: fallback.reason ?? validation.reason } : {}),
    ...(metrics?.debtScore !== undefined ? { debtScore: metrics.debtScore } : {}),
    ...(metrics?.driftScore !== undefined || validation.driftReport?.driftScore !== undefined
      ? { driftScore: metrics?.driftScore ?? validation.driftReport?.driftScore }
      : {}),
  });
}

function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  return Math.max(1, Math.ceil(text.length / 4));
}
