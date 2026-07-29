import { execSync } from 'child_process';

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
  targetRepoRoot: string;
}

let globalGitCache: GitCacheEntry | null = null;

export function clearGitWorkspaceCache(): void {
  globalGitCache = null;
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
  const defaultResult: GitStatusResult = {
    isGitRepo: false,
    repoRoot: null,
    modifiedFiles: new Set<string>(),
    stagedFiles: new Set<string>(),
    untrackedFiles: new Set<string>(),
    allDirtyFiles: new Set<string>(),
    recentCommitFiles: new Map<string, number>(),
  };

  const cwd = workspaceRoot || process.cwd();
  const targetRepoRoot = cwd.replace(/\\/g, '/');
  const ttlMs = options?.ttlMs ?? 2000;
  const t_now = performance.now();

  if (!options?.forceRefresh && globalGitCache) {
    const deltaT = t_now - globalGitCache.timestamp;
    const isCacheValid = (deltaT < ttlMs) && (globalGitCache.targetRepoRoot === targetRepoRoot);
    if (isCacheValid) {
      return globalGitCache.result;
    }
  }

  try {
    // 1. Get repository root
    const repoRootRaw = execSync('git rev-parse --show-toplevel', {
      cwd,
      timeout: 500,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    }).trim();

    const repoRoot = repoRootRaw.replace(/\\/g, '/');

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

      const normalized = normalizeGitPath(itemPath);

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
          const normalized = normalizeGitPath(trimmed);
          if (!recentCommitFiles.has(normalized)) {
            recentCommitFiles.set(normalized, commitAge);
          }
        }
        commitAge++;
      }
    } catch {
      // Ignore git log errors
    }

    const result = {
      isGitRepo: true,
      repoRoot,
      modifiedFiles,
      stagedFiles,
      untrackedFiles,
      allDirtyFiles,
      recentCommitFiles,
    };

    globalGitCache = {
      result,
      timestamp: performance.now(),
      targetRepoRoot,
    };

    return result;
  } catch {
    return defaultResult;
  }
}
