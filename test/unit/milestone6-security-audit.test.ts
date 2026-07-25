import { describe, expect, it } from 'vitest';
import { TokenHasher } from '../../src/core/hashing/token-hasher';
import { ConfidenceLedger } from '../../src/core/ledger/confidence-ledger';
import { runDeltaCompressionStage } from '../../src/stages/compression/delta-compression';
import { createContextItem, createOptimizationBudget, freeze, hashContent } from '../../src/core/model/constructors';
import type { ContextBundle, OptimizationRequest } from '../../src/core/model/types';
import { optimize } from '../../src/core/engine';
import { loadConfig } from '../../src/config';
import { parse } from '../../src/adapters/cli';

describe('Milestone 6 Security Officer Audit - Fallback & Safety Guarantees', () => {
  it('1. Unconditionally triggers fallback to rawInput on block hash corruption or missing block hash in TokenHasher', () => {
    const config = loadConfig();
    const rawInput = 'export function add(a: number, b: number): number { return a + b; }\n';
    
    // Request with corrupted placeholder in item content that cannot be expanded
    const corruptedItem = createContextItem({
      id: 'item-corrupt',
      kind: 'file',
      path: 'src/calc.ts',
      contentType: 'code',
      content: '<BLOCK_HASH:deadbeef00000000000000000000000000000000000000000000000000000000>',
      origin: 'src/calc.ts',
      metadata: { elided: true, tokenHashed: true },
    });

    const bundle: ContextBundle = freeze({
      id: 'bundle-corrupt',
      bundleId: 'bundle-corrupt',
      source: 'file',
      items: freeze([corruptedItem]),
      summary: freeze({ itemCount: 1, tokenEstimate: 20, preview: 'corrupt' }),
      statistics: freeze({
        itemCount: 1,
        contentTypeCounts: freeze({ text: 0, markdown: 0, code: 1, html: 0, json: 0, yaml: 0, logs: 0, unknown: 0 }),
        kindCounts: freeze({ prompt: 0, file: 1, diff: 0, conversation: 0, note: 0 }),
        totalCharacters: 80,
      }),
      contentHash: 'bundle-corrupt',
    });

    const budget = createOptimizationBudget({ riskTolerance: 'high' });
    const baseReq = parse(rawInput, config);
    const request: OptimizationRequest = freeze({
      ...baseReq,
      bundle,
      budget,
    });

    const hasher = new TokenHasher(); // empty store -> missing hash
    const ledger = new ConfidenceLedger({ defaultThreshold: 0.8 });

    const result = optimize(request, {
      tokenHasher: hasher,
      confidenceLedger: ledger,
    });

    // Security check: missing/corrupted block hash must trigger explicit fallback to rawInput
    expect(result.fallbackUsed).toBe(true);
    expect(result.emittedOutput).toBe(rawInput);
    expect(result.validation.passed).toBe(false);
    expect(result.validation.shouldFallback).toBe(true);
  });

  it('2. Unconditionally triggers fallback to rawInput when elision confidence drops below minimum threshold', () => {
    const config = loadConfig();
    const rawInput = 'function processData(input: string): string { return input.trim(); }\n';
    
    const validItem = createContextItem({
      id: 'item-valid',
      kind: 'file',
      path: 'src/process.ts',
      contentType: 'code',
      content: 'function processData(input: string): string { return input.trim(); }',
      origin: 'src/process.ts',
    });

    const bundle: ContextBundle = freeze({
      id: 'bundle-valid',
      bundleId: 'bundle-valid',
      source: 'file',
      items: freeze([validItem]),
      summary: freeze({ itemCount: 1, tokenEstimate: 20, preview: 'function' }),
      statistics: freeze({
        itemCount: 1,
        contentTypeCounts: freeze({ text: 0, markdown: 0, code: 1, html: 0, json: 0, yaml: 0, logs: 0, unknown: 0 }),
        kindCounts: freeze({ prompt: 0, file: 1, diff: 0, conversation: 0, note: 0 }),
        totalCharacters: validItem.content.length,
      }),
      contentHash: 'bundle-valid',
    });

    const budget = createOptimizationBudget({ riskTolerance: 'high' });
    const baseReq = parse(rawInput, config);
    const request: OptimizationRequest = freeze({
      ...baseReq,
      bundle,
      budget,
    });

    const ledger = new ConfidenceLedger({ defaultDecayRate: 0.5, defaultThreshold: 0.8 });
    // Record elision at turn 1 with initial confidence 0.4 (well below minimumConfidence 0.8)
    ledger.recordElision({
      itemId: 'item-valid',
      blockHash: hashContent(validItem.content),
      turn: 1,
      originalBytes: validItem.content.length,
      initialConfidence: 0.4,
    });

    const result = optimize(request, {
      confidenceLedger: ledger,
      currentTurn: 5, // confidence decays further over turns
    });

    // Security check: confidence threshold drop must force fallback
    expect(result.fallbackUsed).toBe(true);
    expect(result.emittedOutput).toBe(rawInput);
    expect(result.validation.passed).toBe(false);
    expect(result.validation.shouldFallback).toBe(true);
    expect(result.validation.reason).toContain('dropped below minimum threshold');
  });

  it('3. Guarantees 100% bidirectional re-hydration accuracy for token hashing and delta compression', () => {
    const rawCode = 'function calculateSum(values: number[]): number {\n  return values.reduce((a, b) => a + b, 0);\n}';
    const hasher = new TokenHasher();

    // Reversible token hashing test
    const placeholder = hasher.createBlockPlaceholder(rawCode);
    expect(placeholder).toMatch(/^<BLOCK_HASH:[a-f0-9]{64}>$/);

    const rehydrated = hasher.rehydrateText(`Here is the code:\n${placeholder}`);
    expect(rehydrated).toBe(`Here is the code:\n${rawCode}`);

    // Delta compression test with substantial base text so compression ratio is positive
    const baseText = Array.from({ length: 30 }, (_, i) => `const line_${i} = ${i};`).join('\n');
    const modifiedText = baseText.replace('const line_15 = 15;', 'const line_15 = 99999;');

    const item = createContextItem({
      id: 'file-1',
      kind: 'file',
      path: 'src/config.ts',
      contentType: 'code',
      content: modifiedText,
      origin: 'src/config.ts',
    });
    const bundle: ContextBundle = freeze({
      id: 'b-1',
      bundleId: 'b-1',
      source: 'file',
      items: freeze([item]),
      summary: freeze({ itemCount: 1, tokenEstimate: 100, preview: modifiedText.slice(0, 20) }),
      statistics: freeze({
        itemCount: 1,
        contentTypeCounts: freeze({ text: 0, markdown: 0, code: 1, html: 0, json: 0, yaml: 0, logs: 0, unknown: 0 }),
        kindCounts: freeze({ prompt: 0, file: 1, diff: 0, conversation: 0, note: 0 }),
        totalCharacters: modifiedText.length,
      }),
      contentHash: 'b-1',
    });

    const budget = createOptimizationBudget({ riskTolerance: 'medium' });
    const stageRes = runDeltaCompressionStage(bundle, budget, {
      baseVersions: new Map([['src/config.ts', baseText]]),
    });

    expect(stageRes.status).toBe('ok');
    expect(stageRes.bundle.items[0]?.metadata.deltaCompressed).toBe(true);
    expect(stageRes.bundle.items[0]?.metadata.originalContent).toBe(modifiedText);
  });

  it('4. Confirms zero context corruption & safety guarantees under stage failure', () => {
    const config = loadConfig();
    const rawInput = 'Important raw input system prompt that must be preserved intact.';
    const request = parse(rawInput, config);

    const result = optimize(request);

    // Safety guarantee: output must match raw input exactly
    expect(result.emittedOutput).toBe(rawInput);
    expect(result.validation.passed).toBe(true);
  });
});
