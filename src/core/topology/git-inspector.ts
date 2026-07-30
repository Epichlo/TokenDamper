import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';

export interface GitStatusResult {
  readonly isGitRepo: boolean;
  readonly repoRoot: string | null;
  readonly modifiedFiles: ReadonlySet<string>;
  readonly stagedFiles: ReadonlySet<string>;
  readonly untrackedFiles: ReadonlySet<string>;
  readonly allDirtyFiles: ReadonlySet<string>;
  readonly recentCommitFiles: ReadonlyMap<string, number>; // path -> commit age (0 = latest commit)
}

interface GitCacheEntry {
  result: GitStatusResult;
  timestamp: number;
  cacheKey: string;
}

const globalGitCache = new Map<string, GitCacheEntry>();

export function clearGitWorkspaceCache(): void {
  globalGitCache.clear();
}

/**
 * Normalizes file paths to POSIX style (forward slashes) relative to repository root.
 */
export function normalizeGitPath(filePath: string, repoRoot?: string): string {
  let normalized = filePath.replace(/\\/g, '/');
  if (repoRoot) {
    const normRepoRoot = repoRoot.replace(/\\/g, '/').replace(/\/$/, '');
    if (normalized.startsWith(normRepoRoot + '/')) {
      normalized = normalized.slice(normRepoRoot.length + 1);
    }
  }
  normalized = normalized.replace(/^\.\//, '');
  return normalized;
}

/**
 * Inspects Git workspace status for a given root directory.
 * If git is not installed or the directory is not a git repository,
 * returns a safe default GitStatusResult with isGitRepo = false.
 */
export function inspectGitWorkspace(
  workspaceRoot?: string,
  options?: { forceRefresh?: boolean; ttlMs?: number }
): GitStatusResult {
  const cwd = workspaceRoot || process.cwd();
  const inputCacheKey = normalizeCacheKey(cwd);

  const defaultResult: GitStatusResult = {
    isGitRepo: false,
    repoRoot: null,
    modifiedFiles: new Set<string>(),
    stagedFiles: new Set<string>(),
    untrackedFiles: new Set<string>(),
    allDirtyFiles: new Set<string>(),
    recentCommitFiles: new Map<string, number>(),
  };

  if (!existsSync(cwd)) {
    globalGitCache.set(inputCacheKey, {
      result: cloneGitStatusResult(defaultResult),
      timestamp: performance.now(),
      cacheKey: inputCacheKey,
    });
    return defaultResult;
  }

  const ttlMs = options?.ttlMs ?? 2000;
  const t_now = performance.now();

  const cachedByInput = getCachedGitStatus(inputCacheKey, ttlMs, t_now, options?.forceRefresh);
  if (cachedByInput) {
    return cachedByInput;
  }

  try {
    // 1. Get repository root
    const repoRootRaw = execSync('git rev-parse --show-toplevel', {
      cwd,
      timeout: 500,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    }).trim();

    const repoRoot = normalizeCacheKey(repoRootRaw);
    const repoCacheKey = repoRoot;

    const cachedByRepoRoot = getCachedGitStatus(repoCacheKey, ttlMs, t_now, options?.forceRefresh);
    if (cachedByRepoRoot) {
      return cachedByRepoRoot;
    }

    // 2. Run git status --porcelain
    const statusOutput = execSync('git status --porcelain', {
      cwd,
      timeout: 500,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });

    const modifiedFiles = new Set<string>();
    const stagedFiles = new Set<string>();
    const untrackedFiles = new Set<string>();
    const allDirtyFiles = new Set<string>();

    const statusLines = statusOutput.split(/\r?\n/);
    for (const line of statusLines) {
      if (!line || line.length < 3) continue;

      const x = line[0];
      const y = line[1];
      let itemPath = line.slice(3).trim();

      // Handle arrow notation for renames: "R  old -> new"
      if (itemPath.includes('->')) {
        const parts = itemPath.split('->');
        itemPath = (parts[parts.length - 1] ?? '').trim();
      }

      // Remove surrounding quotes if present
      if (itemPath.startsWith('"') && itemPath.endsWith('"')) {
        itemPath = itemPath.slice(1, -1);
      }

      const normalized = normalizeGitPath(itemPath, repoRoot);

      if (x === '?' && y === '?') {
        untrackedFiles.add(normalized);
        allDirtyFiles.add(normalized);
      } else {
        if (x !== ' ' && x !== '?') {
          stagedFiles.add(normalized);
          allDirtyFiles.add(normalized);
        }
        if (y !== ' ' && y !== '?') {
          modifiedFiles.add(normalized);
          allDirtyFiles.add(normalized);
        }
      }
    }

    // 3. Run git log --name-only -n 5
    const recentCommitFiles = new Map<string, number>();
    try {
      const logOutput = execSync('git log --name-only -n 5 --format="COMMIT_START"', {
        cwd,
        timeout: 500,
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });

      const commitBlocks = logOutput.split('COMMIT_START');
      let commitAge = 0;
      for (const block of commitBlocks) {
        if (!block.trim()) continue;
        const lines = block.split(/\r?\n/);
        for (const rawLine of lines) {
          const trimmed = rawLine.trim();
          if (!trimmed) continue;
          const normalized = normalizeGitPath(trimmed, repoRoot);
          if (!recentCommitFiles.has(normalized)) {
            recentCommitFiles.set(normalized, commitAge);
          }
        }
        commitAge++;
      }
    } catch {
      // Ignore git log errors
    }

    const result: GitStatusResult = {
      isGitRepo: true,
      repoRoot,
      modifiedFiles,
      stagedFiles,
      untrackedFiles,
      allDirtyFiles,
      recentCommitFiles,
    };

    globalGitCache.set(repoCacheKey, {
      result: cloneGitStatusResult(result),
      timestamp: performance.now(),
      cacheKey: repoCacheKey,
    });

    return result;
  } catch {
    globalGitCache.set(inputCacheKey, {
      result: cloneGitStatusResult(defaultResult),
      timestamp: performance.now(),
      cacheKey: inputCacheKey,
    });

    return defaultResult;
  }
}

function normalizeCacheKey(filePath: string): string {
  let normalized = resolve(filePath).replace(/\\/g, '/').replace(/\/$/, '');
  if (/^[a-z]:/i.test(normalized)) {
    const drive = normalized.charAt(0).toUpperCase();
    normalized = drive + normalized.slice(1);
  }
  return normalized;
}

function getCachedGitStatus(
  inputCacheKey: string,
  ttlMs: number,
  now: number,
  forceRefresh: boolean | undefined,
): GitStatusResult | undefined {
  if (forceRefresh) {
    return undefined;
  }

  // 1. Direct match on inputCacheKey (exact match for repo root or non-git path)
  const exactEntry = globalGitCache.get(inputCacheKey);
  if (exactEntry) {
    if (now - exactEntry.timestamp < ttlMs) {
      return cloneGitStatusResult(exactEntry.result);
    }
    globalGitCache.delete(inputCacheKey);
  }

  // 2. Ancestor git repo match: check if inputCacheKey is a subdirectory of a cached git repo root
  for (const [key, entry] of globalGitCache.entries()) {
    if (now - entry.timestamp >= ttlMs) {
      globalGitCache.delete(key);
      continue;
    }

    if (entry.result.isGitRepo && entry.result.repoRoot) {
      const repoRootKey = normalizeCacheKey(entry.result.repoRoot);
      if (inputCacheKey === repoRootKey || inputCacheKey.startsWith(repoRootKey + '/')) {
        return cloneGitStatusResult(entry.result);
      }
    }
  }

  return undefined;
}

function cloneGitStatusResult(result: GitStatusResult): GitStatusResult {
  return {
    isGitRepo: result.isGitRepo,
    repoRoot: result.repoRoot,
    modifiedFiles: new Set(result.modifiedFiles),
    stagedFiles: new Set(result.stagedFiles),
    untrackedFiles: new Set(result.untrackedFiles),
    allDirtyFiles: new Set(result.allDirtyFiles),
    recentCommitFiles: new Map(result.recentCommitFiles),
  };
}
