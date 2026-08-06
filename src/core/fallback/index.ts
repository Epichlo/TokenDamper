import type { OptimizationRequest, ValidationReport, ContextBundle } from '../model';

/**
 * The explicit fallback outcome for the frozen MVP.
 */
export interface FallbackOutcome {
  readonly used: boolean;
  readonly output: string;
  readonly reason?: string;
}

/**
 * Resolves the explicit fallback decision for the current request.
 *
 * **Two branches, and they are not symmetric.**
 *
 * The fallback branch echoes `request.rawInput` and touches no part of the bundle render
 * model, which is what makes byte-identity structural rather than test-enforced. (It is
 * byte-identical only as far as the string model reaches — the CLI additionally refuses input
 * that does not survive a UTF-8 round-trip, because `rawInput` is itself a decoded string.
 * See `EngineOptimizationOptions.inputNotRepresentable`.)
 *
 * The success branch renders by joining item contents with `\n`, and **that join is lossy for
 * a multi-item bundle**: it discards item boundaries, roles and every enclosing structure, so
 * a provider payload rendered this way is a text blob rather than a request. It has no live
 * consumer today and that is checked, not assumed — every route that reads `emittedOutput`
 * (CLI, MCP, bench) builds its bundle through `createOptimizationRequest` ->
 * `createContextBundle`, which produces exactly **one** item. The only multi-item producer is
 * the Gateway, which maps `finalBundle` positionally back onto the parsed payload and never
 * touches `emittedOutput` — invariant 9, and the reason that invariant exists.
 *
 * So this is a latent defect, held latent by a convention in two other files. If you make any
 * `emittedOutput` consumer multi-item, this join is what you will get.
 * `test/unit/fallback-render.test.ts` pins the behaviour so the change is loud.
 */
export function resolveFallback(request: OptimizationRequest, validation: ValidationReport, currentBundle: ContextBundle): FallbackOutcome {
  if (!validation.shouldFallback) {
    return {
      used: false,
      output: currentBundle.items.map(i => i.content).join('\n'),
    };
  }

  return {
    used: true,
    output: request.rawInput,
    reason: validation.reason ?? 'validation_failed',
  };
}
