import type {
  AstCoverage,
  ContextBundle,
  DriftCoverage,
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
  const unchecked = new Set(astResult.unvalidatedItemIds);
  const astCoverage: AstCoverage = {
    checked: after.items.length - unchecked.size,
    unchecked: unchecked.size,
    uncheckedContentTypes: Object.freeze([
      ...new Set(after.items.filter((item) => unchecked.has(item.id)).map((item) => item.contentType)),
    ]),
  };

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

  // Reuse the coverage computed in step 1. `validateBundleAst` ran over `after`, and elision
  // carries `id`, `path`, `language` and `contentType` through unchanged, so an item covered
  // after was covered before — no second AST pass, and no second copy of the validator
  // precedence rules to drift out of sync.
  const symbolBearingItemIds = new Set(after.items.filter((item) => !unchecked.has(item.id)).map((item) => item.id));

  const driftReport = driftTracker.calculateDrift(before, after, { symbolBearingItemIds });

  const driftCoverage: DriftCoverage = {
    astMeasured: driftReport.astMeasured,
    structMeasured: driftReport.structMeasured,
    measured: driftReport.measured,
    contentChanged: driftReport.contentChanged,
    symbolsBefore: driftReport.symbolsBeforeCount,
    contentMarkersBefore: driftReport.contentMarkersBeforeCount,
    symbolBearingItems: symbolBearingItemIds.size,
    unwitnessedItems: driftReport.unwitnessedItemIds,
  };

  if (driftReport.shouldFallback) {
    // Two distinct failures, deliberately given two codes. `SEMANTIC_DRIFT_EXCEEDED` means
    // the metric ran and the answer was too high. `SEMANTIC_DRIFT_UNMEASURABLE` means it
    // never ran on anything: content changed, but the pre-optimization bundle offered no
    // symbols and no content-derived markers, so `S_k` is its empty-set default rather than
    // a measurement. Collapsing them into one code would report a threshold breach for a
    // score of 0.00, which reads as a contradiction and hides which defect fired.
    const unmeasurable = driftReport.unwitnessedItemIds.length > 0;
    issues.push({
      code: unmeasurable ? 'SEMANTIC_DRIFT_UNMEASURABLE' : 'SEMANTIC_DRIFT_EXCEEDED',
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

  // 5. Report AST coverage, without voting on it.
  //
  // An item no validator covers is not an error — there is no AST-lite validator for prose,
  // and there should not be one. But it must not be silently counted as a pass either, which
  // is exactly what happened when `classifyContent` began answering `html` for TypeScript:
  // `selectValidator` returned null, `validateItemAst` returned `valid: true`, and broken
  // source reached a provider having been examined by nothing. DECISIONS §23.
  if (astCoverage.unchecked > 0) {
    issues.push({
      code: 'AST_VALIDATION_SKIPPED',
      message: `No AST validator covers ${astCoverage.unchecked} of ${after.items.length} item(s) (content type${astCoverage.uncheckedContentTypes.length === 1 ? '' : 's'}: ${astCoverage.uncheckedContentTypes.join(', ')}); their syntax was not checked.`,
      severity: 'info',
    });
  }

  // Verdicts are error-scoped. `issues.length === 0` was equivalent while every issue pushed
  // here was an error, but it makes the `severity` field decorative and turns any future
  // informational finding into a forced fallback.
  const errors = issues.filter((issue) => issue.severity === 'error');
  const passed = errors.length === 0;
  const shouldFallback = !passed;
  const confidence = passed ? 1 : 0;
  const reason = errors.length > 0 ? errors.map((i) => i.message).join('; ') : undefined;

  return {
    passed,
    confidence,
    issues: Object.freeze(issues),
    shouldFallback,
    driftReport,
    astCoverage,
    driftCoverage,
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
