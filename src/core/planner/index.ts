import type {
  ContextBundle,
  OptimizationBudget,
  OptimizationMode,
  OptimizationPlan,
  ResolvedConfig,
} from '../model';
import type { BuiltInStageDefinition } from '../stage-registry';

/**
 * Returns an optimization plan based on budget constraints and available stage catalog.
 */
export function plan(
  bundle: ContextBundle,
  budget: OptimizationBudget,
  config: ResolvedConfig,
  _stageCatalog: ReadonlyArray<BuiltInStageDefinition>,
): OptimizationPlan {
  validatePlannerInputs(bundle, budget, config);

  // Explicit `session_dedup` selection wins over budget-derived knapsack mode.
  // The Gateway proxy sets this so cross-turn deduplication is the only transform
  // applied to live provider traffic. `compression:token-hashing` is lossy and measures
  // `S_k = 0.60` on JSON, so it fails the drift gate on Gateway payloads. (The original
  // reason recorded here — bare markers corrupting JSON-shaped content, Issue 2 — no longer
  // holds: `core/elision` renders markers validly for the item's syntax. Drift is now the
  // blocker. See CLAUDE.md invariant 8.)
  if (config.planner?.defaultMode === 'session_dedup') {
    return {
      planId: `${bundle.bundleId}:session_dedup`,
      mode: 'session_dedup',
      stageIds: Object.freeze(['cleanup:session-dedup']),
      revalidationPoints: Object.freeze(['end']),
      fallbackPolicy: 'original_input',
    };
  }

  const isKnapsackMode =
    (typeof budget.maxInputTokens === 'number' && budget.maxInputTokens > 0) ||
    (typeof budget.targetReductionRatio === 'number' && budget.targetReductionRatio > 0);
  const mode: OptimizationMode = isKnapsackMode ? 'topology_knapsack' : 'pass_through';

  const stageIds: string[] = [];
  if (isKnapsackMode) {
    stageIds.push('cleanup:constraint-preservation');
    stageIds.push('pruning:topology-pruner');
    stageIds.push('compression:token-hashing');
    stageIds.push('compression:delta-compression');
  }

  return {
    planId: `${bundle.bundleId}:${mode}`,
    mode,
    stageIds: Object.freeze(stageIds),
    revalidationPoints: Object.freeze(['end']),
    fallbackPolicy: 'original_input',
    // **Unconsumed, and the number is wrong** — audit OX-L1.
    //
    // Nothing in `src/` reads `plan.expectedSavings`; `createOptimizationPlan` copies it and it
    // stops there. The 0.45 is not a measurement either: over a frozen 289-file corpus at target
    // 0.3 the TypeScript bucket reduces ~20% and Python ~16% (DECISIONS §64's baseline arm).
    //
    // Left in place rather than deleted, on the precedent audit H4 set and OX-H5 followed:
    // `OptimizationPlan` is part of the frozen model, and a field awaiting an implementation is
    // not the same defect as a dial that reports success. Nobody can *set* this, so it misleads
    // no caller. Wiring it would mean deriving a real estimate from the selected stages, which
    // is a planner change; deleting it would edit the frozen model for a field a test asserts.
    // Recorded here so the next reader knows the constant is a placeholder, not a finding.
    expectedSavings: isKnapsackMode ? 0.45 : 0,
  };
}

/**
 * Determines the optimization mode based on budget.
 */
export function planOptimizationMode(budget?: OptimizationBudget): OptimizationMode {
  if (
    budget &&
    ((typeof budget.maxInputTokens === 'number' && budget.maxInputTokens > 0) ||
      (typeof budget.targetReductionRatio === 'number' && budget.targetReductionRatio > 0))
  ) {
    return 'topology_knapsack';
  }
  return 'pass_through';
}

function validatePlannerInputs(
  bundle: ContextBundle,
  budget: OptimizationBudget,
  config: ResolvedConfig,
): void {
  if (!bundle) {
    throw new Error('Planner requires a context bundle.');
  }

  if (!budget) {
    throw new Error('Planner requires an optimization budget.');
  }

  if (!config) {
    throw new Error('Planner requires a resolved configuration.');
  }
}
