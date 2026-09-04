import { execFileSync } from 'node:child_process';
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
  'node_modules', 'dist', 'build', 'coverage', '__pycache__',
]);

/**
 * Whether a directory is walked at all.
 *
 * Dot-directories are skipped by *shape* rather than by name (audit OX-M4). The set above used to
 * enumerate `.git`, `.next` and `.venv` individually, which is why `.claude` was missing — and
 * `.claude/worktrees/<name>/` holds entire duplicate checkouts. Observed: `tokendamper optimize .`
 * ingested this repository's own source twice, once from `src/` and once from a stale worktree.
 * A duplicated half is not merely wasteful — it skews the token estimate, the cache-aware prefix
 * lock and the knapsack's selection, so it changes which files survive (invariants 6 and 7).
 *
 * Enumerating names could not keep up. Every agent, editor and cache convention adds another
 * (`.agents`, `.cursor`, `.idea`, `.cache`, `.pytest_cache`), and each arrives as a silent
 * duplicate rather than as an error. The shape rule covers all of them, the three former entries
 * included.
 *
 * This governs *walking* only. A file named directly on the command line is still taken, dot-path
 * or not: `expandPath` returns a non-directory argument untouched, because naming a path is a
 * statement that you want it.
 */
function isSkippedDirectory(name: string): boolean {
  return name.startsWith('.') || SKIP_DIRECTORIES.has(name);
}

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
        if (isSkippedDirectory(entry.name)) continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile() && INGESTIBLE_EXTENSIONS.has(extensionOf(entry.name))) {
        // `Dirent.isFile()` is false for a symlink, so a symlinked file inside a walked directory
        // is dropped here without a word — while the same symlink named directly on the command
        // line is followed, because `statSync` above resolves it. The two routes disagree (audit
        // OX-L4).
        //
        // Recorded rather than fixed, and the reason is the reason, not the size: the fix is
        // small (stat the link, take it if it resolves to an ingestible file, push the realpath so
        // `ingestPaths`'s dedup still sees one entry for a link and its target) but it could not
        // be *exercised* where it was written — creating a symlink needs elevation or Developer
        // Mode on Windows and returned EPERM. Shipping an unverified change to the path that
        // decides which files reach the pipeline is the trade this project keeps declining.
        // Skipping is the safe direction: a file is omitted, never corrupted.
        found.push(join(dir, entry.name));
      }
    }
  };
  walk(abs);

  // Sorted so a directory produces the same bundle on every run, on every filesystem, and on
  // every operating system. Order is not cosmetic here: `applyCacheAwarePrefixLocking` pins the
  // first ~1,024 tokens, so it decides which files are exempt from the knapsack (invariants 6
  // and 7).
  //
  // The comparison runs on separator-normalized keys (audit OX-M16). `path.join` builds native
  // separators, and a bare `found.sort()` then compares `\` (0x5C) on Windows against `/` (0x2F)
  // everywhere else — so any sibling whose name sorts between them, which is every digit and
  // every capital letter, orders differently per platform. `src/a.ts` precedes `srcZ/a.ts` on
  // POSIX because `/` < `Z`, and follows it on Windows because `Z` < `\`. Same directory, two
  // different bundles, two different sets of pinned files.
  //
  // Only the sort *key* is normalized. The paths themselves stay native, because they are what
  // the output envelope prints and what the caller has to be able to open.
  const key = new Map(found.map((p) => [p, p.replace(/\\/g, '/')]));
  found.sort((a, b) => {
    const ka = key.get(a) as string;
    const kb = key.get(b) as string;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return found;
}

/**
 * Which of these paths git is being told to ignore (security review F-03).
 *
 * Ingestion is an extension allowlist and nothing else — `.gitignore` is never consulted — so
 * `tokendamper optimize .` on a repository containing `secrets.yaml`, `serviceAccount.json` or
 * `config/credentials.yaml` reads them and writes them to stdout, which is the stream the caller
 * then pipes into a model. Reproduced: three secret-bearing files, all three named in
 * `.gitignore`, all three ingested and emitted verbatim.
 *
 * **This reports; it does not filter.** Skipping ignored files would change which bytes the
 * pipeline sees, and `.gitignore` covers plenty a caller may legitimately mean to optimize —
 * build output, vendored sources, generated code. Naming them costs nothing and leaves the
 * decision where it belongs. A file named directly on the command line is still taken, unchanged:
 * naming a path is a statement that you want it.
 *
 * `execFile` with an argument array and the paths on **stdin**, so no filename is ever interpolated
 * into a command line — a path beginning with `-` cannot become a flag, and `git check-ignore`'s
 * `--stdin` form is what makes that possible. Any failure is silent by design: no git, no
 * repository, or a git too old for these flags all mean "cannot answer", and a warning system that
 * errors is worse than one that says nothing.
 */
export function gitIgnoredAmong(paths: readonly string[], cwd: string): string[] {
  if (paths.length === 0) return [];

  // `-z` on both sides. Without it git applies `core.quotePath` C-style quoting to any path it
  // considers unusual — which includes every Windows path, because of the backslashes — and the
  // warning would print `"C:\\Users\\..."` instead of the path the caller can act on. NUL
  // separation also removes the last ambiguity a newline in a filename could introduce here.
  const entries = (text: string): string[] => text.split('\0').filter((line) => line.length > 0);

  try {
    const out = execFileSync('git', ['check-ignore', '--no-index', '--stdin', '-z'], {
      cwd,
      input: paths.join('\0'),
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return entries(out);
  } catch (error) {
    // `check-ignore` exits 1 when *nothing* matched, which is a successful answer of "none" and
    // arrives here as a thrown error. Its stdout is still the (empty) match list, so read it
    // rather than assuming; any other failure yields no stdout and reports nothing.
    const stdout = (error as { stdout?: string | Buffer }).stdout;
    if (typeof stdout === 'string' || Buffer.isBuffer(stdout)) {
      return entries(stdout.toString());
    }
    return [];
  }
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
