import type { ContextBundle, ContextItem, OptimizationBudget } from '../model/types';
import type { GitStatusResult } from './git-inspector';
import { normalizeGitPath } from './git-inspector';
import type { DependencyGraph } from './dependency-graph';
import { computeAllDistances } from './dependency-graph';
import { containsImperativeDirective } from '../constraints/directives';

export interface ItemTopologyScore {
  readonly itemId: string;
  readonly score: number; // Clamped to [1.0, 100.0]
  readonly graphDistance: number;
  readonly isDirty: boolean;
  readonly hasConstraints: boolean;
  readonly isPinned: boolean;
}

export type TopologyScoreMap = ReadonlyMap<string, ItemTopologyScore>;

/**
 * Calculates graph distance score S_graph(i).
 */
function calculateGraphScore(distance: number): number {
  if (distance === 0) return 40.0;
  if (distance === 1) return 30.0;
  if (distance === 2) return 20.0;
  if (distance >= 3 && distance < Infinity) return 10.0;
  return 5.0; // distance === Infinity
}

/**
 * Calculates Git status score S_git(i).
 */
function calculateGitScore(pathNormalized: string | undefined, gitStatus: GitStatusResult): { score: number; isDirty: boolean } {
  if (!pathNormalized || !gitStatus.isGitRepo) {
    return { score: 0.0, isDirty: false };
  }

  const isDirty = gitStatus.allDirtyFiles.has(pathNormalized);
  if (isDirty) {
    return { score: 30.0, isDirty: true };
  }

  if (gitStatus.recentCommitFiles.has(pathNormalized)) {
    return { score: 15.0, isDirty: false };
  }

  return { score: 0.0, isDirty: false };
}

/**
 * Calculates Kind & Role base score S_kind(i).
 */
function calculateKindScore(item: ContextItem): number {
  if (item.role === 'system' || item.kind === 'prompt') {
    return 30.0;
  }
  if (item.kind === 'conversation') {
    return 20.0;
  }
  if (item.kind === 'file') {
    return 15.0;
  }
  if (item.kind === 'diff') {
    return 10.0;
  }
  return 5.0;
}

/**
 * Calculates Constraint Preservation score S_constraint(i).
 */
function calculateConstraintScore(item: ContextItem): { score: number; hasConstraints: boolean } {
  if (item.metadata?.hasConstraints === true) {
    return { score: 25.0, hasConstraints: true };
  }
  const hasKeywords = containsImperativeDirective(item.content);
  if (hasKeywords) {
    return { score: 25.0, hasConstraints: true };
  }
  return { score: 0.0, hasConstraints: false };
}

/**
 * Scores all items in a context bundle using Git status, dependency graph, and constraint analysis.
 */
export function scoreBundleTopology(
  bundle: ContextBundle,
  gitStatus: GitStatusResult,
  graph: DependencyGraph,
  budget: OptimizationBudget,
): TopologyScoreMap {
  const scores = new Map<string, ItemTopologyScore>();
  const preserveKinds = new Set(budget.preserveKinds || []);

  // Determine all dirty file paths from gitStatus to use as sourcePaths for BFS
  const sourcePaths = new Set<string>();
  if (gitStatus.isGitRepo) {
    for (const dirtyPath of gitStatus.allDirtyFiles) {
      sourcePaths.add(dirtyPath);
    }
  }

  // Run a single multi-source BFS to compute distances to all reachable nodes
  const distanceMap = computeAllDistances(graph, sourcePaths);

  for (const item of bundle.items) {
    const pathNorm = item.path ? normalizeGitPath(item.path, gitStatus.repoRoot || undefined) : undefined;

    let distance = Infinity;
    if (pathNorm) {
      distance = distanceMap.get(pathNorm) ?? Infinity;
    }

    const graphScore = calculateGraphScore(distance);
    const { score: gitScore, isDirty } = calculateGitScore(pathNorm, gitStatus);
    const kindScore = calculateKindScore(item);
    const { score: constraintScore, hasConstraints } = calculateConstraintScore(item);

    const rawTotal = graphScore + gitScore + kindScore + constraintScore;
    const score = Math.max(1.0, Math.min(100.0, rawTotal));

    const isPinned = item.role === 'system' || preserveKinds.has(item.kind);

    scores.set(item.id, {
      itemId: item.id,
      score,
      graphDistance: distance,
      isDirty,
      hasConstraints,
      isPinned,
    });
  }

  return scores;
}
