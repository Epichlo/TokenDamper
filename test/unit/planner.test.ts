import { describe, expect, it } from 'vitest';
import { plan } from '../../src/core/planner';
import { createContextBundle, createOptimizationBudget } from '../../src/core/model';
import type { ResolvedConfig } from '../../src/core/model';

describe('planner', () => {
  it('always returns the pass-through plan', () => {
    const bundle = createContextBundle('sample text', 'text');
    const budget = createOptimizationBudget({
      targetReductionRatio: 0,
      riskTolerance: 'low',
      preserveKinds: [],
    });

    const config: ResolvedConfig = {
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
    };

    const result = plan(bundle, budget, config, []);

    expect(result.mode).toBe('pass_through');
    expect(result.stageIds).toHaveLength(0);
    expect(result.fallbackPolicy).toBe('original_input');
  });

  it('validates planner inputs', () => {
    const bundle = createContextBundle('sample text', 'text');
    const budget = createOptimizationBudget({ riskTolerance: 'low' });
    const config = {
      appName: 'TokenDamper',
      appVersion: '0.1.0',
      appMode: 'optimize',
      traceOutput: 'stderr',
      planner: { defaultMode: 'pass_through' },
      budget,
      validation: { minimumConfidence: 1 },
      logging: { level: 'info' },
    } as ResolvedConfig;

    expect(() => plan(null as never, budget, config, [])).toThrow('Planner requires a context bundle');
    expect(() => plan(bundle, null as never, config, [])).toThrow('Planner requires an optimization budget');
    expect(() => plan(bundle, budget, null as never, [])).toThrow('Planner requires a resolved configuration');
  });
});
