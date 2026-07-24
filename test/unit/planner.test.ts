import { describe, expect, it } from 'vitest';
import { plan } from '../../src/core/planner';
import type { ContextBundle, OptimizationBudget, ResolvedConfig } from '../../src/core/model';

describe('planner', () => {
  it('always returns the pass-through plan', () => {
    const bundle: ContextBundle = {
      bundleId: 'bundle-1',
      source: 'cli',
      items: [],
      summary: {
        itemCount: 0,
        tokenEstimate: 0,
        preview: '',
      },
      contentHash: '00000000',
    };

    const budget: OptimizationBudget = {
      targetReductionRatio: 0,
      riskTolerance: 'low',
      preserveKinds: [],
    };

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
});
