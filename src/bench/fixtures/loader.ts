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

  // Exact dataset names first, then a real path, and only then the substring guess — audit OX-L10.
  //
  // The substring test used to run before the path check, so any file whose *name* happened to
  // contain "humaneval" or "codexglue" was routed to the bundled loader instead of being read.
  // `./fixtures/humaneval-comparison-2026.jsonl` is a plausible thing to own and an unhelpful
  // thing to have silently ignored, and the failure is quiet: the run succeeds, against the wrong
  // fixtures.
  if (normalized === 'humaneval') {
    return loadHumanEvalFixtures();
  }

  if (normalized === 'codexglue') {
    return loadCodeXGLUEFixtures();
  }

  const absPath = resolve(process.cwd(), datasetPathOrName);
  if (!existsSync(absPath)) {
    // Not an exact name and not a path that exists. The substring guess is the last resort rather
    // than the first, so it can only ever help an argument nothing else could resolve.
    if (normalized.includes('humaneval')) {
      return loadHumanEvalFixtures(datasetPathOrName);
    }
    if (normalized.includes('codexglue')) {
      return loadCodeXGLUEFixtures(datasetPathOrName);
    }
  }

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

  // The `limits` merge that used to sit here is gone — audit OX-L9. `ResolvedConfig` has no such
  // field, and never had one: the branch was guarded by two `as unknown as Record<string, unknown>`
  // casts precisely because the type says the property cannot exist, so it could never fire. Its
  // only effect was to launder the whole object through `as unknown as ResolvedConfig`, which
  // turned off type checking for every other key in this literal as well.
  const baseConfig = loadConfig();
  const mergedConfig: ResolvedConfig = {
    ...baseConfig,
    ...config,
    budget: { ...baseConfig.budget, ...config?.budget },
    validation: { ...baseConfig.validation, ...config?.validation },
  };

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
