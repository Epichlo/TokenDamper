import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Locates fixture data that ships with the package.
 *
 * The bundled datasets used to be resolved against `process.cwd()` alone, which is only ever
 * correct when the process happens to be started from a checkout of this repository. For an
 * installed user `tokendamper bench` threw before it ran a single fixture (audit M10).
 */

let cachedPackageRoot: string | null | undefined;

/**
 * Absolute path to this package's root — the directory holding its `package.json`.
 *
 * Found by walking up from this module rather than by a constant number of `..` segments,
 * because the module runs from two different depths: `src/bench/fixtures/` under vitest and
 * `dist/src/bench/fixtures/` once compiled. A fixed offset is right for exactly one of them,
 * and picking either would reintroduce M10 on the other route.
 */
function packageRoot(): string | undefined {
  if (cachedPackageRoot !== undefined) {
    return cachedPackageRoot ?? undefined;
  }

  let current = __dirname;
  // Bounded by the filesystem root: `dirname('/')` is `'/'`, so equality ends the walk.
  for (;;) {
    if (existsSync(resolve(current, 'package.json'))) {
      cachedPackageRoot = current;
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      cachedPackageRoot = null;
      return undefined;
    }
    current = parent;
  }
}

/**
 * Resolves a bundled fixture path, preferring the caller's working directory.
 *
 * Working directory first so a checkout keeps behaving exactly as it did, and so a user who
 * has their own copy at the same relative path still wins. The package root is a fallback,
 * not a replacement.
 *
 * Returns `undefined` when neither location holds the file, leaving the "not found" message
 * to the caller that knows which dataset was being asked for.
 */
export function resolveBundledFixture(relativePath: string): string | undefined {
  const fromCwd = resolve(process.cwd(), relativePath);
  if (existsSync(fromCwd)) {
    return fromCwd;
  }

  const root = packageRoot();
  if (root === undefined) {
    return undefined;
  }

  const fromPackage = resolve(root, relativePath);
  return existsSync(fromPackage) ? fromPackage : undefined;
}

/**
 * Test seam: forces the next `resolveBundledFixture` call to re-walk for the package root.
 */
export function clearPackageRootCache(): void {
  cachedPackageRoot = undefined;
}
