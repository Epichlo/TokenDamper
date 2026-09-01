import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The published package must not carry the test suite.
 *
 * `npm run build` used `tsconfig.json`, which covers `src/` **and** `test/` because
 * `npm run typecheck` wants it to — a type error in a test is a real error. But the build shared
 * that config, so `tsc` emitted `dist/test/` too, and `package.json` `files` ships all of `dist`.
 * Measured before the split: **285 of the tarball's 508 entries** were compiled suites, 46% of its
 * unpacked bytes, against 210 entries for the product itself.
 *
 * This is a config test rather than a `npm pack` test on purpose. Packing needs a completed build,
 * which makes it slow and makes its result depend on whatever `dist/` happens to hold — including
 * a stale `dist/test/` from a checkout that built before this change. The configuration is the
 * thing that has to stay true.
 */
describe('the published package ships the product, not the suite', () => {
  const repoRoot = join(__dirname, '..', '..');
  const readJson = (name: string): Record<string, unknown> => {
    // `tsconfig*.json` is JSONC — strip line comments before parsing. Block comments are not used.
    const raw = readFileSync(join(repoRoot, name), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    return JSON.parse(raw) as Record<string, unknown>;
  };

  it('builds from a config that emits only src/', () => {
    const build = readJson('tsconfig.build.json');
    expect(build.extends).toBe('./tsconfig.json');
    expect(build.include).toEqual(['src/**/*.ts']);
    expect(JSON.stringify(build.include)).not.toContain('test');
  });

  it('points the build script at it — the config is inert if nothing runs it', () => {
    // Invariant 10: the assertion above passes just as well against a repository that has this
    // file and never uses it.
    const pkg = readJson('package.json') as { scripts: Record<string, string> };
    expect(pkg.scripts.build).toBe('tsc -p tsconfig.build.json');
  });

  it('keeps typecheck on the wider config, so tests stay type-checked', () => {
    // The point of the split is that only *emission* narrows. Losing type coverage of the suite
    // would be a real regression: it is what catches a bad generic in a test that vitest runs
    // green.
    const pkg = readJson('package.json') as { scripts: Record<string, string> };
    expect(pkg.scripts.typecheck).toBe('tsc -p tsconfig.json --noEmit');

    const base = readJson('tsconfig.json');
    expect(base.include).toContain('test/**/*.ts');
  });

  it('inherits an explicit rootDir, without which the output would silently relocate', () => {
    // `rootDir: "."` is what keeps emission at `dist/src/...`. Unset, `tsc` infers the common root
    // of the input set — which for a src-only include is `src/`, moving every file up one level
    // and breaking `main`, `types` and `bin` in a build that still succeeds.
    const base = readJson('tsconfig.json') as { compilerOptions: Record<string, unknown> };
    expect(base.compilerOptions.rootDir).toBe('.');
    expect(base.compilerOptions.outDir).toBe('dist');

    const pkg = readJson('package.json') as { main: string; types: string; bin: Record<string, string> };
    for (const entry of [pkg.main, pkg.types, ...Object.values(pkg.bin)]) {
      expect(entry, `entry point ${entry} assumes the dist/src/ layout`).toContain('dist/src/');
    }
  });

  it('ships dist wholesale, which is why the build config is the control', () => {
    // If `files` ever enumerated `dist/src` directly, this whole split would be unnecessary — and
    // the reverse is the risk worth pinning: it ships `dist`, so anything emitted is published.
    const pkg = readJson('package.json') as { files: string[] };
    expect(pkg.files).toContain('dist');
    expect(pkg.files.some((f) => f.startsWith('dist/'))).toBe(false);
  });
});
