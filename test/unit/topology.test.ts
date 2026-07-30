import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { inspectGitWorkspace, normalizeGitPath, clearGitWorkspaceCache } from '../../src/core/topology/git-inspector';
import {
  parseTsJsImports,
  parsePythonImports,
  buildDependencyGraph,
  getShortestGraphDistance,
} from '../../src/core/topology/dependency-graph';
import { scoreBundleTopology } from '../../src/core/topology/topology-scorer';
import { createBundleFromItems, createContextItem, createOptimizationBudget } from '../../src/core/model';
import type { ContextItem } from '../../src/core/model/types';

describe('git-inspector', () => {
  it('normalizes git file paths to posix relative style', () => {
    expect(normalizeGitPath('src\\core\\planner.ts')).toBe('src/core/planner.ts');
    expect(normalizeGitPath('./src/core/planner.ts')).toBe('src/core/planner.ts');
    expect(normalizeGitPath('/repo/src/core/planner.ts', '/repo')).toBe('src/core/planner.ts');
    expect(normalizeGitPath('C:\\repo\\src\\core\\planner.ts', 'C:\\repo')).toBe('src/core/planner.ts');
  });

  it('inspects active git repository safely', () => {
    const root = path.resolve(__dirname, '../..');
    const result = inspectGitWorkspace(root);
    expect(result.isGitRepo).toBe(true);
    expect(result.repoRoot).not.toBeNull();
    expect(result.allDirtyFiles).toBeInstanceOf(Set);
  });

  it('returns safe fallback for non-existent directory', () => {
    const nonExistentPath = path.resolve(__dirname, '../../non-existent-dir-12345');
    const result = inspectGitWorkspace(nonExistentPath);
    expect(result.isGitRepo).toBe(false);
    expect(result.repoRoot).toBeNull();
    expect(result.allDirtyFiles.size).toBe(0);
  });

  describe('cache behavior', () => {
    it('caches subsequent calls to inspectGitWorkspace without exposing mutable cache state', () => {
      clearGitWorkspaceCache();
      const root = path.resolve(__dirname, '../..');
      
      const result1 = inspectGitWorkspace(root);
      (result1.allDirtyFiles as Set<string>).add('__cache-poison__');

      const start2 = performance.now();
      const result2 = inspectGitWorkspace(root);
      const time2 = performance.now() - start2;

      expect(result2).not.toBe(result1);
      expect(result2.allDirtyFiles.has('__cache-poison__')).toBe(false);
      expect(time2).toBeLessThan(5);

      // Cache clear works
      clearGitWorkspaceCache();
      const result3 = inspectGitWorkspace(root);
      expect(result3).not.toBe(result1);
    });

    it('shares git status cache between repo root and subdirectories', () => {
      clearGitWorkspaceCache();
      const root = path.resolve(__dirname, '../..');
      const subDir = path.resolve(root, 'src');

      const resultRoot = inspectGitWorkspace(root);
      expect(resultRoot.isGitRepo).toBe(true);

      const startSub = performance.now();
      const resultSub = inspectGitWorkspace(subDir);
      const timeSub = performance.now() - startSub;

      expect(resultSub.isGitRepo).toBe(true);
      expect(resultSub.repoRoot).toBe(resultRoot.repoRoot);
      expect(timeSub).toBeLessThan(5);
    });

    it('properly caches non-git fallback results to avoid repeated shelling out', () => {
      clearGitWorkspaceCache();
      const nonExistentPath = path.resolve(__dirname, '../../non-existent-dir-12345');

      const result1 = inspectGitWorkspace(nonExistentPath);
      expect(result1.isGitRepo).toBe(false);

      const start2 = performance.now();
      const result2 = inspectGitWorkspace(nonExistentPath);
      const time2 = performance.now() - start2;

      expect(result2.isGitRepo).toBe(false);
      expect(time2).toBeLessThan(5);
    });
  });
});

describe('dependency-graph', () => {
  it('parses TS/JS import statements', () => {
    const content = `
      import { plan } from './planner';
      import type { ContextItem } from '../model/types';
      const util = require('./utils/helper');
      export { bar } from './bar';
    `;

    const imports = parseTsJsImports('src/core/engine/index.ts', content);
    expect(imports).toContain('src/core/engine/planner');
    expect(imports).toContain('src/core/model/types');
    expect(imports).toContain('src/core/engine/utils/helper');
    expect(imports).toContain('src/core/engine/bar');
  });

  it('parses Python import statements', () => {
    const content = `
      import os
      from sys import exit
      from .utils import helper
      from ..models import Item
    `;

    const imports = parsePythonImports('app/services/main.py', content);
    expect(imports).toContain('os');
    expect(imports).toContain('sys');
    expect(imports).toContain('app/services/utils');
    expect(imports).toContain('app/models');
  });

  it('builds dependency graph and measures shortest distance', () => {
    const itemA: ContextItem = createContextItem({
      id: 'a',
      kind: 'file',
      path: 'src/a.ts',
      content: "import { b } from './b';",
      language: 'typescript',
    });

    const itemB: ContextItem = createContextItem({
      id: 'b',
      kind: 'file',
      path: 'src/b.ts',
      content: "import { c } from './c';",
      language: 'typescript',
    });

    const itemC: ContextItem = createContextItem({
      id: 'c',
      kind: 'file',
      path: 'src/c.ts',
      content: 'export const c = 42;',
      language: 'typescript',
    });

    const itemD: ContextItem = createContextItem({
      id: 'd',
      kind: 'file',
      path: 'src/d.ts',
      content: 'export const d = 100;',
      language: 'typescript',
    });

    const items = [itemA, itemB, itemC, itemD];
    const graph = buildDependencyGraph(items);

    expect(graph.nodes.has('src/a.ts')).toBe(true);
    expect(graph.nodes.has('src/b.ts')).toBe(true);

    const dirtySources = new Set(['src/a.ts']);
    expect(getShortestGraphDistance(graph, dirtySources, 'src/a.ts')).toBe(0);
    expect(getShortestGraphDistance(graph, dirtySources, 'src/b.ts')).toBe(1);
    expect(getShortestGraphDistance(graph, dirtySources, 'src/c.ts')).toBe(2);
    expect(getShortestGraphDistance(graph, dirtySources, 'src/d.ts')).toBe(Infinity);
  });
});

describe('topology-scorer', () => {
  it('calculates composite relevance scores clamped between 1.0 and 100.0', () => {
    const promptItem = createContextItem({
      id: 'prompt-1',
      kind: 'prompt',
      role: 'system',
      content: 'You MUST maintain zero latency overhead.',
    });

    const codeItem = createContextItem({
      id: 'code-1',
      kind: 'file',
      path: 'src/main.ts',
      content: 'console.log("hello");',
      language: 'typescript',
    });

    const items = [promptItem, codeItem];
    const bundle = createBundleFromItems(items);

    const gitStatus = {
      isGitRepo: true,
      repoRoot: '/repo',
      modifiedFiles: new Set(['src/main.ts']),
      stagedFiles: new Set<string>(),
      untrackedFiles: new Set<string>(),
      allDirtyFiles: new Set(['src/main.ts']),
      recentCommitFiles: new Map<string, number>(),
    };

    const graph = buildDependencyGraph(items);
    const budget = createOptimizationBudget({ riskTolerance: 'low' });

    const scores = scoreBundleTopology(bundle, gitStatus, graph, budget);

    const promptScore = scores.get('prompt-1')!;
    expect(promptScore).toBeDefined();
    expect(promptScore.score).toBeGreaterThanOrEqual(1.0);
    expect(promptScore.score).toBeLessThanOrEqual(100.0);
    expect(promptScore.hasConstraints).toBe(true);
    expect(promptScore.isPinned).toBe(true);

    const codeScore = scores.get('code-1')!;
    expect(codeScore).toBeDefined();
    expect(codeScore.score).toBeGreaterThanOrEqual(1.0);
    expect(codeScore.score).toBeLessThanOrEqual(100.0);
    expect(codeScore.isDirty).toBe(true);
    expect(codeScore.graphDistance).toBe(0);
  });
});
