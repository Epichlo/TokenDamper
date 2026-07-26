import { describe, expect, it } from 'vitest';
import {
  fixtureToOptimizationRequest,
  loadBenchmarkFixtures,
  loadCodeXGLUEFixtures,
  loadHumanEvalFixtures,
} from '../../../src/bench/fixtures';
import { createOptimizationBudget } from '../../../src/core/model/constructors';
import { DEFAULT_CONFIG } from '../../../src/config/schema';
import type { CodeXGLUEFixtureRaw, HumanEvalFixtureRaw } from '../../../src/bench/fixtures/types';

describe('Benchmark Fixture Loaders & Converter', () => {
  describe('loadHumanEvalFixtures', () => {
    it('should load the default bundled HumanEval subset', () => {
      const set = loadHumanEvalFixtures();
      expect(set.datasetName).toBe('humaneval');
      expect(set.count).toBeGreaterThan(0);
      expect(set.fixtures.length).toBe(set.count);

      const first = set.fixtures[0]!;
      expect(first.id).toContain('HumanEval');
      expect(first.dataset).toBe('humaneval');
      expect(first.language).toBe('python');
      expect(first.prompt).toBeDefined();
      expect(first.referenceCompletion).toBeDefined();
      expect(first.entryPoint).toBeDefined();
    });

    it('should parse raw HumanEval array input', () => {
      const raw: HumanEvalFixtureRaw[] = [
        {
          task_id: 'HumanEval/999',
          prompt: 'def add(a: int, b: int) -> int:\n',
          canonical_solution: '    return a + b\n',
          entry_point: 'add',
          test: 'assert add(1, 2) == 3',
        },
      ];
      const set = loadHumanEvalFixtures(raw);
      expect(set.count).toBe(1);
      expect(set.fixtures[0]!.id).toBe('HumanEval/999');
      expect(set.fixtures[0]!.path).toBe('src/add.py');
    });

    it('should throw an error for invalid HumanEval raw objects', () => {
      // @ts-expect-error Testing runtime validation
      expect(() => loadHumanEvalFixtures([{ invalid: true }])).toThrow();
    });
  });

  describe('loadCodeXGLUEFixtures', () => {
    it('should load the default bundled CodeXGLUE subset', () => {
      const set = loadCodeXGLUEFixtures();
      expect(set.datasetName).toBe('codexglue');
      expect(set.count).toBeGreaterThan(0);

      const first = set.fixtures[0]!;
      expect(first.id).toContain('CodeXGLUE');
      expect(first.dataset).toBe('codexglue');
      expect(first.prompt).toBeDefined();
      expect(first.referenceCompletion).toBeDefined();
      expect(first.path).toBeDefined();
    });

    it('should parse raw CodeXGLUE array input', () => {
      const raw: CodeXGLUEFixtureRaw[] = [
        {
          id: 'CodeXGLUE/test/1',
          repo: 'test/repo',
          path: 'src/test.ts',
          prompt: 'export function hello(): string {\n',
          completion: '  return "hello";\n}',
          language: 'typescript',
        },
      ];
      const set = loadCodeXGLUEFixtures(raw);
      expect(set.count).toBe(1);
      expect(set.fixtures[0]!.language).toBe('typescript');
    });

    it('should throw an error for invalid CodeXGLUE raw objects', () => {
      // @ts-expect-error Testing runtime validation
      expect(() => loadCodeXGLUEFixtures([{ invalid: true }])).toThrow();
    });
  });

  describe('loadBenchmarkFixtures', () => {
    it('should load a combined dataset when no argument is passed', () => {
      const set = loadBenchmarkFixtures();
      expect(set.datasetName).toBe('combined');
      expect(set.count).toBeGreaterThan(0);
      expect(set.fixtures.some((f) => f.dataset === 'humaneval')).toBe(true);
      expect(set.fixtures.some((f) => f.dataset === 'codexglue')).toBe(true);
    });

    it('should load HumanEval dataset by name', () => {
      const set = loadBenchmarkFixtures('humaneval');
      expect(set.datasetName).toBe('humaneval');
      expect(set.count).toBeGreaterThan(0);
    });

    it('should load CodeXGLUE dataset by name', () => {
      const set = loadBenchmarkFixtures('codexglue');
      expect(set.datasetName).toBe('codexglue');
      expect(set.count).toBeGreaterThan(0);
    });
  });

  describe('fixtureToOptimizationRequest', () => {
    it('should convert a benchmark fixture into a valid TokenDamper OptimizationRequest', () => {
      const set = loadHumanEvalFixtures();
      const fixture = set.fixtures[0]!;
      const budget = createOptimizationBudget({
        targetReductionRatio: 0.3,
        riskTolerance: 'medium',
      });

      const req = fixtureToOptimizationRequest(fixture, budget, DEFAULT_CONFIG, 'req-custom-1');
      expect(req.requestId).toBe('req-custom-1');
      expect(req.rawInput).toBe(fixture.prompt);
      expect(req.budget.targetReductionRatio).toBe(0.3);
      expect(req.budget.riskTolerance).toBe('medium');
      expect(req.adapterName).toBe('bench');
      expect(req.bundle.items.length).toBe(1);
    });
  });
});
