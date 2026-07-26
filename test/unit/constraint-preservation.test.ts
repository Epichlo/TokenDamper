import { describe, expect, it } from 'vitest';
import { createContextItem, createOptimizationBudget, freeze } from '../../src/core/model/constructors';
import type { ContextBundle } from '../../src/core/model/types';
import {
  extractConstraintDirectives,
  runConstraintPreservationStage,
} from '../../src/stages/cleanup/constraint-preservation';

describe('extractConstraintDirectives', () => {
  it('extracts directive lines containing imperative keywords', () => {
    const text = `
      System prompt instructions.
      You MUST NOT bypass authentication.
      You NEVER return dummy fallbacks when errors occur.
      Execute action ONLY IF user approves.
      DO NOT mutate global state directly.
      Standard paragraph text.
    `;

    const { directives, keywords } = extractConstraintDirectives(text);

    expect(directives).toHaveLength(4);
    expect(directives[0]).toContain('MUST');
    expect(directives[1]).toContain('NEVER');
    expect(directives[2]).toContain('ONLY IF');
    expect(directives[3]).toContain('DO NOT');

    expect(keywords).toContain('MUST');
    expect(keywords).toContain('NEVER');
    expect(keywords).toContain('ONLY IF');
    expect(keywords).toContain('DO NOT');
  });

  it('returns empty directives when no keywords are present', () => {
    const text = 'This is a standard text prompt without imperative constraints.';
    const { directives, keywords } = extractConstraintDirectives(text);
    expect(directives).toHaveLength(0);
    expect(keywords).toHaveLength(0);
  });

  it('extracts natural language constraints case-insensitively', () => {
    const text = [
      'General implementation notes should not be preserved as directives.',
      'Before saving, you must not mutate state in place.',
      'The parser should be defensive; never return null; return a typed error instead.',
      'Always make sure to validate user input.',
      'Proceed only if the caller has provided explicit approval.',
      'This cleanup is required except when the file is generated.',
      'Critical security checks stay enabled.',
    ].join('\n');

    const { directives, keywords } = extractConstraintDirectives(text);

    expect(directives).toEqual([
      'Before saving, you must not mutate state in place.',
      'never return null;',
      'Always make sure to validate user input.',
      'Proceed only if the caller has provided explicit approval.',
      'This cleanup is required except when the file is generated.',
      'Critical security checks stay enabled.',
    ]);
    expect(keywords).toEqual(expect.arrayContaining(['must not', 'never', 'Always', 'make sure to', 'only if', 'required', 'except when', 'Critical']));
  });
});

describe('runConstraintPreservationStage', () => {
  it('scans bundle items and records directives in item metadata', () => {
    const item1 = createContextItem({
      id: 'item-1',
      kind: 'prompt',
      contentType: 'text',
      content: 'You MUST preserve all comments.\nDO NOT remove unit tests.',
      origin: 'prompt',
      contentHash: 'hash-1',
      metadata: {},
    });

    const item2 = createContextItem({
      id: 'item-2',
      kind: 'file',
      contentType: 'code',
      content: 'const x = 10;',
      origin: 'main.ts',
      contentHash: 'hash-2',
      metadata: {},
    });

    const bundle: ContextBundle = freeze({
      id: 'bundle-1',
      bundleId: 'bundle-1',
      source: 'text',
      items: freeze([item1, item2]),
      summary: freeze({ itemCount: 2, tokenEstimate: 20, preview: 'preview' }),
      statistics: freeze({
        itemCount: 2,
        contentTypeCounts: freeze({ text: 1, markdown: 0, code: 1, html: 0, json: 0, yaml: 0, logs: 0, unknown: 0 }),
        kindCounts: freeze({ prompt: 1, file: 1, diff: 0, conversation: 0, note: 0 }),
        totalCharacters: 70,
      }),
      contentHash: 'bundle-1',
    });

    const budget = createOptimizationBudget({ riskTolerance: 'low' });
    const result = runConstraintPreservationStage(bundle, budget);

    expect(result.changed).toBe(true);
    expect(result.metrics.directivesFound).toBe(2);
    expect(result.metrics.itemsWithConstraints).toBe(1);

    const firstItem = result.bundle.items[0];
    expect(firstItem?.metadata.hasConstraints).toBe(true);
    expect(firstItem?.metadata.directiveCount).toBe(2);
    expect(typeof firstItem?.metadata.constraintDirectives).toBe('string');
    expect(firstItem?.metadata.constraintDirectives).toContain('MUST');
    expect(firstItem?.metadata.constraintDirectives).toContain('DO NOT');

    const secondItem = result.bundle.items[1];
    expect(secondItem?.metadata.hasConstraints).toBe(false);
    expect(secondItem?.metadata.directiveCount).toBe(0);
  });

  it('records natural language constraints in existing metadata schema fields', () => {
    const item = createContextItem({
      id: 'item-1',
      kind: 'prompt',
      contentType: 'text',
      content: 'You must not mutate state. Ordinary text. Never return null.',
      origin: 'prompt',
      contentHash: 'hash-1',
      metadata: {},
    });

    const bundle: ContextBundle = freeze({
      id: 'bundle-1',
      bundleId: 'bundle-1',
      source: 'text',
      items: freeze([item]),
      summary: freeze({ itemCount: 1, tokenEstimate: 15, preview: 'preview' }),
      statistics: freeze({
        itemCount: 1,
        contentTypeCounts: freeze({ text: 1, markdown: 0, code: 0, html: 0, json: 0, yaml: 0, logs: 0, unknown: 0 }),
        kindCounts: freeze({ prompt: 1, file: 0, diff: 0, conversation: 0, note: 0 }),
        totalCharacters: item.content.length,
      }),
      contentHash: 'bundle-1',
    });

    const result = runConstraintPreservationStage(bundle, createOptimizationBudget({ riskTolerance: 'low' }));
    const firstItem = result.bundle.items[0];

    expect(result.changed).toBe(true);
    expect(result.metrics.directivesFound).toBe(2);
    expect(firstItem?.metadata.hasConstraints).toBe(true);
    expect(firstItem?.metadata.directiveCount).toBe(2);
    expect(firstItem?.metadata.constraintDirectives).toBe(JSON.stringify(['You must not mutate state.', 'Never return null.']));
  });

  it('returns changed false when item metadata is already up to date', () => {
    const item = createContextItem({
      id: 'item-1',
      kind: 'prompt',
      contentType: 'text',
      content: 'You MUST preserve all comments.',
      origin: 'prompt',
      contentHash: 'hash-1',
      metadata: {},
    });

    const bundle: ContextBundle = freeze({
      id: 'bundle-1',
      bundleId: 'bundle-1',
      source: 'text',
      items: freeze([item]),
      summary: freeze({ itemCount: 1, tokenEstimate: 10, preview: 'preview' }),
      statistics: freeze({
        itemCount: 1,
        contentTypeCounts: freeze({ text: 1, markdown: 0, code: 0, html: 0, json: 0, yaml: 0, logs: 0, unknown: 0 }),
        kindCounts: freeze({ prompt: 1, file: 0, diff: 0, conversation: 0, note: 0 }),
        totalCharacters: 30,
      }),
      contentHash: 'bundle-1',
    });

    const budget = createOptimizationBudget({ riskTolerance: 'low' });
    const firstRun = runConstraintPreservationStage(bundle, budget);
    expect(firstRun.changed).toBe(true);

    const secondRun = runConstraintPreservationStage(firstRun.bundle, budget);
    expect(secondRun.changed).toBe(false);
    expect(secondRun.bundle).toBe(firstRun.bundle);
  });
});
