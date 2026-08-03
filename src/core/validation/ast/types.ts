/**
 * Supported target languages for AST validation.
 */
export type TargetLanguage = 'typescript' | 'javascript' | 'json' | 'python' | 'markdown' | 'unknown' | string;

/**
 * An issue discovered during AST validation.
 */
export interface AstIssue {
  readonly line?: number;
  readonly column?: number;
  readonly message: string;
  readonly code: string;
}

/**
 * The outcome of an AST validation run.
 */
export interface AstValidatorResult {
  readonly valid: boolean;
  readonly issues: ReadonlyArray<AstIssue>;
  readonly durationMs: number;
  /**
   * Whether `durationMs` exceeded the configured budget.
   *
   * Reported, never voted on. A slow validation says nothing about whether the content is
   * syntactically valid, and letting it set `valid: false` made the verdict depend on
   * machine load — see `test/unit/ast-sla-determinism.test.ts`.
   */
  readonly slaExceeded?: boolean;
}

/**
 * Execution options for AST validators.
 */
export interface AstValidatorOptions {
  /**
   * Maximum allowed execution duration in milliseconds. Defaults to 5ms SLA per item.
   */
  readonly maxTimeMs?: number;
}

/**
 * Common interface implemented by language-specific AST validators.
 */
export interface AstValidator {
  readonly language: TargetLanguage;
  validate(content: string, options?: AstValidatorOptions): AstValidatorResult;
}
