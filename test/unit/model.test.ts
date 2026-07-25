import { describe, expect, it } from 'vitest';
import {
  classifyContent,
  createContextBundle,
  createContextItem,
  createOptimizationBudget,
  createOptimizationPlan,
  createOptimizationRequest,
  createOptimizationResult,
  createOptimizationTrace,
  createValidationReport,
  hashContent,
} from '../../src/core/model';

describe('core model', () => {
  it('constructs immutable request and result shapes', () => {
    const bundle = createContextBundle('sample prompt text', 'text');
    const budget = createOptimizationBudget({
      maxInputTokens: 100,
      maxOutputTokens: 100,
      targetReductionRatio: 0,
      maxLatencyMs: 1000,
      riskTolerance: 'low',
      preserveKinds: [],
    });

    const plan = createOptimizationPlan({
      planId: 'plan-1',
      mode: 'pass_through',
      stageIds: [],
      revalidationPoints: ['end'],
      fallbackPolicy: 'original_input',
      expectedSavings: 0,
    });

    const validation = createValidationReport({
      passed: true,
      confidence: 1,
      issues: [],
      shouldFallback: false,
    });

    const trace = createOptimizationTrace({
      requestId: 'request-1',
      bundleId: bundle.bundleId,
      bundleContentHash: bundle.contentHash,
      planMode: 'pass_through',
      stageCount: 0,
      stageTraces: [],
      inputTokenEstimate: 2,
      outputTokenEstimate: 2,
      tokenBefore: 2,
      tokenAfter: 2,
      bundleStatistics: bundle.statistics,
      fallbackUsed: false,
    });

    const request = createOptimizationRequest(
      'sample prompt text',
      {
        appName: 'TokenDamper',
        appVersion: '0.1.0',
        appMode: 'optimize',
        traceOutput: 'stderr',
        planner: { defaultMode: 'pass_through' },
        budget,
        validation: { minimumConfidence: 1 },
        logging: { level: 'info' },
      },
      {
        requestId: 'request-1',
        adapterName: 'cli',
        adapterVersion: '0.1.0',
        source: 'text',
      },
    );

    const result = createOptimizationResult({
      finalBundle: bundle,
      emittedOutput: 'sample prompt text',
      validation,
      trace,
      fallbackUsed: false,
    });

    expect(bundle.items[0]).toMatchObject({ kind: 'prompt', contentType: 'text' });
    expect(bundle.summary.itemCount).toBe(1);
    expect(plan.mode).toBe('pass_through');
    expect(request.rawInput).toBe('sample prompt text');
    expect(result.emittedOutput).toBe('sample prompt text');
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(budget)).toBe(true);
  });

  it('constructs an immutable ContextItem using createContextItem', () => {
    const item = createContextItem({
      id: 'hash123',
      kind: 'prompt',
      contentType: 'text',
      content: 'hello world',
      origin: 'cli',
      contentHash: 'hash123',
      metadata: { source: 'test' },
    });

    expect(item.id).toBe('hash123');
    expect(item.contentType).toBe('text');
    expect(Object.isFrozen(item)).toBe(true);
  });

  describe('content classification', () => {
    it('classifies JSON content accurately', () => {
      expect(classifyContent('{"key": "value"}', 'text')).toBe('json');
      expect(classifyContent('[1, 2, 3]', 'file', 'data.json')).toBe('json');
    });

    it('classifies YAML content accurately', () => {
      expect(classifyContent('version: "3.8"\nservices:\n  app:\n    image: node', 'file', 'docker-compose.yml')).toBe('yaml');
      expect(classifyContent('---\nfoo: bar\n', 'text')).toBe('yaml');
    });

    it('classifies HTML content accurately', () => {
      expect(classifyContent('<!DOCTYPE html><html><body><h1>Title</h1></body></html>', 'text')).toBe('html');
      expect(classifyContent('<div><p>Hello</p></div>', 'file', 'index.html')).toBe('html');
    });

    it('classifies logs accurately', () => {
      expect(classifyContent('2026-07-25 12:00:00 [INFO] Application started', 'text')).toBe('logs');
      expect(classifyContent('12:00:01.456 ERROR Failed to connect to server', 'file', 'app.log')).toBe('logs');
    });

    it('classifies markdown content accurately', () => {
      expect(classifyContent('# Title\n\n- item 1\n- item 2\n', 'text')).toBe('markdown');
      expect(classifyContent('Check out [link](https://example.com)', 'file', 'README.md')).toBe('markdown');
    });

    it('classifies code content accurately', () => {
      expect(classifyContent('function add(a: number, b: number): number { return a + b; }', 'file', 'math.ts')).toBe('code');
      expect(classifyContent('```python\ndef foo():\n    pass\n```', 'text')).toBe('code');
    });

    it('classifies general text accurately', () => {
      expect(classifyContent('Just a plain sentence with no special markup.', 'text')).toBe('text');
    });

    it('classifies empty content as unknown', () => {
      expect(classifyContent('   ', 'text')).toBe('unknown');
    });
  });

  describe('deterministic hashing', () => {
    it('produces identical hashes regardless of key order in objects', () => {
      const hash1 = hashContent({ b: 2, a: 1, c: { y: 'bar', x: 'foo' } });
      const hash2 = hashContent({ a: 1, c: { x: 'foo', y: 'bar' }, b: 2 });

      expect(hash1).toBe(hash2);
      expect(typeof hash1).toBe('string');
      expect(hash1.length).toBe(64);
    });
  });

  describe('budget validation & resolution', () => {
    it('validates bounds on budget parameters', () => {
      expect(() => createOptimizationBudget({ maxInputTokens: -1 })).toThrow('maxInputTokens');
      expect(() => createOptimizationBudget({ targetReductionRatio: 1.5 })).toThrow('targetReductionRatio');
      expect(() => createOptimizationBudget({ riskTolerance: 'invalid' as never })).toThrow('riskTolerance');
    });
  });
});

