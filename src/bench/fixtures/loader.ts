import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createOptimizationRequest } from '../../core/model/constructors';
import type {
  OptimizationBudget,
  OptimizationRequest,
  ResolvedConfig,
} from '../../core/model/types';
import { loadConfig } from '../../config/load';
import { TOKENDAMPER_VERSION } from '../../version';
import { loadCodeXGLUEFixtures } from './codexglue';
import { loadHumanEvalFixtures } from './humaneval';
import type { BenchmarkFixture, BenchmarkFixtureSet } from './types';

/**
 * Universal dataset loader that loads HumanEval, CodeXGLUE, or a combined benchmark fixture set.
 */
export function loadBenchmarkFixtures(datasetPathOrName?: string): BenchmarkFixtureSet {
  if (!datasetPathOrName || datasetPathOrName.trim().length === 0 || namesADirectory(datasetPathOrName)) {
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
 * A directory argument means "the datasets under here", not "this file".
 *
 * Handled before the name checks below because the path this most often carries is
 * `test/fixtures/bench`, whose contents are exactly the bundled pair. Without it the branch
 * below reached `readFileSync` on a directory and threw `EISDIR` — the CLI has always
 * pre-empted that at its own call site, so only direct API callers ever saw it (audit M10).
 */
function namesADirectory(datasetPathOrName: string): boolean {
  const absPath = resolve(process.cwd(), datasetPathOrName);
  return existsSync(absPath) && statSync(absPath).isDirectory();
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
    ...((baseConfig as unknown as Record<string, unknown>)?.limits ||
    (config as unknown as Record<string, unknown>)?.limits
      ? {
          limits: {
            ...((baseConfig as unknown as Record<string, unknown>)?.limits as object),
            ...((config as unknown as Record<string, unknown>)?.limits as object),
          },
        }
      : {}),
  } as unknown as ResolvedConfig;

  // `language` as well as `path` — the third construction site, and the one that was still
  // guessing with the answer in hand. `BenchmarkFixture.language` is a *required* field, and
  // this call dropped it and let `classifyContent` re-derive a content type from the filename.
  // For a fixture whose path agrees with its language that is merely redundant; for a
  // CodeXGLUE item with no `path` it is the 4b.1 defect inside the harness that publishes this
  // project's numbers. `codexglue.ts` synthesizes `src/item_<id>.txt` for those, which
  // classifies `text`, so a Python fixture reached the engine with no validator, no elision
  // regions and a guaranteed fallback:
  //
  //   language "python"  path src/item_pathless-1.txt  contentType text
  //   astCoverage {checked: 0, unchecked: 1}  fallback true  133 -> 133 tokens
  //
  // The bundled fixtures all carry paths that agree with their language, so declaring moves
  // no published number — verified fixture-by-fixture, not assumed.
  const baseRequest = createOptimizationRequest(fixture.prompt, mergedConfig, {
    requestId: reqId,
    adapterName: 'bench',
    adapterVersion: TOKENDAMPER_VERSION,
    source: 'file',
    sourcePath: fixture.path,
    language: fixture.language,
  });

  return Object.freeze({
    ...baseRequest,
    budget,
  });
}
