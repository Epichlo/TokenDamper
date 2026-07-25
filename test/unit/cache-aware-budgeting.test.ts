import { describe, expect, it } from 'vitest';
import { applyCacheAwarePrefixLocking, getCachePinnedItemIds } from '../../src/core/planner/cache-aware';
import { runTopologyPrunerStage } from '../../src/stages/pruning/topology-pruner';
import { optimize } from '../../src/core/engine';
import { loadConfig } from '../../src/config';
import { parse } from '../../src/adapters/cli';
import {
  createBundleFromItems,
  createContextItem,
  createOptimizationBudget,
} from '../../src/core/model';
import type { ContextItem } from '../../src/core/model/types';
import { scoreBundleTopology } from '../../src/core/topology/topology-scorer';
import { buildDependencyGraph } from '../../src/core/topology/dependency-graph';

describe('cache-aware prefix locking', () => {
  it('pins system prompt items, preserved kinds, constraints, and prefix horizon', () => {
    const sysPrompt: ContextItem = createContextItem({
      id: 'item-sys',
      kind: 'prompt',
      role: 'system',
      content: 'System prompt instructions',
    });

    const earlyFile: ContextItem = createContextItem({
      id: 'item-early',
      kind: 'file',
      content: 'Short initial prefix file',
    });

    const constraintFile: ContextItem = createContextItem({
      id: 'item-constraint',
      kind: 'file',
      content: 'You MUST preserve this requirement',
    });

    const lateCandidate: ContextItem = createContextItem({
      id: 'item-late',
      kind: 'file',
      content: 'Large optional candidate context '.repeat(50),
    });

    const items = [sysPrompt, earlyFile, constraintFile, lateCandidate];
    const bundle = createBundleFromItems(items);

    const budget = createOptimizationBudget({
      maxInputTokens: 50,
      preserveKinds: ['prompt'],
      riskTolerance: 'low',
    });

    const gitStatus = {
      isGitRepo: false,
      repoRoot: null,
      modifiedFiles: new Set<string>(),
      stagedFiles: new Set<string>(),
      untrackedFiles: new Set<string>(),
      allDirtyFiles: new Set<string>(),
      recentCommitFiles: new Map<string, number>(),
    };

    const graph = buildDependencyGraph(items);
    const scores = scoreBundleTopology(bundle, gitStatus, graph, budget);

    const pinnedIds = getCachePinnedItemIds(items, scores, budget, { prefixPinHorizonTokens: 10 });
    const knapsackItems = applyCacheAwarePrefixLocking(items, scores, budget, { prefixPinHorizonTokens: 10 });

    expect(pinnedIds.has('item-sys')).toBe(true);
    expect(pinnedIds.has('item-early')).toBe(true);
    expect(pinnedIds.has('item-constraint')).toBe(true);

    const sysItem = knapsackItems.find((i) => i.id === 'item-sys');
    expect(sysItem?.isPinned).toBe(true);

    const constraintItem = knapsackItems.find((i) => i.id === 'item-constraint');
    expect(constraintItem?.isPinned).toBe(true);
  });
});

describe('topology-pruner stage', () => {
  it('runs topology pruner stage and prunes unpinned low-score candidates under budget', () => {
    const sysPrompt = createContextItem({
      id: 'sys-1',
      kind: 'prompt',
      role: 'system',
      content: 'You are an AI developer.',
    });

    const constraintItem = createContextItem({
      id: 'const-1',
      kind: 'note',
      content: 'You MUST NEVER output fake code.',
    });

    // ~2000 chars each (~500 tokens each), beyond initial prefix horizon
    const largeCandidate1 = createContextItem({
      id: 'cand-1',
      kind: 'file',
      path: 'src/low_priority_1.ts',
      content: '// Unused helper function implementation\n'.repeat(150),
    });

    const largeCandidate2 = createContextItem({
      id: 'cand-2',
      kind: 'file',
      path: 'src/low_priority_2.ts',
      content: '// Unused test utility implementation\n'.repeat(150),
    });

    const items = [sysPrompt, constraintItem, largeCandidate1, largeCandidate2];
    const bundle = createBundleFromItems(items);

    const budget = createOptimizationBudget({
      maxInputTokens: 350,
      riskTolerance: 'low',
      preserveKinds: ['prompt'],
    });

    const result = runTopologyPrunerStage(bundle, budget);

    expect(result.status).toBe('ok');
    expect(result.changed).toBe(true);
    expect(result.metrics.itemsPruned).toBeGreaterThan(0);

    const retainedItemIds = result.bundle.items.map((i) => i.id);
    expect(retainedItemIds).toContain('sys-1');
    expect(retainedItemIds).toContain('const-1');
  });
});

describe('engine end-to-end with topology knapsack optimization', () => {
  it('optimizes large context request using topology knapsack pipeline', () => {
    const config = loadConfig();
    const request = parse('Hello World', config);

    const sysItem = createContextItem({
      id: 'sys-1',
      kind: 'prompt',
      role: 'system',
      content: 'SYSTEM: You are a coding assistant. You MUST handle error cases.',
    });

    // Padding item to cross 1024 prefix horizon (~4500 chars ~1125 tokens)
    const paddingItem = createContextItem({
      id: 'pad-1',
      kind: 'file',
      path: 'src/prefix_padding.ts',
      content: '// Prefix padding context line content\n'.repeat(120),
    });

    const unpinnedCandidate = createContextItem({
      id: 'cand-beyond-horizon',
      kind: 'file',
      path: 'src/unused1.ts',
      content: '// Low priority background content line\n'.repeat(250),
    });

    const items = [sysItem, paddingItem, unpinnedCandidate];
    const multiItemBundle = createBundleFromItems(items);

    const requestWithBudget = {
      ...request,
      bundle: multiItemBundle,
      budget: createOptimizationBudget({
        maxInputTokens: 1200,
        riskTolerance: 'low',
        preserveKinds: ['prompt'],
      }),
    };

    const result = optimize(requestWithBudget);

    expect(result.trace.planMode).toBe('topology_knapsack');
    expect(result.trace.stageCount).toBe(4);
    expect(result.validation.passed).toBe(true);
    expect(result.fallbackUsed).toBe(false);
    expect(result.finalBundle.items.length).toBeLessThan(multiItemBundle.items.length);
  });
});
