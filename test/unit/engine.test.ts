import { describe, expect, it } from 'vitest';
import { parse } from '../../src/adapters/cli';
import { optimize } from '../../src/core/engine';
import { loadConfig } from '../../src/config';
import { createContextBundle, createOptimizationBudget } from '../../src/core/model/constructors';

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

  it('emits optimized output when fallback is not used', () => {
    const config = loadConfig();
    // Use manual request to bypass CLI parsing and force 'auto' mode
    const bundle = {
      ...createContextBundle('test', 'text'),
      items: [
        { id: '1', kind: 'prompt', content: 'system prompt', contentHash: 'h1', contentType: 'text', origin: 'prompt', role: 'system', metadata: {} },
        { id: '2', kind: 'file', content: 'very long file content '.repeat(100), contentHash: 'h2', contentType: 'text', origin: 'file', role: 'user', metadata: {} },
      ],
      summary: { itemCount: 2, tokenEstimate: 500, preview: '' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      statistics: { itemCount: 2, totalCharacters: 5000, contentTypeCounts: {} as any, kindCounts: {} as any },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const request = {
      rawInput: 'original input',
      config,
      budget: { ...createOptimizationBudget(config.budget), maxInputTokens: 50, preserveKinds: ['prompt'] },
      trace: { planMode: 'auto' as const, requestId: 'test' },
      bundle: bundle,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = optimize(request);

    expect(result.fallbackUsed).toBe(false);
    expect(result.emittedOutput).not.toBe('original input');
    expect(result.emittedOutput).toContain('system prompt');
    expect(result.emittedOutput).not.toContain('very long file content');
  });
});
