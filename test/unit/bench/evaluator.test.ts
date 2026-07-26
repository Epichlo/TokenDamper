import { describe, expect, it } from 'vitest';
import {
  BenchmarkEvaluator,
  computeKeySymbolPreservation,
  computeTokenSimilarity,
} from '../../../src/bench/evaluator';
import type { BenchmarkFixture } from '../../../src/bench/fixtures/types';
import { optimize } from '../../../src/core/engine';
import { fixtureToOptimizationRequest } from '../../../src/bench/fixtures/loader';
import { createOptimizationBudget } from '../../../src/core/model/constructors';
import { DEFAULT_CONFIG } from '../../../src/config/schema';

describe('BenchmarkEvaluator', () => {
  const pythonFixture: BenchmarkFixture = {
    id: 'HumanEval/0',
    dataset: 'humaneval',
    prompt: 'from typing import List\n\ndef add_one(numbers: List[int]) -> List[int]:\n',
    referenceCompletion: '    return [x + 1 for x in numbers]\n',
    language: 'python',
    path: 'src/add_one.py',
    entryPoint: 'add_one',
    metadata: {},
  };

  const tsFixture: BenchmarkFixture = {
    id: 'CodeXGLUE/ts/1',
    dataset: 'codexglue',
    prompt: 'export function multiply(a: number, b: number): number {\n',
    referenceCompletion: '  return a * b;\n}',
    language: 'typescript',
    path: 'src/math.ts',
    metadata: {},
  };

  describe('evaluateFixture', () => {
    it('should evaluate quality and AST syntax on valid Python completion', () => {
      const budget = createOptimizationBudget({ riskTolerance: 'low' });
      const request = fixtureToOptimizationRequest(pythonFixture, budget, DEFAULT_CONFIG);
      const optResult = optimize(request);

      const evalResult = BenchmarkEvaluator.evaluateFixture(pythonFixture, optResult);
      expect(evalResult.fixtureId).toBe(pythonFixture.id);
      expect(evalResult.rawSyntaxValid).toBe(true);
      expect(evalResult.optimizedSyntaxValid).toBe(true);
      expect(evalResult.syntaxPreserved).toBe(true);
      expect(evalResult.keySymbolPreservationRatio).toBeGreaterThan(0.5);
      expect(evalResult.tokenSimilarityScore).toBeGreaterThan(0);
      expect(evalResult.overallPassed).toBe(true);
    });

    it('should evaluate quality and AST syntax on valid TypeScript completion', () => {
      const budget = createOptimizationBudget({ riskTolerance: 'low' });
      const request = fixtureToOptimizationRequest(tsFixture, budget, DEFAULT_CONFIG);
      const optResult = optimize(request);

      const evalResult = BenchmarkEvaluator.evaluateFixture(tsFixture, optResult);
      expect(evalResult.rawSyntaxValid).toBe(true);
      expect(evalResult.optimizedSyntaxValid).toBe(true);
      expect(evalResult.syntaxPreserved).toBe(true);
    });

    it('should detect invalid AST syntax when reference completion has bracket syntax errors', () => {
      const brokenFixture: BenchmarkFixture = {
        ...tsFixture,
        referenceCompletion: '  return a * (b;\n}', // Unclosed parenthesis
      };

      const budget = createOptimizationBudget({ riskTolerance: 'low' });
      const request = fixtureToOptimizationRequest(brokenFixture, budget, DEFAULT_CONFIG);
      const optResult = optimize(request);

      const evalResult = BenchmarkEvaluator.evaluateFixture(brokenFixture, optResult);
      expect(evalResult.rawSyntaxValid).toBe(false);
      expect(evalResult.rawAstIssues.length).toBeGreaterThan(0);
    });
  });

  describe('evaluateDataset', () => {
    it('should compute aggregated dataset quality report metrics', () => {
      const fixtures = [pythonFixture, tsFixture];
      const budget = createOptimizationBudget({ riskTolerance: 'low' });

      const results = fixtures.map((f) => {
        const req = fixtureToOptimizationRequest(f, budget, DEFAULT_CONFIG);
        return optimize(req);
      });

      const report = BenchmarkEvaluator.evaluateDataset(fixtures, results);
      expect(report.totalItems).toBe(2);
      expect(report.rawPassRate).toBe(1.0);
      expect(report.optimizedPassRate).toBe(1.0);
      expect(report.passRateDelta).toBe(0);
      expect(report.avgKeySymbolPreservation).toBeGreaterThan(0);
      expect(report.avgTokenSimilarity).toBeGreaterThan(0);
      expect(report.evaluations.length).toBe(2);
    });

    it('should throw when fixtures and results length mismatch', () => {
      expect(() => BenchmarkEvaluator.evaluateDataset([pythonFixture], [])).toThrow();
    });
  });

  describe('Metric calculations', () => {
    it('should compute key symbol preservation ratio correctly', () => {
      const prompt = 'def calculate_total(price: float, tax: float) -> float:';
      const emitted = 'def calculate_total(price: float, tax: float) -> float:';
      const ratio = computeKeySymbolPreservation(prompt, emitted, 'python');
      expect(ratio).toBe(1.0);

      const elidedEmitted = 'def calculate_total(price: float) -> float:';
      const lowerRatio = computeKeySymbolPreservation(prompt, elidedEmitted, 'python');
      expect(lowerRatio).toBeLessThan(1.0);
    });

    it('should correctly evaluate symbol "user" against "def process(username_val):" to 0 (word-boundary check)', () => {
      const ratio = computeKeySymbolPreservation('user', 'def process(username_val):', 'python');
      expect(ratio).toBe(0);
    });

    it('should compute token similarity (Jaccard index)', () => {
      const textA = 'function parseInput(data: string) { return data; }';
      const textB = 'function parseInput(data: string) { return data; }';
      expect(computeTokenSimilarity(textA, textB)).toBe(1.0);

      const textC = 'const x = 42;';
      const similarity = computeTokenSimilarity(textA, textC);
      expect(similarity).toBeGreaterThanOrEqual(0);
      expect(similarity).toBeLessThan(1.0);
    });
  });
});
