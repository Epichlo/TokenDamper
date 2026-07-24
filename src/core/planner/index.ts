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
  _config: ResolvedConfig,
  _stageCatalog: ReadonlyArray<BuiltInStageDefinition>,
): OptimizationPlan {
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
