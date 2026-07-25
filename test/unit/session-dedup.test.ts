import { describe, expect, it } from 'vitest';
import { createContextItem, createOptimizationBudget, freeze, hashContent } from '../../src/core/model/constructors';
import type { ContextBundle } from '../../src/core/model/types';
import { runSessionDedupStage } from '../../src/stages/cleanup/session-dedup';

describe('runSessionDedupStage', () => {
  it('returns unchanged bundle when no previous block hashes exist', () => {
    const item = createContextItem({
      id: 'item-1',
      kind: 'conversation',
      contentType: 'text',
      content: 'Hello world this is a test prompt content that is sufficiently long',
      origin: 'test',
      contentHash: 'hash-1',
      metadata: {},
    });

    const bundle: ContextBundle = freeze({
      id: 'bundle-1',
      bundleId: 'bundle-1',
      source: 'text',
      items: freeze([item]),
      summary: freeze({ itemCount: 1, tokenEstimate: 20, preview: 'Hello' }),
      statistics: freeze({
        itemCount: 1,
        contentTypeCounts: freeze({ text: 1, markdown: 0, code: 0, html: 0, json: 0, yaml: 0, logs: 0, unknown: 0 }),
        kindCounts: freeze({ prompt: 0, file: 0, diff: 0, conversation: 1, note: 0 }),
        totalCharacters: 65,
      }),
      contentHash: 'bundle-1',
    });

    const budget = createOptimizationBudget({ riskTolerance: 'low' });
    const result = runSessionDedupStage(bundle, budget);

    expect(result.changed).toBe(false);
    expect(result.metrics.itemsDeduped).toBe(0);
    expect(result.bundle).toBe(bundle);
  });

  it('elides repeated context block when hash was seen in previous turn', () => {
    const rawContent = 'Detailed file context content that is repeated across turns in a conversation';
    const contentHash = hashContent({ role: 'user', content: rawContent });

    const item = createContextItem({
      id: 'item-1',
      kind: 'conversation',
      contentType: 'text',
      content: rawContent,
      origin: 'test',
      contentHash,
      metadata: {},
    });

    const bundle: ContextBundle = freeze({
      id: 'bundle-1',
      bundleId: 'bundle-1',
      source: 'text',
      items: freeze([item]),
      summary: freeze({ itemCount: 1, tokenEstimate: 20, preview: rawContent.slice(0, 20) }),
      statistics: freeze({
        itemCount: 1,
        contentTypeCounts: freeze({ text: 1, markdown: 0, code: 0, html: 0, json: 0, yaml: 0, logs: 0, unknown: 0 }),
        kindCounts: freeze({ prompt: 0, file: 0, diff: 0, conversation: 1, note: 0 }),
        totalCharacters: rawContent.length,
      }),
      contentHash: 'bundle-1',
    });

    const budget = createOptimizationBudget({ riskTolerance: 'low' });
    const previousBlockHashes = new Set([contentHash]);

    const result = runSessionDedupStage(bundle, budget, { previousBlockHashes });

    expect(result.changed).toBe(true);
    expect(result.metrics.itemsDeduped).toBe(1);

    const firstItem = result.bundle.items[0];
    expect(firstItem).toBeDefined();
    expect(firstItem?.content).toContain('[TokenDamper Elided: ref=');
    expect(firstItem?.metadata.elided).toBe(true);
  });

  it('respects preserveKinds in optimization budget', () => {
    const rawContent = 'Protected file context block';
    const contentHash = hashContent({ role: 'user', content: rawContent });

    const item = createContextItem({
      id: 'item-1',
      kind: 'file',
      contentType: 'text',
      content: rawContent,
      origin: 'test',
      contentHash,
      metadata: {},
    });

    const bundle: ContextBundle = freeze({
      id: 'bundle-1',
      bundleId: 'bundle-1',
      source: 'text',
      items: freeze([item]),
      summary: freeze({ itemCount: 1, tokenEstimate: 10, preview: rawContent }),
      statistics: freeze({
        itemCount: 1,
        contentTypeCounts: freeze({ text: 1, markdown: 0, code: 0, html: 0, json: 0, yaml: 0, logs: 0, unknown: 0 }),
        kindCounts: freeze({ prompt: 0, file: 1, diff: 0, conversation: 0, note: 0 }),
        totalCharacters: rawContent.length,
      }),
      contentHash: 'bundle-1',
    });

    const budget = createOptimizationBudget({ riskTolerance: 'low', preserveKinds: ['file'] });
    const previousBlockHashes = new Set([contentHash]);

    const result = runSessionDedupStage(bundle, budget, { previousBlockHashes });

    expect(result.changed).toBe(false);
    const firstItem = result.bundle.items[0];
    expect(firstItem?.content).toBe(rawContent);
  });

  it('preserves system prompt for prompt-cache stability', () => {
    const rawContent = 'System prompt instructions';
    const contentHash = hashContent({ role: 'system', content: rawContent });

    const item = createContextItem({
      id: 'sys-1',
      kind: 'prompt',
      contentType: 'text',
      content: rawContent,
      origin: 'system',
      contentHash,
      role: 'system',
      metadata: { role: 'system' },
    });

    const bundle: ContextBundle = freeze({
      id: 'bundle-sys',
      bundleId: 'bundle-sys',
      source: 'text',
      items: freeze([item]),
      summary: freeze({ itemCount: 1, tokenEstimate: 10, preview: rawContent }),
      statistics: freeze({
        itemCount: 1,
        contentTypeCounts: freeze({ text: 1, markdown: 0, code: 0, html: 0, json: 0, yaml: 0, logs: 0, unknown: 0 }),
        kindCounts: freeze({ prompt: 1, file: 0, diff: 0, conversation: 0, note: 0 }),
        totalCharacters: rawContent.length,
      }),
      contentHash: 'bundle-sys',
    });

    const budget = createOptimizationBudget({ riskTolerance: 'low' });
    const previousBlockHashes = new Set([contentHash]);

    const result = runSessionDedupStage(bundle, budget, { previousBlockHashes });

    expect(result.changed).toBe(false);
    const firstItem = result.bundle.items[0];
    expect(firstItem?.content).toBe(rawContent);
  });
});
