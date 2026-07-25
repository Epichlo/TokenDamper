import type { OptimizationRequest, OptimizationResult, StageResult } from '../model';
import { createOptimizationResult, createValidationReport } from '../model';
import { getBuiltInStageCatalog, executeBuiltInStage } from '../stage-registry';
import { plan } from '../planner';
import { resolveFallback } from '../fallback';
import { buildTrace } from '../trace';
import { validate } from '../validation';

/**
 * Runs the optimization flow end to end across planned stages.
 */
export function optimize(request: OptimizationRequest): OptimizationResult {
  try {
    const stageCatalog = getBuiltInStageCatalog();
    const selectedPlan = plan(request.bundle, request.budget, request.config, stageCatalog);
    const stageResults: StageResult[] = [];
    let currentBundle = request.bundle;
    let stageFailed = false;
    let failureReason: string | undefined;

    for (const stageId of selectedPlan.stageIds) {
      try {
        const result = executeBuiltInStage(stageId, currentBundle, request.budget);
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

    let validation = createValidationReport(
      validate(request.bundle, currentBundle, selectedPlan, request.budget),
    );

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
      });
    }

    const fallback = resolveFallback(request, validation);
    const emittedOutput = fallback.output;
    const trace = buildTrace(request, selectedPlan, stageResults, validation, fallback, emittedOutput);

    return createOptimizationResult({
      finalBundle: currentBundle,
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
      revalidationPoints: Object.freeze(['end']),
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
