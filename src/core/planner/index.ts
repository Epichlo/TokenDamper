import type {
  ContextBundle,
  OptimizationBudget,
  OptimizationMode,
  OptimizationPlan,
  ResolvedConfig,
} from '../model';
import type { BuiltInStageDefinition } from '../stage-registry';

/**
 * Returns the frozen no-op plan used by Milestone 1.
 */
export function plan(
  bundle: ContextBundle,
  _budget: OptimizationBudget,
  config: ResolvedConfig,
  _stageCatalog: ReadonlyArray<BuiltInStageDefinition>,
): OptimizationPlan {
  validatePlannerInputs(bundle, _budget, config);

  return {
    planId: `${bundle.bundleId}:pass_through`,
    mode: 'pass_through',
    stageIds: [],
    revalidationPoints: ['end'],
    fallbackPolicy: 'original_input',
    expectedSavings: 0,
  };
}

/**
 * Plans only the pass-through optimization mode in Milestone 1.
 */
export function planOptimizationMode(): OptimizationMode {
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
