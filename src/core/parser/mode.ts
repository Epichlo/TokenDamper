/**
 * Which engine backend answers the three language questions.
 *
 * Lives in its own module rather than in `types.ts` because `AstValidatorOptions` needs it and
 * `parser/types.ts` already imports from `validation/ast/types.ts` — putting it there closes an
 * import cycle. `types.ts` re-exports both names, so every existing import keeps working.
 *
 * **Invariant 1 is per-configuration, and this type is why.** "Same input, same bytes out"
 * reads as absolute in `ARCHITECTURE.md`; with a second backend it becomes *same input, same
 * mode, same bytes out*. Fast and Deep differing on one file is the feature rather than a
 * violation — what would be a violation is either of them being non-deterministic within itself.
 */
export type EngineMode = 'fast' | 'deep';

/** The default, and the only value any shipped entry mode passes today. */
export const DEFAULT_ENGINE_MODE: EngineMode = 'fast';
