import { describe, expect, it } from 'vitest';
import { parse } from '../../src/adapters/cli';
import { optimize } from '../../src/core/engine';
import { loadConfig } from '../../src/config';

describe('engine', () => {
  it('runs the no-op pipeline end to end', () => {
    const config = loadConfig();
    const request = parse('Hello, TokenDamper.\n', config);
    const result = optimize(request);

    expect(result.emittedOutput).toBe('Hello, TokenDamper.\n');
    expect(result.fallbackUsed).toBe(false);
    expect(result.validation.passed).toBe(true);
    expect(result.trace.requestId).toBe(request.requestId);
    expect(result.trace.planMode).toBe('pass_through');
    expect(result.trace.stageCount).toBe(0);
    expect(result.trace.fallbackUsed).toBe(false);
  });

  it('unconditionally falls back to OptimizationRequest.rawInput when budget is exceeded', () => {
    const config = loadConfig();
    const rawInput = 'System prompt context with imperative directive: You MUST NOT crash.\n'.repeat(10);
    const baseRequest = parse(rawInput, config);

    // Set maxInputTokens to an unachievably low value (5 tokens) while preserving prompt
    const requestWithTightBudget = {
      ...baseRequest,
      budget: {
        ...baseRequest.budget,
        maxInputTokens: 5,
        preserveKinds: ['prompt' as const],
      },
    };

    const result = optimize(requestWithTightBudget);

    expect(result.fallbackUsed).toBe(true);
    expect(result.emittedOutput).toBe(rawInput);
    expect(result.validation.passed).toBe(false);
    expect(result.validation.shouldFallback).toBe(true);
    expect(result.validation.issues.some((i) => i.code === 'BUDGET_EXCEEDED')).toBe(true);
  });
});
