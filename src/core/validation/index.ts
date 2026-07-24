import type {
  ContextBundle,
  OptimizationBudget,
  OptimizationPlan,
  ValidationIssue,
  ValidationReport,
} from '../model';

/**
 * Validates the no-op optimization result and always passes in Milestone 1.
 */
export function validate(
  before: ContextBundle,
  after: ContextBundle,
  _plan: OptimizationPlan,
  budget: OptimizationBudget,
): ValidationReport {
  const issues: ValidationIssue[] = [];
  const confidence = 1;
  const changed = before.contentHash !== after.contentHash;
  const shouldFallback = false;

  void budget;
  void changed;

  return {
    passed: true,
    confidence,
    issues,
    shouldFallback,
  };
}
