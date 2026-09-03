import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Regression guard for the collected-a-suite-that-is-not-ours class of bug (audit OX-H3).
 *
 * The repository had no vitest config at all, so collection used vitest's default `include` and
 * walked the whole tree. Agent worktrees live under `.claude/worktrees/<name>/` and each one is a
 * full checkout, `test/` included — so every stale worktree silently contributed a second, older
 * copy of the entire suite. Measured: the canonical suite is 78 files / 723 tests; the audit's run
 * in a tree holding one stale worktree reported 155 / 1410.
 *
 * The cost is not wall-clock. A stale copy passes against its own frozen source, so a green run
 * reports nothing about the tree being edited — invariant 10 reaching the test runner itself. And
 * CI never saw it, because a fresh checkout has no `.claude/`, so "the suite" meant two different
 * things locally and remotely.
 *
 * Two properties are pinned below, and the second matters as much as the first: anchoring the
 * include is only safe while every real suite actually lives under `test/`. An anchor that
 * quietly stops collecting a directory would be this same defect with the sign reversed.
 */
describe('test collection scope', () => {
  const repoRoot = resolve(__dirname, '..', '..');
  const configPath = join(repoRoot, 'vitest.config.ts');

  const arrayLiteral = (source: string, key: 'include' | 'exclude'): readonly string[] => {
    const match = new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`).exec(source);
    if (match?.[1] === undefined) {
      throw new Error(
        `vitest.config.ts has no literal \`${key}\` array. This guard reads the config as text; ` +
          `if the config was restructured, update this test rather than deleting it — the ` +
          `property being protected (OX-H3) is unchanged.`,
      );
    }
    return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
  };

  it('has a vitest config at all — its absence is the defect', () => {
    expect(existsSync(configPath)).toBe(true);
  });

  it('anchors include to the top-level test directory', () => {
    const include = arrayLiteral(readFileSync(configPath, 'utf8'), 'include');

    expect(include.length).toBeGreaterThan(0);
    // A pattern opening with `**/` matches a `test` directory at any depth, which is exactly how
    // `.claude/worktrees/<name>/test/**` got collected.
    for (const pattern of include) {
      expect(pattern.startsWith('test/')).toBe(true);
    }
  });

  it('names .claude in exclude, so a widened include cannot re-reach worktrees', () => {
    const exclude = arrayLiteral(readFileSync(configPath, 'utf8'), 'exclude');

    expect(exclude.some((p) => p.includes('.claude'))).toBe(true);
    // `exclude` replaces vitest's default rather than extending it, so these have to be restated.
    // `dist` is not hypothetical: `tsconfig.json` still compiles `test/`, so `tsc -p tsconfig.json`
    // without `--noEmit` puts a second copy of every suite in `dist/test/`. `npm run build` no
    // longer does — it uses `tsconfig.build.json`, whose `include` is `src/**` only (F-08).
    expect(exclude.some((p) => p.includes('node_modules'))).toBe(true);
    expect(exclude.some((p) => p.includes('dist'))).toBe(true);
  });

  it('confirms the anchor hides nothing: every suite in the repo lives under test/', () => {
    const skip = new Set(['node_modules', 'dist', '.claude', '.git', 'coverage', '.venv']);
    const strays: string[] = [];

    const walk = (dir: string, relative: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const rel = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(join(dir, entry.name), rel);
        } else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name) && !rel.startsWith('test/')) {
          strays.push(rel);
        }
      }
    };
    walk(repoRoot, '');

    expect(strays).toEqual([]);
  });
});
