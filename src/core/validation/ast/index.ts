import type { ContentType, ContextBundle, ContextItem } from '../../model/types';
import { JsonValidator } from './json-validator';
import { PythonValidator } from './python-validator';
import { TypeScriptValidator } from './ts-validator';
import type {
  AstIssue,
  AstValidator,
  AstValidatorOptions,
  AstValidatorResult,
} from './types';

export * from './types';
export * from './ts-validator';
export * from './json-validator';
export * from './python-validator';

export interface BundleAstValidationResult {
  readonly valid: boolean;
  readonly issues: ReadonlyArray<AstIssue & { readonly itemId: string }>;
  readonly durationMs: number;
  readonly itemResults: Readonly<Record<string, AstValidatorResult>>;
  /**
   * Items for which no validator applied, so `valid` says nothing about them. Empty is the
   * only value that makes `valid: true` mean "every item was examined and passed".
   */
  readonly unvalidatedItemIds: ReadonlyArray<string>;
}

const tsValidator = new TypeScriptValidator();
const jsonValidator = new JsonValidator();
const pythonValidator = new PythonValidator();

/**
 * The complete map from `ContentType` to the validator that governs it.
 *
 * `Record<ContentType, …>` is the point: adding a member to `ContentType` without deciding
 * what validates it is a compile error, so `classifyContent` cannot produce a tag that
 * dispatch has never heard of. That is the property that failed here — `classifyContent`
 * gained the ability to return `html` for ordinary code, dispatch had no `html` branch, and
 * the resulting `null` was indistinguishable from a pass.
 *
 * A `null` entry is a decision, not an omission: there is no AST-lite validator for prose,
 * markup, YAML or log output, and pretending otherwise is what DECISIONS §17 removed. What
 * changed is that the decision is now recorded on the result (`validated: false`) instead of
 * disappearing into `valid: true`.
 */
const CONTENT_TYPE_VALIDATORS: Readonly<Record<ContentType, AstValidator | null>> = {
  json: jsonValidator,
  // `code` is set from a file extension covering ~19 languages, of which the AST-lite suite
  // implements three. TypeScript is the historical default for the rest; `language` and
  // `path` below are the precise routes and are consulted first.
  code: tsValidator,
  text: null,
  markdown: null,
  html: null,
  yaml: null,
  logs: null,
  unknown: null,
};

/**
 * Selects an appropriate AST validator for a given ContextItem based on language, path, and
 * content type, in that order of precedence.
 *
 * `null` means "no validator covers this item". It does **not** mean the item is fine — read
 * `AstValidatorResult.validated` for that distinction.
 */
export function selectValidator(item: ContextItem): AstValidator | null {
  const lang = item.language?.toLowerCase();
  if (lang) {
    if (['ts', 'typescript', 'js', 'javascript', 'jsx', 'tsx'].includes(lang)) {
      return tsValidator;
    }
    if (lang === 'json') {
      return jsonValidator;
    }
    if (['py', 'python'].includes(lang)) {
      return pythonValidator;
    }
  }

  if (item.path) {
    const ext = item.path.split('.').pop()?.toLowerCase();
    if (ext && ['ts', 'tsx', 'js', 'jsx', 'cjs', 'mjs'].includes(ext)) {
      return tsValidator;
    }
    if (ext === 'json') {
      return jsonValidator;
    }
    if (ext === 'py') {
      return pythonValidator;
    }
  }

  // Indexed rather than branched, and tolerant of a forged tag at the runtime edge: an
  // unknown string must not throw here, because this sits inside the fail-open path
  // (invariant 3).
  return CONTENT_TYPE_VALIDATORS[item.contentType] ?? null;
}

/**
 * Validates a single ContextItem's syntax using language-specific AST rules, and measures
 * the run against a latency budget (5ms per item by default).
 *
 * **The budget is reported, not enforced as a verdict.** It used to return `valid: false`
 * with an `AST_SLA_EXCEEDED` issue, which made a timing measurement decide a syntax
 * question. That is wrong twice over:
 *
 *  - It is non-deterministic. Identical bytes validated differently depending on machine
 *    load and JIT warmth — measured across six fresh processes on a 16 KB Python file:
 *    `valid(4.06ms) INVALID(5.28ms) INVALID(6.86ms) INVALID(8.04ms) INVALID(14.70ms)
 *    INVALID(17.58ms)`. Determinism is the product.
 *  - It made the engine fall back on large but perfectly valid files, reporting a syntax
 *    error where there was none. `codebase.py` (16 KB) fell back on
 *    `AST validation exceeded SLA threshold (5.99ms > 5ms)` with drift at 0.00 and every
 *    other check passing.
 *
 * `slaExceeded` on the result carries the signal for anyone who wants to act on latency.
 */
export function validateItemAst(item: ContextItem, options?: AstValidatorOptions): AstValidatorResult {
  const maxTimeMs = options?.maxTimeMs ?? 5;
  const startTime = performance.now();

  const validator = selectValidator(item);

  if (!validator) {
    const durationMs = performance.now() - startTime;
    return {
      // `valid` stays true: an item nothing covers is not a failing item, and inverting this
      // would fall the engine back on every prose message. `validated: false` is what says
      // nothing was examined.
      valid: true,
      validated: false,
      issues: Object.freeze([]),
      durationMs,
      slaExceeded: durationMs > maxTimeMs,
    };
  }

  const baseResult = validator.validate(item.content, options);
  const durationMs = performance.now() - startTime;

  return {
    ...baseResult,
    validated: true,
    validatorLanguage: validator.language,
    durationMs,
    slaExceeded: durationMs > maxTimeMs,
  };
}

/**
 * Validates all items in a ContextBundle and aggregates the AST validation results.
 */
export function validateBundleAst(
  bundle: ContextBundle,
  options?: AstValidatorOptions,
): BundleAstValidationResult {
  const startTime = performance.now();
  const itemResults: Record<string, AstValidatorResult> = {};
  const bundleIssues: Array<AstIssue & { readonly itemId: string }> = [];
  const unvalidatedItemIds: string[] = [];
  let valid = true;

  for (const item of bundle.items) {
    const itemResult = validateItemAst(item, options);
    itemResults[item.id] = itemResult;

    if (!itemResult.validated) {
      unvalidatedItemIds.push(item.id);
    }

    if (!itemResult.valid) {
      valid = false;
      for (const issue of itemResult.issues) {
        bundleIssues.push({
          ...issue,
          itemId: item.id,
        });
      }
    }
  }

  const durationMs = performance.now() - startTime;
  return {
    valid,
    issues: Object.freeze(bundleIssues),
    durationMs,
    itemResults: Object.freeze(itemResults),
    unvalidatedItemIds: Object.freeze(unvalidatedItemIds),
  };
}
