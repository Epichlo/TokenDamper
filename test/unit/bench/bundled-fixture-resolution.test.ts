import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadBenchmarkFixtures,
  loadCodeXGLUEFixtures,
  loadHumanEvalFixtures,
} from '../../../src/bench/fixtures';
import { clearPackageRootCache } from '../../../src/bench/fixtures/bundled-path';

/**
 * Audit M10 — `tokendamper bench` threw for every installed user.
 *
 * The bundled datasets were resolved against `process.cwd()` and nothing else, so they were
 * findable only from a checkout of this repository. Every existing bench test runs with the
 * repo as the working directory, which is precisely why none of them saw it.
 *
 * These tests move the working directory somewhere with no `test/fixtures` under it — the
 * shape of an installed user running `bench` from their own project — and assert the datasets
 * are still found, via the package root.
 */
describe('bundled benchmark fixtures resolve outside the repository (M10)', () => {
  const elsewhere = mkdtempSync(join(tmpdir(), 'tokendamper-m10-'));

  afterEach(() => {
    vi.restoreAllMocks();
    clearPackageRootCache();
  });

  function workFromElsewhere(): void {
    vi.spyOn(process, 'cwd').mockReturnValue(elsewhere);
    clearPackageRootCache();
  }

  it('loads the HumanEval subset from a working directory that has no test/ tree', () => {
    workFromElsewhere();
    const set = loadHumanEvalFixtures();
    expect(set.datasetName).toBe('humaneval');
    expect(set.count).toBeGreaterThan(0);
  });

  it('loads the CodeXGLUE subset from a working directory that has no test/ tree', () => {
    workFromElsewhere();
    const set = loadCodeXGLUEFixtures();
    expect(set.datasetName).toBe('codexglue');
    expect(set.count).toBeGreaterThan(0);
  });

  it('loads the combined set with no dataset argument, as `bench` now calls it', () => {
    workFromElsewhere();
    const set = loadBenchmarkFixtures();
    expect(set.datasetName).toBe('combined');
    expect(set.count).toBeGreaterThan(0);
  });

  it('resolves the same fixtures from the repository as from elsewhere', () => {
    const fromRepo = loadBenchmarkFixtures();
    workFromElsewhere();
    const fromElsewhere = loadBenchmarkFixtures();
    expect(fromElsewhere.count).toBe(fromRepo.count);
    expect(fromElsewhere.fixtures.map((f) => f.id)).toEqual(fromRepo.fixtures.map((f) => f.id));
  });

  it('takes a directory argument instead of throwing EISDIR', () => {
    // The CLI has always pre-empted this at its own call site, so the defect was reachable
    // only by a direct API caller. `readFileSync` on a directory throws `EISDIR`, which is
    // neither a "not found" nor a parse error and named nothing useful.
    const set = loadBenchmarkFixtures('test/fixtures/bench');
    expect(set.datasetName).toBe('combined');
    expect(set.count).toBeGreaterThan(0);
  });
});
