import { defineConfig } from 'vitest/config';

/**
 * Test collection is pinned here because the default was collecting suites that are not this
 * repository's (audit OX-H3).
 *
 * With no config file at all, vitest falls back to its default `include`
 * (`**\/*.{test,spec}.?(c|m)[jt]s?(x)`) and walks the entire tree from the root. This project
 * keeps agent worktrees under `.claude/worktrees/<name>/`, and a worktree is a *full checkout* —
 * `test/` included. So every stale worktree contributed a second, older copy of the whole suite
 * to every local run.
 *
 * Measured at the time of the fix: the canonical suite is **78 files / 723 tests**; the audit,
 * run in a tree carrying one stale worktree, reported **155 files / 1410 tests**. Almost exactly
 * double, and the extra half was a checkout two commits behind `main`.
 *
 * That is worse than slow. A stale copy passes or fails on its own frozen source, so a green run
 * says nothing about the tree being edited — which is invariant 10 (a check that never looked at
 * the thing reads exactly like a check that passed) arriving through the test runner. CI was
 * never affected: a fresh checkout has no `.claude/worktrees`, so local and CI disagreed about
 * what "the suite" even was.
 *
 * `npm run lint` needs no equivalent guard — it is `eslint src test`, already path-scoped.
 */
export default defineConfig({
  test: {
    // Anchored to the top-level `test/` directory. This alone excludes
    // `.claude/worktrees/*/test/**`, because include globs resolve against the project root and
    // `test/**` cannot match a nested `test` directory.
    include: ['test/**/*.test.ts'],

    // Redundant against the anchored `include` above, and kept anyway: `exclude` is what a
    // future widening of `include` would be checked against, and this is the list that names the
    // directory the defect actually came from. Note that specifying `exclude` *replaces*
    // vitest's default rather than extending it, so `node_modules` and `dist` are restated here
    // — `dist` matters because `tsc -p tsconfig.json` compiles `test/` as well as `src/`, which
    // puts a second copy of every suite in `dist/test/` after any build.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],

    // `tsconfig.json` already declares `types: ["node", "vitest/globals"]`. Nothing in the suite
    // relies on it today — all 78 files import from 'vitest' explicitly — so this is switched on
    // to make that declaration true rather than decorative, which is the same standard audit H4
    // and OX-H5 apply to CLI flags.
    globals: true,
  },
});
