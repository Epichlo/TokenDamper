import type {
  ContextBundle,
  OptimizationBudget,
  OptimizationPlan,
  ValidationIssue,
  ValidationReport,
} from '../model';
import { extractConstraintDirectives } from '../../stages/cleanup/constraint-preservation';
import { DriftTracker } from '../ledger/drift-tracker';
import { validateBundleAst } from './ast';

export * from './ast';

export interface ValidationOptions {
  readonly maxDriftThreshold?: number | undefined;
}

/**
 * Validates the optimization result by performing AST validation, verifying
 * imperative constraint directive retention, and calculating semantic drift.
 */
export function validate(
  before: ContextBundle,
  after: ContextBundle,
  _plan: OptimizationPlan,
  budget: OptimizationBudget,
  options?: ValidationOptions,
): ValidationReport {
  const issues: ValidationIssue[] = [];

  // 1. Run AST Validation on optimized bundle
  const astResult = validateBundleAst(after);
  if (!astResult.valid) {
    for (const issue of astResult.issues) {
      issues.push({
        code: issue.code,
        message: `AST Error in item [${issue.itemId}] at line ${issue.line ?? 0}, col ${issue.column ?? 0}: ${issue.message}`,
        severity: 'error',
      });
    }
  }

  // 2. Verify Constraint Directive Retention
  const beforeDirectives = collectBundleDirectives(before);
  const afterContentCombined = after.items.map((i) => i.content).join('\n');

  for (const directive of beforeDirectives) {
    if (!afterContentCombined.includes(directive)) {
      issues.push({
        code: 'CONSTRAINT_DIRECTIVE_LOST',
        message: `Imperative constraint directive dropped during optimization: "${directive}"`,
        severity: 'error',
      });
    }
  }

  // 3. Evaluate Semantic Drift Tracker
  const driftTrackerOptions = options?.maxDriftThreshold !== undefined ? { maxDriftThreshold: options.maxDriftThreshold } : {};
  const driftTracker = new DriftTracker(driftTrackerOptions);
  const driftReport = driftTracker.calculateDrift(before, after);

  if (driftReport.shouldFallback) {
    issues.push({
      code: 'SEMANTIC_DRIFT_EXCEEDED',
      message:
        driftReport.reason ??
        `Semantic drift metric (${driftReport.driftScore.toFixed(2)}) exceeds maximum threshold (${(options?.maxDriftThreshold ?? 0.40).toFixed(2)}).`,
      severity: 'error',
    });
  }

  // 4. Verify Budget Boundary Compliance
  if (typeof budget?.maxInputTokens === 'number' && budget.maxInputTokens > 0) {
    if (after.summary.tokenEstimate > budget.maxInputTokens) {
      issues.push({
        code: 'BUDGET_EXCEEDED',
        message: `Optimized bundle token estimate (${after.summary.tokenEstimate}) exceeds maxInputTokens budget (${budget.maxInputTokens}).`,
        severity: 'error',
      });
    }
  }

  const passed = issues.length === 0;
  const shouldFallback = !passed;
  const confidence = passed ? 1 : 0;
  const reason = issues.length > 0 ? issues.map((i) => i.message).join('; ') : undefined;

  return {
    passed,
    confidence,
    issues: Object.freeze(issues),
    shouldFallback,
    driftReport,
    ...(reason ? { reason } : {}),
  };
}

function collectBundleDirectives(bundle: ContextBundle): string[] {
  const directives: string[] = [];
  for (const item of bundle.items) {
    if (typeof item.metadata.constraintDirectives === 'string') {
      try {
        const parsed = JSON.parse(item.metadata.constraintDirectives);
        if (Array.isArray(parsed)) {
          for (const d of parsed) {
            if (typeof d === 'string') {
              directives.push(d);
            }
          }
          continue;
        }
      } catch {
        // Fall back to scanning content
      }
    }

    const { directives: scanned } = extractConstraintDirectives(item.content);
    directives.push(...scanned);
  }
  return directives;
}
