import { describe, expect, it } from 'vitest';
import { createContextItem, createOptimizationBudget, createOptimizationPlan, freeze } from '../../src/core/model/constructors';
import type { ContextBundle } from '../../src/core/model/types';
import { validate } from '../../src/core/validation';

describe('Validation Integration (AST & Constraint Directive Retention)', () => {
  const budget = createOptimizationBudget({ riskTolerance: 'low' });
  const plan = createOptimizationPlan({
    planId: 'plan-1',
    mode: 'pass_through',
    stageIds: [],
    revalidationPoints: ['end'],
    fallbackPolicy: 'original_input',
  });

  function makeBundle(content: string, language = 'ts', contentType: 'code' | 'json' | 'text' = 'code'): ContextBundle {
    const item = createContextItem({
      id: 'item-1',
      kind: 'file',
      contentType,
      content,
      origin: 'src/main.ts',
      contentHash: 'hash-1',
      language,
      metadata: {},
    });

    return freeze({
      id: 'b1',
      bundleId: 'b1',
      source: 'file',
      items: freeze([item]),
      summary: freeze({ itemCount: 1, tokenEstimate: 10, preview: content.slice(0, 20) }),
      statistics: freeze({
        itemCount: 1,
        contentTypeCounts: freeze({ text: contentType === 'text' ? 1 : 0, markdown: 0, code: contentType === 'code' ? 1 : 0, html: 0, json: contentType === 'json' ? 1 : 0, yaml: 0, logs: 0, unknown: 0 }),
        kindCounts: freeze({ prompt: 0, file: 1, diff: 0, conversation: 0, note: 0 }),
        totalCharacters: content.length,
      }),
      contentHash: 'b1',
    });
  }

  it('passes validation when syntax is clean and all constraints are retained', () => {
    const before = makeBundle('// Note: You MUST retain error handling\nfunction add(a: number, b: number) { return a + b; }');
    const after = makeBundle('// Note: You MUST retain error handling\nfunction add(a: number, b: number) { return a + b; }');

    const report = validate(before, after, plan, budget);
    expect(report.passed).toBe(true);
    expect(report.shouldFallback).toBe(false);
    expect(report.confidence).toBe(1);
    expect(report.issues).toHaveLength(0);
  });

  it('triggers shouldFallback: true when optimized bundle has broken AST syntax', () => {
    const before = makeBundle('const x = [1, 2, 3];');
    const after = makeBundle('const x = [1, 2, 3;'); // missing closing bracket

    const report = validate(before, after, plan, budget);
    expect(report.passed).toBe(false);
    expect(report.shouldFallback).toBe(true);
    expect(report.confidence).toBe(0);
    expect(report.issues.some((i) => i.code === 'AST_UNBALANCED_BRACKET')).toBe(true);
  });

  it('triggers shouldFallback: true when JSON syntax is broken in optimized bundle', () => {
    const before = makeBundle('{"key": "value"}', 'json', 'json');
    const after = makeBundle('{"key": "value",}', 'json', 'json'); // trailing comma in JSON

    const report = validate(before, after, plan, budget);
    expect(report.passed).toBe(false);
    expect(report.shouldFallback).toBe(true);
    expect(report.issues.some((i) => i.code === 'JSON_SYNTAX_ERROR')).toBe(true);
  });

  it('triggers shouldFallback: true when an imperative constraint directive is dropped', () => {
    const before = makeBundle('You MUST NOT mutate state directly.\nfunction update() {}', 'ts', 'text');
    const after = makeBundle('function update() {}', 'ts', 'text'); // dropped "MUST NOT" directive

    const report = validate(before, after, plan, budget);
    expect(report.passed).toBe(false);
    expect(report.shouldFallback).toBe(true);
    expect(report.issues.some((i) => i.code === 'CONSTRAINT_DIRECTIVE_LOST')).toBe(true);
    expect(report.issues[0]?.message).toContain('MUST NOT');
  });

  it('detects missing constraints even if AST syntax is valid', () => {
    const before = makeBundle('// You NEVER return null;\nfunction getValue() { return 42; }');
    const after = makeBundle('function getValue() { return 42; }');

    const report = validate(before, after, plan, budget);
    expect(report.passed).toBe(false);
    expect(report.shouldFallback).toBe(true);
    expect(report.issues.some((i) => i.code === 'CONSTRAINT_DIRECTIVE_LOST')).toBe(true);
  });
});
