import { describe, expect, it } from 'vitest';
import type {
  ContextBundle,
  ContextItem,
  OptimizationBudget,
  OptimizationPlan,
  OptimizationRequest,
  OptimizationResult,
  OptimizationTrace,
  ValidationReport,
} from '../../src/core/model';

describe('core model', () => {
  it('constructs immutable request and result shapes', () => {
    const item: ContextItem = {
      itemId: 'item-1',
      kind: 'prompt',
      content: 'sample',
      origin: 'test',
      metadata: {},
    };

    const bundle: ContextBundle = {
      bundleId: 'bundle-1',
      source: 'cli',
      items: [item],
      summary: {
        itemCount: 1,
        tokenEstimate: 2,
        preview: 'sample',
      },
      contentHash: 'deadbeef',
    };

    const budget: OptimizationBudget = {
      maxInputTokens: 100,
      maxOutputTokens: 100,
      targetReductionRatio: 0,
      maxLatencyMs: 1000,
      riskTolerance: 'low',
      preserveKinds: [],
    };

    const plan: OptimizationPlan = {
      planId: 'plan-1',
      mode: 'pass_through',
      stageIds: [],
      revalidationPoints: ['end'],
      fallbackPolicy: 'original_input',
      expectedSavings: 0,
    };

    const validation: ValidationReport = {
      passed: true,
      confidence: 1,
      issues: [],
      shouldFallback: false,
    };

    const trace: OptimizationTrace = {
      requestId: 'request-1',
      planMode: 'pass_through',
      stageCount: 0,
      stageTraces: [],
      tokenBefore: 2,
      tokenAfter: 2,
      fallbackUsed: false,
    };

    const request: OptimizationRequest = {
      requestId: 'request-1',
      rawInput: 'sample',
      bundle,
      budget,
      config: {
        appName: 'TokenDamper',
        appVersion: '0.1.0',
        appMode: 'optimize',
        traceOutput: 'stderr',
        planner: {
          defaultMode: 'pass_through',
        },
        budget,
        validation: {
          minimumConfidence: 1,
        },
        logging: {
          level: 'info',
        },
      },
      adapterName: 'cli',
      adapterVersion: '0.1.0',
    };

    const result: OptimizationResult = {
      finalBundle: bundle,
      emittedOutput: 'sample',
      validation,
      trace,
      fallbackUsed: false,
    };

    expect(item).toMatchObject({ itemId: 'item-1', kind: 'prompt' });
    expect(bundle.summary.itemCount).toBe(1);
    expect(plan.mode).toBe('pass_through');
    expect(request.rawInput).toBe('sample');
    expect(result.emittedOutput).toBe('sample');
  });
});
