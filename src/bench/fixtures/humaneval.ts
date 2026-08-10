import { readFileSync } from 'node:fs';
import { resolveBundledFixture } from './bundled-path';
import type { BenchmarkFixture, BenchmarkFixtureSet, HumanEvalFixtureRaw } from './types';

/**
 * Default relative path to bundled HumanEval dataset subset.
 */
const DEFAULT_HUMANEVAL_PATH = 'test/fixtures/bench/humaneval-subset.json';
const FALLBACK_HUMANEVAL_PATH = 'test/fixtures/bench/humaneval.json';

/**
 * Loads and normalizes HumanEval benchmark fixtures from file or raw objects.
 */
export function loadHumanEvalFixtures(
  input?: string | ReadonlyArray<HumanEvalFixtureRaw>,
): BenchmarkFixtureSet {
  let rawItems: ReadonlyArray<HumanEvalFixtureRaw>;

  if (Array.isArray(input)) {
    rawItems = input;
  } else {
    const filePath = resolveFilePath(typeof input === 'string' ? input : undefined);

    const content = readFileSync(filePath, 'utf-8');
    rawItems = JSON.parse(content) as ReadonlyArray<HumanEvalFixtureRaw>;
  }

  if (!Array.isArray(rawItems)) {
    throw new Error('Invalid HumanEval fixture format: expected an array of fixture items.');
  }

  const fixtures: BenchmarkFixture[] = rawItems.map((raw) => {
    if (!raw.task_id || typeof raw.prompt !== 'string' || typeof raw.canonical_solution !== 'string') {
      throw new Error(`Invalid HumanEval item: missing required fields in ${JSON.stringify(raw)}`);
    }

    const safeId = raw.task_id.replace(/[^a-zA-Z0-9_-]/g, '_');
    return Object.freeze({
      id: raw.task_id,
      dataset: 'humaneval',
      prompt: raw.prompt,
      referenceCompletion: raw.canonical_solution,
      language: 'python',
      path: `src/${raw.entry_point || safeId}.py`,
      entryPoint: raw.entry_point,
      testCode: raw.test,
      metadata: Object.freeze({
        task_id: raw.task_id,
        entry_point: raw.entry_point || '',
      }),
    });
  });

  return Object.freeze({
    datasetName: 'humaneval',
    fixtures: Object.freeze(fixtures),
    count: fixtures.length,
  });
}

function resolveFilePath(customPath?: string): string {
  const candidates = [
    ...(customPath && customPath.trim().length > 0 ? [customPath] : []),
    DEFAULT_HUMANEVAL_PATH,
    FALLBACK_HUMANEVAL_PATH,
  ];

  for (const candidate of candidates) {
    const resolved = resolveBundledFixture(candidate);
    if (resolved !== undefined) {
      return resolved;
    }
  }

  throw new Error(`HumanEval dataset file not found at ${customPath ?? DEFAULT_HUMANEVAL_PATH}`);
}
