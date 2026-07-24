import type {
  OptimizationPlan,
  OptimizationRequest,
  OptimizationTrace,
  StageResult,
  ValidationReport,
} from '../model';
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
): OptimizationTrace {
  const stageTraces = stageResults.map((stage) => ({
    stageId: stage.stageId,
    status: stage.status,
    durationMs: 0,
    changed: stage.changed,
  }));

  return {
    requestId: request.requestId,
    planMode: plan.mode,
    stageCount: stageTraces.length,
    stageTraces,
    tokenBefore: request.bundle.summary.tokenEstimate,
    tokenAfter: estimateTokens(finalOutput),
    fallbackUsed: fallback.used,
    ...(fallback.reason ?? validation.reason ? { fallbackReason: fallback.reason ?? validation.reason } : {}),
  };
}

function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  return Math.max(1, Math.ceil(text.length / 4));
}
