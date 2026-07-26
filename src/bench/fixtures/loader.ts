import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createOptimizationRequest } from '../../core/model/constructors';
import type { OptimizationBudget, OptimizationRequest, ResolvedConfig } from '../../core/model/types';
import { loadConfig } from '../../config/load';
import { loadCodeXGLUEFixtures } from './codexglue';
import { loadHumanEvalFixtures } from './humaneval';
import type { BenchmarkFixture, BenchmarkFixtureSet } from './types';

/**
 * Universal dataset loader that loads HumanEval, CodeXGLUE, or a combined benchmark fixture set.
 */
export function loadBenchmarkFixtures(datasetPathOrName?: string): BenchmarkFixtureSet {
  if (!datasetPathOrName || datasetPathOrName.trim().length === 0) {
    const humaneval = loadHumanEvalFixtures();
    const codexglue = loadCodeXGLUEFixtures();
    const combinedFixtures = [...humaneval.fixtures, ...codexglue.fixtures];
    return Object.freeze({
      datasetName: 'combined',
      fixtures: Object.freeze(combinedFixtures),
      count: combinedFixtures.length,
    });
  }

  const normalized = datasetPathOrName.toLowerCase();

  if (normalized === 'humaneval' || normalized.includes('humaneval')) {
    return loadHumanEvalFixtures(datasetPathOrName === 'humaneval' ? undefined : datasetPathOrName);
  }

  if (normalized === 'codexglue' || normalized.includes('codexglue')) {
    return loadCodeXGLUEFixtures(datasetPathOrName === 'codexglue' ? undefined : datasetPathOrName);
  }

  const absPath = resolve(process.cwd(), datasetPathOrName);
  if (existsSync(absPath)) {
    try {
      const content = readFileSync(absPath, 'utf-8');
      if (content.includes('task_id') || content.includes('canonical_solution')) {
        return loadHumanEvalFixtures(absPath);
      }
    } catch {
      // Fall through to CodeXGLUE loader
    }
    return loadCodeXGLUEFixtures(absPath);
  }

  throw new Error(`Unknown benchmark dataset path or identifier: "${datasetPathOrName}"`);
}

/**
 * Converts a BenchmarkFixture into a normalized TokenDamper OptimizationRequest with specified budget.
 */
export function fixtureToOptimizationRequest(
  fixture: BenchmarkFixture,
  budget: OptimizationBudget,
  config?: Partial<ResolvedConfig> | ResolvedConfig,
  requestId?: string,
): OptimizationRequest {
  const safeId = fixture.id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const reqId = requestId ?? `bench-${safeId}-${Date.now()}`;

  const baseConfig = loadConfig();
  const mergedConfig: ResolvedConfig = {
    ...baseConfig,
    ...config,
    budget: { ...baseConfig.budget, ...config?.budget },
    validation: { ...baseConfig.validation, ...config?.validation },
    ...((baseConfig as any)?.limits || (config as any)?.limits
      ? { limits: { ...(baseConfig as any)?.limits, ...(config as any)?.limits } }
      : {}),
  } as unknown as ResolvedConfig;

  const baseRequest = createOptimizationRequest(fixture.prompt, mergedConfig, {
    requestId: reqId,
    adapterName: 'bench',
    adapterVersion: '0.1.0',
    source: 'file',
    sourcePath: fixture.path,
  });

  return Object.freeze({
    ...baseRequest,
    budget,
  });
}

