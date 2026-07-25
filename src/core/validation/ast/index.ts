import type { ContextBundle, ContextItem } from '../../model/types';
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
}

const tsValidator = new TypeScriptValidator();
const jsonValidator = new JsonValidator();
const pythonValidator = new PythonValidator();

/**
 * Selects an appropriate AST validator for a given ContextItem based on language, path, and content type.
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

  if (item.contentType === 'json') {
    return jsonValidator;
  }

  if (item.contentType === 'code') {
    return tsValidator;
  }

  return null;
}

/**
 * Validates a single ContextItem's syntax using language-specific AST rules while enforcing SLA (<5ms).
 */
export function validateItemAst(item: ContextItem, options?: AstValidatorOptions): AstValidatorResult {
  const maxTimeMs = options?.maxTimeMs ?? 5;
  const startTime = performance.now();

  const validator = selectValidator(item);
  let baseResult: AstValidatorResult;

  if (!validator) {
    baseResult = {
      valid: true,
      issues: Object.freeze([]),
      durationMs: performance.now() - startTime,
    };
  } else {
    baseResult = validator.validate(item.content, options);
  }

  const durationMs = performance.now() - startTime;

  if (durationMs > maxTimeMs) {
    const slaIssue: AstIssue = {
      code: 'AST_SLA_EXCEEDED',
      message: `AST validation exceeded SLA threshold (${durationMs.toFixed(2)}ms > ${maxTimeMs}ms)`,
    };
    return {
      valid: false,
      issues: Object.freeze([...baseResult.issues, slaIssue]),
      durationMs,
    };
  }

  return {
    ...baseResult,
    durationMs,
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
  let valid = true;

  for (const item of bundle.items) {
    const itemResult = validateItemAst(item, options);
    itemResults[item.id] = itemResult;

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
  };
}
