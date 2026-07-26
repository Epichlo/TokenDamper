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
