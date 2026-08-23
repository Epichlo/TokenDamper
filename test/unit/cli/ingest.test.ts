import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expandPath } from '../../../src/cli/ingest';

/**
 * What a directory argument expands to — audit OX-M4 and OX-M16.
 *
 * Both findings are about *selection*, not about content, and selection is load-bearing here:
 * `applyCacheAwarePrefixLocking` pins the first ~1,024 tokens of the bundle, and pinned items
 * bypass the knapsack entirely (invariants 6 and 7). So which files appear, and in what order,
 * decides which files are exempt from pruning.
 */
describe('expandPath', () => {
  let dir: string;

  const file = (relative: string, content = 'export const x = 1;\n'): void => {
    const full = join(dir, relative);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  };

  const relative = (paths: readonly string[]): string[] =>
    paths.map((p) => p.slice(dir.length + 1).replace(/\\/g, '/'));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tokendamper-ingest-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('directories it refuses to descend into', () => {
    it('skips .claude, where agent worktrees keep whole duplicate checkouts', () => {
      // Observed on the machine this was found on: `tokendamper optimize .` ingested the full
      // source tree twice, once from `src/` and once from `.claude/worktrees/<name>/src/`. A
      // duplicated half skews the token budget, the prefix lock and the knapsack, and the output
      // silently contains two copies of many files.
      file('src/real.ts');
      file('.claude/worktrees/stale-abc123/src/real.ts');

      expect(relative(expandPath(dir, dir))).toEqual(['src/real.ts']);
    });

    it('skips dot-directories generally rather than by name', () => {
      // The listed skips were `.git`, `.next` and `.venv` — three dot-directories enumerated one
      // at a time, which is why `.claude` was missing. Every agent, editor and cache convention
      // adds another (`.agents`, `.cursor`, `.idea`, `.cache`), so the rule is the shape, not the
      // roster.
      file('keep.ts');
      file('.idea/thing.json', '{"a": 1}\n');
      file('.cache/blob.ts');
      file('.agents/worker/main.py', 'def f():\n    return 1\n');

      expect(relative(expandPath(dir, dir))).toEqual(['keep.ts']);
    });

    it('still skips the non-dot directories that were already listed', () => {
      file('keep.ts');
      file('node_modules/pkg/index.js', 'module.exports = 1;\n');
      file('dist/keep.js', 'module.exports = 1;\n');
      file('__pycache__/mod.py', 'x = 1\n');

      expect(relative(expandPath(dir, dir))).toEqual(['keep.ts']);
    });

    it('takes an explicitly named file inside a skipped directory', () => {
      // The skip is a rule for *walking*. Naming a path is a statement that you want it, and the
      // single-file route has always honored that.
      file('.claude/notes.md', '# notes\n');

      const named = join(dir, '.claude', 'notes.md');
      expect(expandPath(named, dir)).toEqual([named]);
    });
  });

  describe('ordering', () => {
    it('orders identically on every platform, not merely deterministically per platform', () => {
      // Audit OX-M16. Paths were built with `path.join` (native separators) and then sorted as
      // native strings. `/` is 0x2F and `\` is 0x5C, so any sibling whose name sorts between them
      // — every capital letter and digit — orders differently on Windows than on POSIX.
      //
      // `src` and `srcZ` are exactly that case: normalized, `src/a.ts` precedes `srcZ/a.ts`
      // because `/` < `Z`; with native backslashes the order inverts because `Z` < `\`. Same
      // directory, two different bundles, so two different sets of pinned files.
      file('src/a.ts');
      file('srcZ/a.ts');
      file('src0/a.ts');

      const rel = relative(expandPath(dir, dir));

      expect(rel).toEqual(['src/a.ts', 'src0/a.ts', 'srcZ/a.ts']);
      // Stated twice on purpose: the list above is the POSIX answer, and this is the property it
      // is an instance of.
      expect(rel).toEqual([...rel].sort());
    });

    it('is stable across repeated expansions', () => {
      file('b/one.ts');
      file('a/two.ts');
      file('c.ts');

      expect(expandPath(dir, dir)).toEqual(expandPath(dir, dir));
    });
  });
});
