import type { OptimizationRequest, OptimizationResult, StageResult } from '../model';
import { getBuiltInStageCatalog } from '../stage-registry';
import { plan } from '../planner';
import { resolveFallback } from '../fallback';
import { buildTrace } from '../trace';
import { validate } from '../validation';

/**
 * Runs the frozen Milestone 1 optimization flow end to end.
 */
export function optimize(request: OptimizationRequest): OptimizationResult {
  const stageCatalog = getBuiltInStageCatalog();
  const selectedPlan = plan(request.bundle, request.budget, request.config, stageCatalog);
  const stageResults: StageResult[] = [];
  const finalBundle = request.bundle;
  const validation = validate(request.bundle, finalBundle, selectedPlan, request.budget);
  const fallback = resolveFallback(request, validation);
  const emittedOutput = fallback.output;
  const trace = buildTrace(request, selectedPlan, stageResults, validation, fallback, emittedOutput);

  return {
    finalBundle,
    emittedOutput,
    validation,
    trace,
    fallbackUsed: fallback.used,
  };
}
