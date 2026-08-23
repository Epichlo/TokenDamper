import type {
  AstCoverage,
  ContextBundle,
  ContextItem,
  DriftCoverage,
  FailureAttribution,
  LanguageSupportReport,
  OptimizationBudget,
  OptimizationPlan,
  ValidationIssue,
  ValidationReport,
} from '../model';
import { extractConstraintDirectives } from '../../stages/cleanup/constraint-preservation';
import { DriftTracker } from '../ledger/drift-tracker';
import { validateBundleAst } from './ast';
import { describeLanguageSupport } from './language-support';

export * from './ast';
export * from './language-support';

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
        itemId: issue.itemId,
      });
    }
  }

  // 2. Verify Constraint Directive Retention — per item, not over a joined blob (audit H6).
  //
  // This used to collect every item's directives into one list and test each against
  // `after.items.map(i => i.content).join('\n')`. Two things were wrong with that. A directive
  // extracted from item A was satisfied if the string happened to appear anywhere in item B, so
  // the check could pass for content that was in fact destroyed; and there was no attribution,
  // so a loss anywhere failed the whole run with no way to say where. Matching by item id fixes
  // both, and the message now names the item.
  //
  // An item absent from `after` is skipped, following the same reasoning `DriftTracker`'s
  // `findUnwitnessedItems` records: the planner exists to drop items under a budget the caller
  // set, and selection is not elision. Failing here would make any prunable item carrying an
  // imperative unprunable.
  const afterById = new Map(after.items.map((item) => [item.id, item]));

  for (const item of before.items) {
    const afterItem = afterById.get(item.id);
    if (!afterItem) continue;

    for (const directive of collectItemDirectives(item)) {
      if (!afterItem.content.includes(directive)) {
        issues.push({
          code: 'CONSTRAINT_DIRECTIVE_LOST',
          message: `Imperative constraint directive dropped from item [${item.id}]: "${directive}"`,
          severity: 'error',
          itemId: item.id,
        });
      }
    }
  }

  // 3. Evaluate Semantic Drift Tracker
  const driftTrackerOptions = options?.maxDriftThreshold !== undefined ? { maxDriftThreshold: options.maxDriftThreshold } : {};
  const driftTracker = new DriftTracker(driftTrackerOptions);

  // Reuse the coverage computed in step 1. `validateBundleAst` ran over `after`, and elision
  // carries `id`, `path`, `language` and `contentType` through unchanged, so an item covered
  // after was covered before — no second AST pass, and no second copy of the validator
  // precedence rules to drift out of sync.
  //
  // This is now **reporting only**. Until Phase A it also scoped the unwitnessed-item rule,
  // so the rule could not fire on anything no validator covered — which is precisely the
  // population that was being deleted unwitnessed. `calculateDrift` no longer takes it.
  //
  // **`symbolBearingItems` counts validator-covered items, not items bearing symbols, and the
  // name is wrong rather than loose (DECISIONS §60).** It is `astChecked` computed a second
  // way. Nothing had ever made the difference visible, because until §59 every language with
  // symbols also had a validator and every language without one had neither — so the two
  // counts agreed by coincidence of coverage, not by construction.
  //
  // Go between §59 and §60 was the first case where they came apart, and the pair is
  // self-contradicting: measured over 80 frozen Go files on the file route, **all 80** report
  // `symbolsBefore = 3` or more next to `symbolBearingItems = 0`. `symbolsBefore` is the field
  // that actually counts symbols; read that one.
  //
  // Left as it is here on purpose. It is a trace field consumers parse, so renaming it (or,
  // worse, making it count what its name says and moving the number for every language) is a
  // decision with its own blast radius, not a ride-along in the commit that exposed it.
  const symbolBearingItemIds = new Set(after.items.filter((item) => !unchecked.has(item.id)).map((item) => item.id));

  // Computed over `before`, not `after`: the question is what this build could have done to the
  // input, which is a property of the input's languages and does not depend on what the stages
  // managed to do (audit H2).
  const languageSupport: LanguageSupportReport = describeLanguageSupport(before);

  const driftReport = driftTracker.calculateDrift(before, after);

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
    const unmeasurable = driftReport.measurementGate === 'refuse';
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

  // 6. Report language support, without voting on it either.
  //
  // An unsupported language is not an error — pass-through is byte-identical and correct. What
  // it must not do is look like a supported language that happened to have nothing worth
  // removing. Those two produce the identical `reductionRatio: 0` and only one of them is about
  // the user's file (audit H2). This is the same correction M5a made for budgets.
  if (languageSupport.unsupported > 0) {
    const languages = languageSupport.unsupportedLanguages.join(', ');
    issues.push({
      code: 'LANGUAGE_NOT_ELIDIBLE',
      message: languageSupport.noneSupported
        ? `No elision transform in this build can reduce ${languages}: there is no sub-item region selector for it, and whole-item elision cannot survive the drift gate. Elision reduces TypeScript/JavaScript and Python only. A 0% result here is structural, not a property of this input.`
        : `${languageSupport.unsupported} of ${before.items.length} item(s) are in a language elision cannot reduce (${languages}); only whole-item pruning can affect them.`,
      severity: 'info',
    });
  }

  // 7. Attribute the failures, so the engine can decide whether a repair is possible.
  //
  // `SEMANTIC_DRIFT_UNMEASURABLE` is attributable even though it carries no `itemId`: the
  // measurement gate refuses specific items and `driftReport.unwitnessedItemIds` names them
  // (§33). `SEMANTIC_DRIFT_EXCEEDED` is not — `S_k` is a whole-bundle set comparison.
  const errorIssues = issues.filter((issue) => issue.severity === 'error');
  const repairable = new Set<string>();
  let hasUnattributableError = false;

  for (const issue of errorIssues) {
    if (issue.itemId !== undefined) {
      repairable.add(issue.itemId);
      continue;
    }
    if (issue.code === 'SEMANTIC_DRIFT_UNMEASURABLE' && driftReport.unwitnessedItemIds.length > 0) {
      for (const id of driftReport.unwitnessedItemIds) repairable.add(id);
      continue;
    }
    hasUnattributableError = true;
  }

  const attribution: FailureAttribution = {
    repairableItemIds: Object.freeze([...repairable].sort()),
    hasUnattributableError,
  };

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
    languageSupport,
    attribution,
    ...(reason ? { reason } : {}),
  };
}

/**
 * The imperative directives attributable to one item.
 *
 * Prefers what `cleanup:constraint-preservation` recorded, and falls back to scanning when the
 * stage did not run — the Gateway plans only `cleanup:session-dedup`, so metadata is absent
 * there. Both paths now scan **prose regions only** (`extractProseRegions`, audit H6), so the
 * two agree; before that, the fallback scan and the stage could disagree about what counted.
 */
function collectItemDirectives(item: ContextItem): string[] {
  if (typeof item.metadata.constraintDirectives === 'string') {
    try {
      const parsed = JSON.parse(item.metadata.constraintDirectives);
      if (Array.isArray(parsed)) {
        return parsed.filter((d): d is string => typeof d === 'string');
      }
    } catch {
      // Fall back to scanning content
    }
  }

  return [...extractConstraintDirectives(item.content, item.contentType).directives];
}
