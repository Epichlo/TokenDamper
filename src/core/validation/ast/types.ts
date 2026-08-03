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
 * What a language validator reports when it has actually examined content.
 *
 * A validator never constructs the `validated` field: by existing and being called, it *is*
 * the validation. Only `validateItemAst`, which decides whether any validator applies at
 * all, can answer that question — see `AstValidatorResult`.
 */
export interface AstCheckResult {
  readonly valid: boolean;
  readonly issues: ReadonlyArray<AstIssue>;
  readonly durationMs: number;
}

/**
 * The outcome of an AST validation *attempt*, which may be that no validator applied.
 */
export interface AstValidatorResult extends AstCheckResult {
  /**
   * Whether a validator ran at all.
   *
   * This exists because `valid: true` used to mean two different things: "a validator
   * examined this and found no syntax errors" and "no validator covers this content type,
   * so nothing was examined." The second is not a pass, and conflating them is how broken
   * TypeScript reached a provider unexamined once `classifyContent` started answering `html`
   * for code (DECISIONS §23).
   *
   * `valid` deliberately stays `true` when `validated` is `false` — an unchecked item is not
   * a failing item, and flipping it would make every prose message fall back. Callers that
   * care whether a check happened must read this field.
   */
  readonly validated: boolean;
  /** The validator that produced the verdict, absent when `validated` is `false`. */
  readonly validatorLanguage?: TargetLanguage;
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
  validate(content: string, options?: AstValidatorOptions): AstCheckResult;
}
