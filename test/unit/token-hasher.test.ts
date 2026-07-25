import { describe, expect, it } from 'vitest';
import { TokenHasher } from '../../src/core/hashing/token-hasher';
import { runTokenHashingStage } from '../../src/stages/compression/token-hashing';
import { createContextItem, createOptimizationBudget, freeze, hashContent } from '../../src/core/model/constructors';
import type { ContextBundle } from '../../src/core/model/types';

describe('TokenHasher', () => {
  it('creates block placeholders with deterministic SHA-256 hashes', () => {
    const hasher = new TokenHasher();
    const rawContent = 'function helloWorld() { console.log("hello"); }';
    const expectedHash = hashContent(rawContent);

    const placeholder = hasher.createBlockPlaceholder(rawContent);

    expect(placeholder).toBe(`<BLOCK_HASH:${expectedHash}>`);
    expect(hasher.hasHash(expectedHash)).toBe(true);
    expect(hasher.hasHash(placeholder)).toBe(true);
    expect(hasher.size).toBe(1);
  });

  it('expands block hash or placeholder back to original content', () => {
    const hasher = new TokenHasher();
    const rawContent = 'const secretKey = "api_key_12345";';
    const placeholder = hasher.createBlockPlaceholder(rawContent);
    const hash = hashContent(rawContent);

    expect(hasher.expandBlockHash(placeholder)).toBe(rawContent);
    expect(hasher.expandBlockHash(hash)).toBe(rawContent);
    expect(hasher.expandBlockHash('non_existent_hash')).toBeUndefined();
  });

  it('rehydrates text containing single or multiple block placeholders', () => {
    const hasher = new TokenHasher();
    const text1 = 'export class UserStore { constructor() {} }';
    const text2 = 'function validateEmail(email: string) { return email.includes("@"); }';

    const ph1 = hasher.createBlockPlaceholder(text1);
    const ph2 = hasher.createBlockPlaceholder(text2);

    const combinedText = `File 1:\n${ph1}\n\nFile 2:\n${ph2}\n\nUnknown: <BLOCK_HASH:unknown_hash_999>`;
    const rehydrated = hasher.rehydrateText(combinedText);

    expect(rehydrated).toContain(text1);
    expect(rehydrated).toContain(text2);
    expect(rehydrated).toContain('<BLOCK_HASH:unknown_hash_999>');
  });

  it('initializes from pre-existing stored blocks', () => {
    const rawContent = 'Pre-existing block content';
    const hash = hashContent(rawContent);

    const hasher = new TokenHasher([{ hash, content: rawContent }]);

    expect(hasher.size).toBe(1);
    expect(hasher.expandBlockHash(hash)).toBe(rawContent);
  });

  it('clears all stored mappings', () => {
    const hasher = new TokenHasher();
    hasher.createBlockPlaceholder('Some content');
    expect(hasher.size).toBe(1);

    hasher.clear();
    expect(hasher.size).toBe(0);
  });
});

describe('runTokenHashingStage', () => {
  it('token-hashes eligible context items and updates bundle metadata', () => {
    const hasher = new TokenHasher();
    const rawContent = 'Detailed multi-line file content that is sufficiently long for token hashing to save space';
    const item = createContextItem({
      id: 'file-1',
      kind: 'file',
      contentType: 'code',
      content: rawContent,
      origin: 'src/main.ts',
      path: 'src/main.ts',
    });

    const bundle: ContextBundle = freeze({
      id: 'bundle-1',
      bundleId: 'bundle-1',
      source: 'file',
      items: freeze([item]),
      summary: freeze({ itemCount: 1, tokenEstimate: 30, preview: rawContent.slice(0, 20) }),
      statistics: freeze({
        itemCount: 1,
        contentTypeCounts: freeze({ text: 0, markdown: 0, code: 1, html: 0, json: 0, yaml: 0, logs: 0, unknown: 0 }),
        kindCounts: freeze({ prompt: 0, file: 1, diff: 0, conversation: 0, note: 0 }),
        totalCharacters: rawContent.length,
      }),
      contentHash: 'bundle-1',
    });

    const budget = createOptimizationBudget({ riskTolerance: 'medium' });
    const result = runTokenHashingStage(bundle, budget, { tokenHasher: hasher });

    expect(result.status).toBe('ok');
    expect(result.changed).toBe(true);
    expect(result.metrics.itemsHashed).toBe(1);
    expect(result.metrics.bytesSaved).toBeGreaterThan(0);

    const firstItem = result.bundle.items[0];
    expect(firstItem?.content).toMatch(/^<BLOCK_HASH:[a-f0-9]{64}>$/);
    expect(firstItem?.metadata.elided).toBe(true);
    expect(firstItem?.metadata.tokenHashed).toBe(true);
  });

  it('respects preserveKinds in optimization budget', () => {
    const rawContent = 'Protected file content that must not be elided or token hashed by the engine';
    const item = createContextItem({
      id: 'file-1',
      kind: 'file',
      contentType: 'code',
      content: rawContent,
      origin: 'src/main.ts',
    });

    const bundle: ContextBundle = freeze({
      id: 'bundle-1',
      bundleId: 'bundle-1',
      source: 'file',
      items: freeze([item]),
      summary: freeze({ itemCount: 1, tokenEstimate: 30, preview: rawContent }),
      statistics: freeze({
        itemCount: 1,
        contentTypeCounts: freeze({ text: 0, markdown: 0, code: 1, html: 0, json: 0, yaml: 0, logs: 0, unknown: 0 }),
        kindCounts: freeze({ prompt: 0, file: 1, diff: 0, conversation: 0, note: 0 }),
        totalCharacters: rawContent.length,
      }),
      contentHash: 'bundle-1',
    });

    const budget = createOptimizationBudget({ riskTolerance: 'low', preserveKinds: ['file'] });
    const result = runTokenHashingStage(bundle, budget);

    expect(result.changed).toBe(false);
    expect(result.bundle.items[0]?.content).toBe(rawContent);
  });

  it('preserves system prompts unconditionally', () => {
    const rawContent = 'System prompt: You are an expert AI assistant with strict compliance rules';
    const item = createContextItem({
      id: 'sys-1',
      kind: 'prompt',
      role: 'system',
      contentType: 'text',
      content: rawContent,
      origin: 'system',
    });

    const bundle: ContextBundle = freeze({
      id: 'bundle-sys',
      bundleId: 'bundle-sys',
      source: 'text',
      items: freeze([item]),
      summary: freeze({ itemCount: 1, tokenEstimate: 20, preview: rawContent }),
      statistics: freeze({
        itemCount: 1,
        contentTypeCounts: freeze({ text: 1, markdown: 0, code: 0, html: 0, json: 0, yaml: 0, logs: 0, unknown: 0 }),
        kindCounts: freeze({ prompt: 1, file: 0, diff: 0, conversation: 0, note: 0 }),
        totalCharacters: rawContent.length,
      }),
      contentHash: 'bundle-sys',
    });

    const budget = createOptimizationBudget({ riskTolerance: 'high' });
    const result = runTokenHashingStage(bundle, budget);

    expect(result.changed).toBe(false);
    expect(result.bundle.items[0]?.content).toBe(rawContent);
  });
});
