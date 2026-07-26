import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BenchmarkFixture, BenchmarkFixtureSet, CodeXGLUEFixtureRaw } from './types';

/**
 * Default relative path to bundled CodeXGLUE dataset subset.
 */
const DEFAULT_CODEXGLUE_PATH = 'test/fixtures/bench/codexglue-subset.json';
const FALLBACK_CODEXGLUE_PATH = 'test/fixtures/bench/codexglue.json';

/**
 * Loads and normalizes CodeXGLUE benchmark fixtures from file or raw objects.
 */
export function loadCodeXGLUEFixtures(
  input?: string | ReadonlyArray<CodeXGLUEFixtureRaw>,
): BenchmarkFixtureSet {
  let rawItems: ReadonlyArray<CodeXGLUEFixtureRaw>;

  if (Array.isArray(input)) {
    rawItems = input;
  } else {
    const filePath = resolveFilePath(typeof input === 'string' ? input : undefined);

    const content = readFileSync(filePath, 'utf-8');
    rawItems = JSON.parse(content) as ReadonlyArray<CodeXGLUEFixtureRaw>;
  }

  if (!Array.isArray(rawItems)) {
    throw new Error('Invalid CodeXGLUE fixture format: expected an array of fixture items.');
  }

  const fixtures: BenchmarkFixture[] = rawItems.map((raw) => {
    if (!raw.id || typeof raw.prompt !== 'string' || typeof raw.completion !== 'string') {
      throw new Error(`Invalid CodeXGLUE item: missing required fields in ${JSON.stringify(raw)}`);
    }

    const language = raw.language ?? inferLanguageFromPath(raw.path);

    return Object.freeze({
      id: raw.id,
      dataset: 'codexglue',
      prompt: raw.prompt,
      referenceCompletion: raw.completion,
      language,
      path: raw.path || `src/item_${raw.id}.txt`,
      metadata: Object.freeze({
        repo: raw.repo || 'unknown',
      }),
    });
  });

  return Object.freeze({
    datasetName: 'codexglue',
    fixtures: Object.freeze(fixtures),
    count: fixtures.length,
  });
}

function inferLanguageFromPath(pathStr?: string): 'python' | 'typescript' | 'javascript' {
  if (!pathStr) return 'python';
  const ext = pathStr.split('.').pop()?.toLowerCase();
  if (ext === 'ts' || ext === 'tsx') return 'typescript';
  if (ext === 'js' || ext === 'jsx' || ext === 'cjs' || ext === 'mjs') return 'javascript';
  return 'python';
}

function resolveFilePath(customPath?: string): string {
  if (customPath && customPath.trim().length > 0) {
    const absPath = resolve(process.cwd(), customPath);
    if (existsSync(absPath)) {
      return absPath;
    }
  }

  const defaultAbs = resolve(process.cwd(), DEFAULT_CODEXGLUE_PATH);
  if (existsSync(defaultAbs)) {
    return defaultAbs;
  }

  const fallbackAbs = resolve(process.cwd(), FALLBACK_CODEXGLUE_PATH);
  if (existsSync(fallbackAbs)) {
    return fallbackAbs;
  }

  throw new Error(`CodeXGLUE dataset file not found at ${customPath ?? DEFAULT_CODEXGLUE_PATH}`);
}
