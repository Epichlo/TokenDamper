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
    expect(firstItem?.content).toMatch(/^\[TokenDamper: \d+ [a-z-]+ lines? elided, \d+ bytes, sha256:[a-f0-9]{12}\]$/);
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

describe('runTokenHashingStage — sub-item granularity', () => {
  const bundleOf = (item: ReturnType<typeof createContextItem>): ContextBundle =>
    freeze({
      id: 'b',
      bundleId: 'b',
      source: 'file',
      items: freeze([item]),
      summary: freeze({ itemCount: 1, tokenEstimate: 100, preview: item.content.slice(0, 20) }),
      statistics: freeze({
        itemCount: 1,
        contentTypeCounts: freeze({ text: 0, markdown: 0, code: 1, html: 0, json: 0, yaml: 0, logs: 0, unknown: 0 }),
        kindCounts: freeze({ prompt: 0, file: 1, diff: 0, conversation: 0, note: 0 }),
        totalCharacters: item.content.length,
      }),
      contentHash: 'b',
    });

  const filler = (n: number) => `  const filler${n} = "${'x'.repeat(60)}";`;
  const source = [
    'import { helper } from "./helper";',
    'export function alpha(x: number): number {',
    filler(1),
    filler(2),
    '  return helper(x);',
    '}',
    'export class Widget {',
    '  render(): string {',
    filler(3),
    filler(4),
    '    return "widget";',
    '  }',
    '}',
  ].join('\n');

  const budget = createOptimizationBudget({ riskTolerance: 'medium' });

  it('elides function bodies and keeps the declarations that carry the symbols', () => {
    const item = createContextItem({
      id: 'f1',
      kind: 'file',
      contentType: 'code',
      content: source,
      origin: 'src/a.ts',
      path: 'src/a.ts',
    });
    const hasher = new TokenHasher();
    const result = runTokenHashingStage(bundleOf(item), budget, { tokenHasher: hasher });

    expect(result.changed).toBe(true);
    expect(result.metrics.regionsHashed).toBe(2);

    const content = result.bundle.items[0]!.content;
    // The whole-item path would have replaced all of this with one 77-byte placeholder.
    expect(content).toContain('import { helper } from "./helper";');
    expect(content).toContain('export function alpha(x: number): number {');
    expect(content).toContain('export class Widget {');
    expect(content).toContain('render(): string {');
    expect(content).not.toContain('return helper(x);');
    expect(content).not.toContain('return "widget";');
  });

  it('round-trips byte-identically through the recovery valve', () => {
    const item = createContextItem({
      id: 'f2',
      kind: 'file',
      contentType: 'code',
      content: source,
      origin: 'src/a.ts',
      path: 'src/a.ts',
    });
    const hasher = new TokenHasher();
    const result = runTokenHashingStage(bundleOf(item), budget, { tokenHasher: hasher });

    expect(hasher.rehydrateText(result.bundle.items[0]!.content)).toBe(source);
  });

  it('is deterministic — same input, same bytes out', () => {
    const build = () =>
      createContextItem({
        id: 'f3',
        kind: 'file',
        contentType: 'code',
        content: source,
        origin: 'src/a.ts',
        path: 'src/a.ts',
      });
    const one = runTokenHashingStage(bundleOf(build()), budget, { tokenHasher: new TokenHasher() });
    const two = runTokenHashingStage(bundleOf(build()), budget, { tokenHasher: new TokenHasher() });

    expect(two.bundle.items[0]!.content).toBe(one.bundle.items[0]!.content);
    expect(two.bundle.contentHash).toBe(one.bundle.contentHash);
  });

  it('falls back to whole-item hashing where no region can be selected', () => {
    // Prose has no function bodies; behaviour here must be exactly what it was before.
    const prose = 'Detailed multi-line file content that is sufficiently long for token hashing to save space';
    const item = createContextItem({
      id: 'f4',
      kind: 'file',
      contentType: 'code',
      content: prose,
      origin: 'src/main.ts',
      path: 'src/main.ts',
    });
    const result = runTokenHashingStage(bundleOf(item), budget, { tokenHasher: new TokenHasher() });

    expect(result.changed).toBe(true);
    expect(result.metrics.regionsHashed).toBe(0);
    expect(result.bundle.items[0]!.content).toMatch(/^\[TokenDamper: \d+ [a-z-]+ lines? elided, \d+ bytes, sha256:[a-f0-9]{12}\]$/);
  });

  it('refuses a docstring-only body rather than deleting the specification', () => {
    // The Phase 1d precondition, and the assertion moved one step earlier — audit H5, §43.
    //
    // This used to read "whole-item hashing is still attempted and still refused by drift
    // downstream; what must not happen is a 'successful' 55% reduction here", and asserted that
    // the content *became* a marker. The intent — never a successful-looking reduction that
    // deletes the specification — is unchanged and better served: the elision is no longer
    // attempted at all.
    //
    // Since DECISIONS §40 an unmeasured `R_struct` contributes nothing, so for code
    // `S_k = 1 - R_AST`; destroying every symbol gives `S_k = 1.0` against a gate that fires
    // above 0.40. There is no configuration in which this elision survives validation, so
    // performing it only guaranteed a fallback. On a one-item bundle that was invisible — the run
    // fell back and emitted the input, which is what skipping produces anyway. On a multi-item
    // bundle it took every other file down with it.
    //
    // `has_close_elements` is the symbol that makes this item ineligible; a symbol-free item is
    // still elided whole, which is what the whole-item path exists for.
    const docOnly = [
      'def has_close_elements(numbers, threshold):',
      '    """ Check if in given list of numbers, any two numbers are closer to each',
      '    other than the given threshold.',
      '    >>> has_close_elements([1.0, 2.0, 3.0], 0.5)',
      '    False',
      '    """',
      '',
    ].join('\n');
    const item = createContextItem({
      id: 'f5',
      kind: 'file',
      contentType: 'code',
      content: docOnly,
      origin: 'src/a.py',
      path: 'src/a.py',
    });
    const result = runTokenHashingStage(bundleOf(item), budget, { tokenHasher: new TokenHasher() });

    expect(result.metrics.regionsHashed ?? 0).toBe(0);
    expect(result.changed).toBe(false);

    // The specification survives intact — which is the property the test is named for.
    expect(result.bundle.items[0]!.content).toBe(docOnly);
    expect(result.bundle.items[0]!.content).toContain('""" Check if');
    expect(result.bundle.items[0]!.content).not.toMatch(/\[TokenDamper: /);
  });

  it('still elides a symbol-free item whole — that is what the whole-item path is for', () => {
    // The other side of the rule above. No symbols means `R_AST` has nothing to score, so the
    // elision is not doomed, and the measurement gate (§37) governs the case instead.
    const prose = [
      'Release notes for the 2.1 series.',
      'The queue drains in the background and the dashboard lags by about a minute.',
      'Contact the platform team with questions about capacity planning.',
      '',
    ].join('\n');
    const item = createContextItem({
      id: 'f6',
      kind: 'file',
      contentType: 'text',
      content: prose,
      origin: 'notes.txt',
      path: 'notes.txt',
    });

    const result = runTokenHashingStage(bundleOf(item), budget, { tokenHasher: new TokenHasher() });

    expect(result.changed).toBe(true);
    expect(result.bundle.items[0]!.content).toMatch(/^\[TokenDamper: \d+ [a-z-]+ lines? elided, \d+ bytes, sha256:[a-f0-9]{12}\]$/);
  });
});
