import { describe, expect, it } from 'vitest';
import { plan, planOptimizationMode } from '../../src/core/planner';
import { createContextBundle, createOptimizationBudget } from '../../src/core/model';
import type { ResolvedConfig } from '../../src/core/model';

describe('planner', () => {
  const baseConfig: ResolvedConfig = {
    appName: 'TokenDamper',
    appVersion: '0.1.0',
    appMode: 'optimize',
    traceOutput: 'stderr',
    planner: {
      defaultMode: 'pass_through',
    },
    budget: createOptimizationBudget({ riskTolerance: 'low' }),
    validation: {
      minimumConfidence: 1,
    },
    logging: {
      level: 'info',
    },
  };

  it('returns pass-through plan when maxInputTokens is not set', () => {
    const bundle = createContextBundle('sample text', 'text');
    const budget = createOptimizationBudget({
      targetReductionRatio: 0,
      riskTolerance: 'low',
      preserveKinds: [],
    });

    const result = plan(bundle, budget, baseConfig, []);

    expect(result.mode).toBe('pass_through');
    expect(result.stageIds).toHaveLength(0);
    expect(result.fallbackPolicy).toBe('original_input');
    expect(planOptimizationMode(budget)).toBe('pass_through');
  });

  it('selects topology_knapsack plan when maxInputTokens is set', () => {
    const bundle = createContextBundle('sample text', 'text');
    const budget = createOptimizationBudget({
      maxInputTokens: 500,
      riskTolerance: 'medium',
      preserveKinds: [],
    });

    const result = plan(bundle, budget, baseConfig, []);

    expect(result.mode).toBe('topology_knapsack');
    expect(result.stageIds).toEqual([
      'cleanup:constraint-preservation',
      'pruning:topology-pruner',
      'compression:token-hashing',
      'compression:delta-compression',
    ]);
    expect(result.expectedSavings).toBe(0.45);
    expect(planOptimizationMode(budget)).toBe('topology_knapsack');
  });

  it('plans only session-dedup when the config pins session_dedup mode (1.0b)', () => {
    const bundle = createContextBundle('sample text', 'text');
    // A budget that would otherwise select knapsack mode; explicit session_dedup wins,
    // keeping token-hashing (Issue 2) away from live Gateway payloads.
    const budget = createOptimizationBudget({
      maxInputTokens: 500,
      targetReductionRatio: 0.5,
      riskTolerance: 'low',
    });
    const gatewayConfig: ResolvedConfig = {
      ...baseConfig,
      planner: { defaultMode: 'session_dedup' },
    };

    const result = plan(bundle, budget, gatewayConfig, []);

    expect(result.mode).toBe('session_dedup');
    expect(result.stageIds).toEqual(['cleanup:session-dedup']);
    expect(result.fallbackPolicy).toBe('original_input');
  });

  it('validates planner inputs', () => {
    const bundle = createContextBundle('sample text', 'text');
    const budget = createOptimizationBudget({ riskTolerance: 'low' });

    expect(() => plan(null as never, budget, baseConfig, [])).toThrow('Planner requires a context bundle');
    expect(() => plan(bundle, null as never, baseConfig, [])).toThrow('Planner requires an optimization budget');
    expect(() => plan(bundle, budget, null as never, [])).toThrow('Planner requires a resolved configuration');
  });
});
