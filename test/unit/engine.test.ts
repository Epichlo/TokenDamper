import { describe, expect, it } from 'vitest';
import { parse } from '../../src/adapters/cli';
import { optimize } from '../../src/core/engine';
import { loadConfig } from '../../src/config';
import {
  createBundleFromItems,
  createContextItem,
  createOptimizationBudget,
} from '../../src/core/model/constructors';

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

  it('emits the rendered bundle, not the raw input, when fallback is not used', () => {
    // **Fixture replaced in Phase A, and the reason matters.**
    //
    // This used to elide a 2,300-character `text` item under `maxInputTokens: 50` and assert
    // the content had vanished with `fallbackUsed: false`. It passed only because the item
    // carried no symbols and no content markers, so `R_AST` and `R_struct` both sat at their
    // empty-set default of 1.0 and `S_k` was 0.00 — a clean score produced by measuring
    // nothing. That is the exact vacuity the measurement gate now refuses, so the old fixture
    // asserted the defect.
    //
    // What this test is *for* is the emit path: a successful run renders the bundle rather
    // than echoing `rawInput` (the fallback branch does the echoing). That is what it asserts
    // now. Reduction-with-no-fallback is covered on real content, where drift genuinely has
    // something to measure, by `declared-language.test.ts` and `python-content-probe.test.ts`.
    const config = loadConfig();
    const bundle = createBundleFromItems(
      [
        createContextItem({ id: '1', kind: 'prompt', content: 'system prompt', role: 'system' }),
        createContextItem({ id: '2', kind: 'file', content: 'file body line one', role: 'user' }),
      ],
      'text',
    );

    const request = {
      rawInput: 'original input',
      config,
      budget: createOptimizationBudget(config.budget),
      trace: { planMode: 'auto' as const, requestId: 'test' },
      bundle,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = optimize(request);

    expect(result.fallbackUsed).toBe(false);
    expect(result.emittedOutput).not.toBe('original input');
    expect(result.emittedOutput).toContain('system prompt');
    expect(result.emittedOutput).toContain('file body line one');
  });
});
