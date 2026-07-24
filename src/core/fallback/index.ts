import type { OptimizationRequest, ValidationReport } from '../model';

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
export function resolveFallback(request: OptimizationRequest, validation: ValidationReport): FallbackOutcome {
  if (!validation.shouldFallback) {
    return {
      used: false,
      output: request.rawInput,
    };
  }

  return {
    used: true,
    output: request.rawInput,
    reason: validation.reason ?? 'validation_failed',
  };
}
