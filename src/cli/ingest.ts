import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** One file as it was read: the bytes, and the decoded string the pipeline will use. */
export interface IngestedFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly content: string;
  /** Whether the bytes survive a UTF-8 round trip. See `runCli`'s `inputSurvivesDecoding`. */
  readonly representable: boolean;
}

/**
 * Extensions collected when a directory is expanded.
 *
 * Intentionally the union of what `isCodeExtension` admits and the document extensions, rather
 * than "every file". A directory walk that swept in `.png`, `.lock` and `node_modules` would
 * produce a bundle whose token estimate is dominated by content nothing can optimize, and the
 * knapsack would then spend its budget deciding between binaries.
 *
 * This list is a *selection* rule for directory walking, and is deliberately separate from
 * `isCodeExtension`, which is a *classification* rule. Sharing them would mean widening one to
 * fix the other — and `isCodeExtension`'s membership already decides whether a file is validated
 * at all (audit H2), which is not a decision directory walking should get a vote in.
 */
const INGESTIBLE_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts', 'tsx', 'js', 'jsx', 'cjs', 'mjs', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp',
  'sh', 'ps1', 'css', 'scss', 'sql', 'json', 'md', 'txt', 'yml', 'yaml',
]);

/** Directories never descended into. Cheap, and the alternative is measuring `node_modules`. */
const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.venv', '__pycache__',
]);

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1).slice(path.lastIndexOf('\\') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/**
 * Expands one CLI path argument into the files it names.
 *
 * A file is taken as given — including one whose extension is not in `INGESTIBLE_EXTENSIONS`,
 * because naming a file explicitly is a statement that you want it, and second-guessing that
 * would make `optimize weird.xyz` silently produce nothing. The filter applies only to directory
 * walking, where the caller named a tree rather than its contents.
 */
export function expandPath(argPath: string, cwd: string): string[] {
  const abs = resolve(cwd, argPath);
  const stats = statSync(abs);

  if (!stats.isDirectory()) {
    return [abs];
  }

  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile() && INGESTIBLE_EXTENSIONS.has(extensionOf(entry.name))) {
        found.push(join(dir, entry.name));
      }
    }
  };
  walk(abs);

  // Sorted so a directory produces the same bundle on every run and on every filesystem.
  // Order is not cosmetic here: `applyCacheAwarePrefixLocking` pins the first ~1,024 tokens, so
  // it decides which files are exempt from the knapsack (invariant 6, 7).
  found.sort();
  return found;
}

/**
 * Reads every path, keeping the bytes alongside the decoded string.
 *
 * Bytes are retained for the same reason the single-file route retains them (DECISIONS §35):
 * fail-open has to hand back what the caller supplied, and a file that is not valid UTF-8 cannot
 * be reconstructed from the decoded string. Here that guarantee is per file.
 */
export function ingestPaths(paths: readonly string[], cwd: string): IngestedFile[] {
  const seen = new Set<string>();
  const files: IngestedFile[] = [];

  for (const argPath of paths) {
    for (const abs of expandPath(argPath, cwd)) {
      // A file named twice — directly and via a directory, or by two overlapping globs — must
      // appear once. Duplicate items would be deduplicated by the pipeline anyway, but the
      // budget would have been computed against a token count that double-counted them.
      if (seen.has(abs)) continue;
      seen.add(abs);

      const bytes = readFileSync(abs);
      const content = bytes.toString('utf8');
      files.push({
        path: abs,
        bytes,
        content,
        representable: Buffer.from(content, 'utf8').equals(bytes),
      });
    }
  }

  return files;
}
