import type {
  OptimizationPlan,
  OptimizationRequest,
  OptimizationTrace,
  StageResult,
  ValidationReport,
} from '../model';
import { createOptimizationTrace } from '../model';
import type { FallbackOutcome } from '../fallback';
import { estimateTokens } from '../hashing/tokenizer';

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
    // `tokenBefore` is the bundle's own estimate and `tokenAfter` re-measures the emitted
    // text, so the two MUST come from the same estimator — `adapters/mcp/tools.ts` divides
    // one by the other to report `reductionRatio`. When `tokenAfter` was an inline
    // `ceil(len / 4)` while bundles used the tokenizer, MCP reported a saving on every
    // request including pure fallbacks, where the emitted text is the raw input verbatim.
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
    // The CLI writes this trace to stderr and nothing else it emits mentions validation
    // coverage, so without this line an unchecked item is invisible on the one entry mode
    // that has no session and no second chance to notice. DECISIONS §23.
    ...(validation.astCoverage === undefined ? {} : { astCoverage: validation.astCoverage }),
  });
}
