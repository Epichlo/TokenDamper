import { describe, expect, it } from 'vitest';
import {
  BenchmarkEvaluator,
  computeKeySymbolPreservation,
  computeTokenSimilarity,
  executePythonCheck,
} from '../../../src/bench/evaluator';
import type { BenchmarkFixture, CodeXGLUEFixtureRaw } from '../../../src/bench/fixtures/types';
import { optimize } from '../../../src/core/engine';
import { fixtureToOptimizationRequest, loadBenchmarkFixtures } from '../../../src/bench/fixtures/loader';
import { loadCodeXGLUEFixtures } from '../../../src/bench/fixtures/codexglue';
import { classifyContent, createContextItem, createOptimizationBudget } from '../../../src/core/model/constructors';
import { selectValidator } from '../../../src/core/validation/ast';
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
    testCode: 'def check(add_one):\n    assert add_one([1, 2, 3]) == [2, 3, 4]\n',
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
      if (evalResult.executionMode === 'python-subprocess') {
        expect(evalResult.executionPassed).toBe(true);
        expect(evalResult.optimizedExecutionPassed).toBe(true);
      } else {
        expect(evalResult.executionNote).toContain('Structural fallback');
      }
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
      expect(evalResult.executionMode).toBe('structural-fallback');
      expect(evalResult.executionPassed).toBe(false);
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

  // Read this before adding to this block. Verified by reverting `evaluator.ts` and
  // re-running: **none of these three tests fail with the hardcoded `contentType: 'code'`
  // restored.** They cannot, because the relabel has no observable effect through the
  // evaluator's public surface — `QualityEvaluationResult` does not expose the tag, and
  // `selectValidator` never reads it while `language` is a required field.
  //
  // So do not read a green run here as confirmation that the relabel works. What these
  // tests pin is the surrounding contract that makes it inert, and the conditions under
  // which it would stop being inert. The evidence that the relabel itself is correct is the
  // before/after benchmark table in CHANGELOG.md, which is byte-identical.
  describe('content-type classification of evaluator items', () => {
    it('classifies every bundled bench fixture as code via its path extension', () => {
      // Pins the C1 interaction (642abcb made code detection extension-only): if a fixture
      // is ever added whose path lacks a code extension, its tag silently stops being
      // `code`. Fails for a real reason; the ten bundled fixtures all carry .py/.ts/.js.
      const { fixtures } = loadBenchmarkFixtures();
      expect(fixtures.length).toBeGreaterThan(0);

      for (const fixture of fixtures) {
        const content = `${fixture.prompt}\n${fixture.referenceCompletion}`;
        expect(classifyContent(content, 'file', fixture.path)).toBe('code');
      }
    });

    it('classifies a pathless CodeXGLUE fixture as text, not code', () => {
      // The one constructible input where the computed tag differs from the old hardcoded
      // 'code' literal. The loader synthesizes `src/item_<id>.txt` when a raw item has no
      // path, and .txt is not a code extension.
      //
      // This is not a C1 regression: pre-C1 the only content signal for `code` was a
      // triple-backtick fence, and plain source has none, so this input classified as
      // non-code before that commit too.
      const { fixtures } = loadCodeXGLUEFixtures([
        { id: 'nopath/1', repo: 'r', path: '', language: 'python', prompt: 'def add(a, b):\n    return a + b\n', completion: '\n' },
      ] as unknown as ReadonlyArray<CodeXGLUEFixtureRaw>);

      const fixture = fixtures[0]!;
      expect(fixture.path).toBe('src/item_nopath/1.txt');
      expect(classifyContent(`${fixture.prompt}\n${fixture.referenceCompletion}`, 'file', fixture.path)).toBe('text');
    });

    it('dispatches on language, which is why the tag change moves no benchmark number', () => {
      // A no-change guard, and it passes both before and after the relabel — deliberately.
      // It is not evidence the relabel took effect; it records *why* the relabel is inert,
      // so that a future change making `language` optional fails here with the reason
      // attached rather than showing up as unexplained benchmark movement.
      const content = 'def add(a, b):\n    return a + b\n';
      const withLanguage = createContextItem({
        id: 'x', kind: 'file', contentType: classifyContent(content, 'file', 'src/x.py'),
        content, origin: 'src/x.py', language: 'python',
      });
      expect(selectValidator(withLanguage)?.language).toBe('python');

      // And the standing hazard this change does NOT fix: strip `language` and the same
      // computed `code` tag selects no validator at all. Phase C set
      // `CONTENT_TYPE_VALIDATORS.code = null`, so the outcome moved from "the wrong thing
      // looked" (Python lexed as TypeScript, which is what this assertion used to pin) to
      // "nothing looked".
      //
      // The exposure is unchanged in kind. These items pass the path as `origin`, not
      // `path` — `item.path` is undefined here — so the extension arm that would otherwise
      // rescue them still never runs, and `language` remains the only thing standing
      // between a benchmark fixture and an unchecked item. What changed is that the miss
      // now shows on `trace.astCoverage` instead of arriving as a TypeScript pass.
      const withoutLanguage = createContextItem({
        id: 'x', kind: 'file', contentType: classifyContent(content, 'file', 'src/x.py'),
        content, origin: 'src/x.py',
      });
      expect(withoutLanguage.path).toBeUndefined();
      expect(selectValidator(withoutLanguage)).toBeNull();
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

  describe('executePythonCheck', () => {
    it('executes Python check() when an interpreter is available', () => {
      const result = executePythonCheck(
        'def add_one(numbers):\n    return [x + 1 for x in numbers]\n',
        'def check(add_one):\n    assert add_one([1, 2]) == [2, 3]\n',
        'add_one',
      );

      if (result.attempted) {
        expect(result.passed).toBe(true);
        expect(result.exitCode).toBe(0);
        expect(result.timedOut).toBe(false);
      } else {
        expect(result.note).toContain('structural/AST fallback');
      }
    });

    it('marks failed assertions as execution failures', () => {
      const result = executePythonCheck(
        'def add_one(numbers):\n    return numbers\n',
        'def check(add_one):\n    assert add_one([1, 2]) == [2, 3]\n',
        'add_one',
      );

      if (result.attempted) {
        expect(result.passed).toBe(false);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain('AssertionError');
      } else {
        expect(result.note).toContain('structural/AST fallback');
      }
    });
  });
});
