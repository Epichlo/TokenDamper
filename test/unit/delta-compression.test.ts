import { describe, expect, it } from 'vitest';
import { createUnifiedDiff, runDeltaCompressionStage } from '../../src/stages/compression/delta-compression';
import { createContextItem, createOptimizationBudget, freeze, hashContent } from '../../src/core/model/constructors';
import type { ContextBundle } from '../../src/core/model/types';

describe('createUnifiedDiff', () => {
  it('generates line-based unified diff format between two text versions', () => {
    const v1 = 'line 1\nline 2\nline 3';
    const v2 = 'line 1\nline 2 modified\nline 3';

    const diff = createUnifiedDiff(v1, v2, 'file.ts (v1)', 'file.ts (v2)');

    expect(diff).toContain('--- file.ts (v1)');
    expect(diff).toContain('+++ file.ts (v2)');
    expect(diff).toContain('-line 2');
    expect(diff).toContain('+line 2 modified');
  });
});

describe('runDeltaCompressionStage', () => {
  it('returns unchanged bundle when options/base versions are omitted', () => {
    const item = createContextItem({
      id: 'file-1',
      kind: 'file',
      contentType: 'code',
      content: 'function test() { return 1; }',
      origin: 'test.ts',
    });

    const bundle: ContextBundle = freeze({
      id: 'bundle-1',
      bundleId: 'bundle-1',
      source: 'file',
      items: freeze([item]),
      summary: freeze({ itemCount: 1, tokenEstimate: 10, preview: 'function' }),
      statistics: freeze({
        itemCount: 1,
        contentTypeCounts: freeze({ text: 0, markdown: 0, code: 1, html: 0, json: 0, yaml: 0, logs: 0, unknown: 0 }),
        kindCounts: freeze({ prompt: 0, file: 1, diff: 0, conversation: 0, note: 0 }),
        totalCharacters: 29,
      }),
      contentHash: 'bundle-1',
    });

    const budget = createOptimizationBudget({ riskTolerance: 'medium' });
    const result = runDeltaCompressionStage(bundle, budget);

    expect(result.changed).toBe(false);
    expect(result.metrics.itemsCompressed).toBe(0);
  });

  it('compresses modified file using unified delta diff when base version is present', () => {
    const baseContent = Array.from({ length: 20 }, (_, i) => `const line_${i} = ${i};`).join('\n');
    const modifiedContent = baseContent.replace('const line_10 = 10;', 'const line_10 = 9999;');

    const baseHash = hashContent(baseContent);

    const currentItem = createContextItem({
      id: 'file-main',
      kind: 'file',
      path: 'src/main.ts',
      contentType: 'code',
      content: modifiedContent,
      origin: 'src/main.ts',
    });

    const bundle: ContextBundle = freeze({
      id: 'bundle-curr',
      bundleId: 'bundle-curr',
      source: 'file',
      items: freeze([currentItem]),
      summary: freeze({ itemCount: 1, tokenEstimate: 100, preview: 'const' }),
      statistics: freeze({
        itemCount: 1,
        contentTypeCounts: freeze({ text: 0, markdown: 0, code: 1, html: 0, json: 0, yaml: 0, logs: 0, unknown: 0 }),
        kindCounts: freeze({ prompt: 0, file: 1, diff: 0, conversation: 0, note: 0 }),
        totalCharacters: modifiedContent.length,
      }),
      contentHash: 'bundle-curr',
    });

    const budget = createOptimizationBudget({ riskTolerance: 'medium' });

    const result = runDeltaCompressionStage(bundle, budget, {
      baseVersions: new Map([['src/main.ts', baseContent]]),
    });

    expect(result.status).toBe('ok');
    expect(result.changed).toBe(true);
    expect(result.metrics.itemsCompressed).toBe(1);
    expect(result.metrics.bytesSaved).toBeGreaterThan(0);

    const firstItem = result.bundle.items[0];
    expect(firstItem?.content).toContain('[TokenDamper Delta: path=src/main.ts');
    expect(firstItem?.content).toContain('-const line_10 = 10;');
    expect(firstItem?.content).toContain('+const line_10 = 9999;');
    expect(firstItem?.metadata.elided).toBe(true);
    expect(firstItem?.metadata.deltaCompressed).toBe(true);
    expect(firstItem?.metadata.baseContentHash).toBe(baseHash);
  });

  it('skips identical files where content matches base version', () => {
    const sameContent = 'const a = 1;\nconst b = 2;\n';
    const item = createContextItem({
      id: 'file-1',
      kind: 'file',
      path: 'src/same.ts',
      contentType: 'code',
      content: sameContent,
      origin: 'src/same.ts',
    });

    const bundle: ContextBundle = freeze({
      id: 'bundle-same',
      bundleId: 'bundle-same',
      source: 'file',
      items: freeze([item]),
      summary: freeze({ itemCount: 1, tokenEstimate: 10, preview: sameContent }),
      statistics: freeze({
        itemCount: 1,
        contentTypeCounts: freeze({ text: 0, markdown: 0, code: 1, html: 0, json: 0, yaml: 0, logs: 0, unknown: 0 }),
        kindCounts: freeze({ prompt: 0, file: 1, diff: 0, conversation: 0, note: 0 }),
        totalCharacters: sameContent.length,
      }),
      contentHash: 'bundle-same',
    });

    const budget = createOptimizationBudget({ riskTolerance: 'low' });
    const result = runDeltaCompressionStage(bundle, budget, {
      baseVersions: { 'src/same.ts': sameContent },
    });

    expect(result.changed).toBe(false);
    expect(result.bundle.items[0]?.content).toBe(sameContent);
  });

  it('respects preserveKinds in optimization budget', () => {
    const baseContent = Array.from({ length: 20 }, (_, i) => `const x_${i} = ${i};`).join('\n');
    const modifiedContent = baseContent.replace('const x_5 = 5;', 'const x_5 = 555;');

    const item = createContextItem({
      id: 'file-1',
      kind: 'file',
      path: 'src/preserved.ts',
      contentType: 'code',
      content: modifiedContent,
      origin: 'src/preserved.ts',
    });

    const bundle: ContextBundle = freeze({
      id: 'bundle-p',
      bundleId: 'bundle-p',
      source: 'file',
      items: freeze([item]),
      summary: freeze({ itemCount: 1, tokenEstimate: 50, preview: modifiedContent }),
      statistics: freeze({
        itemCount: 1,
        contentTypeCounts: freeze({ text: 0, markdown: 0, code: 1, html: 0, json: 0, yaml: 0, logs: 0, unknown: 0 }),
        kindCounts: freeze({ prompt: 0, file: 1, diff: 0, conversation: 0, note: 0 }),
        totalCharacters: modifiedContent.length,
      }),
      contentHash: 'bundle-p',
    });

    const budget = createOptimizationBudget({ riskTolerance: 'low', preserveKinds: ['file'] });
    const result = runDeltaCompressionStage(bundle, budget, {
      baseVersions: { 'src/preserved.ts': baseContent },
    });

    expect(result.changed).toBe(false);
    expect(result.bundle.items[0]?.content).toBe(modifiedContent);
  });
});
