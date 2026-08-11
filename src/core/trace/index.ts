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
import { renderBundleOutput } from '../render';

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
  metrics?: {
    readonly debtScore?: number;
    readonly driftScore?: number;
    /** Per-stage wall time, positionally aligned with `stageResults`. See `StageTrace`. */
    readonly stageDurationsMs?: ReadonlyArray<number>;
  },
): OptimizationTrace {
  // Both sides must measure the same *kind* of thing, or the ratio is a comparison of a bundle
  // against a rendered string — DECISIONS §19's lesson, which was about two estimators but
  // applies just as much to one estimator pointed at two different texts.
  //
  // Multi-file ingestion (audit H5) made that live: `emittedOutput` carries `==> path <==`
  // headers between items, and `bundle.summary.tokenEstimate` is the sum of item contents with
  // no headers at all. Measured on `src/core`, a fallback — where nothing changed — reported
  // 72,973 -> 73,667 tokens, a **negative** reduction, purely because the output side counted
  // framing the input side did not. That is the exact shape of the phantom -1.39% the project
  // already diagnosed once in the Python bench harness (Issue 5).
  //
  // For a single-item bundle `rawInput` and the item content are the same text, so this leaves
  // CLI, MCP and bench byte-identical; only the multi-item render gains its own headers on both
  // sides. Gateway payloads keep the bundle estimate, because there `rawInput` is the whole JSON
  // envelope and the bundle is the extracted messages — genuinely different populations.
  const tokenBefore =
    request.bundle.items.length > 1
      ? estimateTokens(renderBundleOutput(request.bundle))
      : request.bundle.summary.tokenEstimate;

  // Carry the stage's own telemetry through instead of discarding it.
  //
  // This used to project away `metrics` and `notes` and hardcode `durationMs: 0`, so the trace
  // reported that a stage ran and nothing about what it did. `--diff` and `--diff-html`
  // partially compensated on the CLI; the MCP `get_optimization_trace` tool and the Gateway had
  // nothing else at all. (audit M6)
  const stageTraces = stageResults.map((stage, index) => ({
    stageId: stage.stageId,
    status: stage.status,
    durationMs: metrics?.stageDurationsMs?.[index] ?? 0,
    changed: stage.changed,
    metrics: stage.metrics,
    ...(stage.notes !== undefined ? { notes: stage.notes } : {}),
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
    inputTokenEstimate: tokenBefore,
    outputTokenEstimate: estimateTokens(finalOutput),
    tokenBefore,
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
    // Same reasoning for drift: `driftScore: 0` means "retained everything" and "found
    // nothing to measure" indistinguishably, and the CLI's stderr trace is the only place a
    // one-shot run can notice the difference.
    ...(validation.driftCoverage === undefined ? {} : { driftCoverage: validation.driftCoverage }),
    // And the same again for language support: a 0% run cannot otherwise say whether this build
    // has any transform for the input's language at all, which is a different problem from the
    // input being incompressible and calls for a different response. Audit H2.
    ...(validation.languageSupport === undefined ? {} : { languageSupport: validation.languageSupport }),
  });
}
