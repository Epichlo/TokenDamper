import type { ContentType, ContextBundle, ContextItem } from '../../model/types';
import { GoValidator } from './go-validator';
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
export * from './go-validator';

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
const goValidator = new GoValidator();

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
  // `code` is a *family*, not a language, so it selects nothing. It used to select the
  // TypeScript validator as a historical default for the ~19 extensions `isCodeExtension`
  // covers, which meant every language outside the TS family was lexed by a scanner written
  // for a different grammar. That is not a weaker check; it is a check that invents findings:
  //
  //   shell       22 of 40   (55%)  AST_UNTERMINATED_STRING / AST_UNBALANCED_BRACKET
  //   powershell   7 of 40   (18%)
  //   perl        39 of 40   (98%)   ← what adding `.pl` to the list would have bought
  //   tcl         30 of 40   (75%)
  //   c / css      0 of 50    (0%)   ← C-family; the scanner happens to fit, and finds nothing
  //
  // Shell and PowerShell are *in* `isCodeExtension` today, so those are live false verdicts
  // on the file route: `$'…'` quoting, `'` inside comments, `${…}` expansion and `[[ … ]]`
  // tests are all ordinary syntax that a TS lexer reads as an unterminated string or an
  // unbalanced bracket. This is DECISIONS §17's finding — a verdict decided by apostrophe
  // parity is not validating anything — reached from the extension side instead of the fence
  // side, and it is removed for the same reason rather than tuned.
  //
  // Nothing that was genuinely covered loses coverage: TypeScript, JavaScript, Python and
  // JSON all reach their validator through the `language` and `path` branches in
  // `selectValidator`, which run *first* and are unchanged. What changes is that the
  // remainder now report `validated: false` and appear on `trace.astCoverage`, which is
  // §23's distinction — an unexamined item is not a passing one.
  //
  // **Go joined that list in §60 and did not change this entry.** It reaches `GoValidator`
  // through the same two branches, by its own grammar rather than by being lexed as
  // TypeScript — which is the distinction this `null` exists to preserve, not one it
  // contradicts.
  code: null,
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
    if (['go', 'golang'].includes(lang)) {
      return goValidator;
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
    if (ext === 'go') {
      return goValidator;
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
