import { spawnSync } from 'node:child_process';
import { createContextItem } from '../core/model/constructors';
import type { OptimizationResult } from '../core/model/types';
import { validateItemAst } from '../core/validation/ast';
import type { BenchmarkFixture } from './fixtures/types';
import type { DatasetQualityReport, QualityEvaluationResult } from './types';

/**
 * Common code keywords ignored during key symbol extraction.
 */
const KEYWORD_SET = new Set([
  'def', 'class', 'import', 'from', 'return', 'function', 'export', 'const',
  'let', 'var', 'if', 'else', 'for', 'while', 'in', 'and', 'or', 'not',
  'true', 'false', 'none', 'null', 'undefined', 'type', 'interface', 'public',
  'private', 'protected', 'async', 'await', 'str', 'int', 'float', 'bool',
  'list', 'dict', 'set', 'tuple', 'any', 'string', 'number', 'boolean', 'void',
]);

const PYTHON_CHECK_TIMEOUT_MS = 3000;

export interface PythonCheckResult {
  readonly attempted: boolean;
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly note: string;
}

export class BenchmarkEvaluator {
  /**
   * Evaluates completion quality and AST syntax validity on optimized vs raw unoptimized context for a fixture.
   */
  public static evaluateFixture(
    fixture: BenchmarkFixture,
    result: OptimizationResult,
  ): QualityEvaluationResult {
    const rawFullCode = `${fixture.prompt}\n${fixture.referenceCompletion}`;
    const optimizedFullCode = `${result.emittedOutput}\n${fixture.referenceCompletion}`;

    const rawItem = createContextItem({
      id: `raw-${fixture.id}`,
      kind: 'file',
      contentType: 'code',
      content: rawFullCode,
      origin: fixture.path,
      language: fixture.language,
    });

    const optimizedItem = createContextItem({
      id: `opt-${fixture.id}`,
      kind: 'file',
      contentType: 'code',
      content: optimizedFullCode,
      origin: fixture.path,
      language: fixture.language,
    });

    const rawAstResult = validateItemAst(rawItem);
    const optAstResult = validateItemAst(optimizedItem);

    const keySymbolPreservationRatio = computeKeySymbolPreservation(
      fixture.prompt,
      result.emittedOutput,
      fixture.language,
    );

    const tokenSimilarityScore = computeTokenSimilarity(
      fixture.prompt,
      result.emittedOutput,
    );

    const syntaxPreserved = !rawAstResult.valid || optAstResult.valid;
    const structuralPassed = syntaxPreserved && keySymbolPreservationRatio >= 0.7;
    const canExecutePython = fixture.language === 'python' && typeof fixture.testCode === 'string' && fixture.testCode.trim().length > 0;

    const rawExecution = canExecutePython
      ? executePythonCheck(rawFullCode, fixture.testCode!, fixture.entryPoint)
      : createStructuralFallbackResult('Python execution skipped: fixture has no Python testCode.');
    const optimizedExecution = canExecutePython
      ? executePythonCheck(optimizedFullCode, fixture.testCode!, fixture.entryPoint)
      : createStructuralFallbackResult('Python execution skipped: fixture has no Python testCode.');
    const executionMode = rawExecution.attempted && optimizedExecution.attempted ? 'python-subprocess' : 'structural-fallback';
    const executionPassed = executionMode === 'python-subprocess' && optimizedExecution.passed;
    const executionNote =
      executionMode === 'python-subprocess'
        ? `Python subprocess check completed: raw=${rawExecution.passed ? 'pass' : 'fail'}, optimized=${optimizedExecution.passed ? 'pass' : 'fail'}.`
        : `Structural fallback used: ${optimizedExecution.note}`;
    const overallPassed = executionMode === 'python-subprocess' ? executionPassed : structuralPassed;

    return Object.freeze({
      fixtureId: fixture.id,
      rawSyntaxValid: rawAstResult.valid,
      optimizedSyntaxValid: optAstResult.valid,
      syntaxPreserved,
      rawAstIssues: Object.freeze(rawAstResult.issues),
      optimizedAstIssues: Object.freeze(optAstResult.issues),
      keySymbolPreservationRatio,
      tokenSimilarityScore,
      rawExecutionPassed: rawExecution.passed,
      optimizedExecutionPassed: optimizedExecution.passed,
      executionPassed,
      executionMode,
      executionNote,
      overallPassed,
    });
  }

  /**
   * Evaluates a full dataset batch of fixtures against optimization results.
   */
  public static evaluateDataset(
    fixtures: ReadonlyArray<BenchmarkFixture>,
    results: ReadonlyArray<OptimizationResult>,
  ): DatasetQualityReport {
    if (fixtures.length !== results.length) {
      throw new Error(`Dataset evaluation size mismatch: ${fixtures.length} fixtures vs ${results.length} results.`);
    }

    const evaluations: QualityEvaluationResult[] = [];
    let rawValidCount = 0;
    let optValidCount = 0;
    let sumSymbolRatio = 0;
    let sumSimilarity = 0;

    for (let i = 0; i < fixtures.length; i++) {
      const evalResult = BenchmarkEvaluator.evaluateFixture(fixtures[i]!, results[i]!);
      evaluations.push(evalResult);


      if (evalResult.executionMode === 'python-subprocess' ? evalResult.rawExecutionPassed : evalResult.rawSyntaxValid) rawValidCount++;
      if (evalResult.overallPassed) optValidCount++;
      sumSymbolRatio += evalResult.keySymbolPreservationRatio;
      sumSimilarity += evalResult.tokenSimilarityScore;
    }

    const totalItems = fixtures.length;
    const rawPassRate = totalItems > 0 ? rawValidCount / totalItems : 0;
    const optimizedPassRate = totalItems > 0 ? optValidCount / totalItems : 0;
    const passRateDelta = optimizedPassRate - rawPassRate;
    const avgKeySymbolPreservation = totalItems > 0 ? sumSymbolRatio / totalItems : 0;
    const avgTokenSimilarity = totalItems > 0 ? sumSimilarity / totalItems : 0;

    return Object.freeze({
      totalItems,
      rawPassRate,
      optimizedPassRate,
      passRateDelta,
      avgKeySymbolPreservation,
      avgTokenSimilarity,
      evaluations: Object.freeze(evaluations),
    });
  }
}

/**
 * Executes generated Python code plus dataset check code in a child process.
 */
export function executePythonCheck(code: string, testCode: string, entryPoint?: string): PythonCheckResult {
  if (process.env.TOKENDAMPER_BENCH_DISABLE_PYTHON === 'true') {
    return createStructuralFallbackResult('Python execution disabled by TOKENDAMPER_BENCH_DISABLE_PYTHON=true.');
  }

  const script = buildPythonCheckScript(code, testCode, entryPoint);
  const candidates = getPythonCommandCandidates(script);
  let unavailableNotes: string[] = [];

  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, candidate.args, {
      encoding: 'utf8',
      timeout: PYTHON_CHECK_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });

    if (result.error && isCommandUnavailableError(result.error)) {
      unavailableNotes.push(`${candidate.command}: ${result.error.message}`);
      continue;
    }

    const timedOut = result.error?.name === 'Error' && /timed out/i.test(result.error.message);
    const status = typeof result.status === 'number' ? result.status : null;
    const stderr = normalizeProcessOutput(result.stderr);
    const stdout = normalizeProcessOutput(result.stdout);

    return Object.freeze({
      attempted: true,
      passed: status === 0 && !timedOut && !/AssertionError/.test(stderr),
      exitCode: status,
      timedOut,
      stdout,
      stderr,
      note: timedOut
        ? `Python subprocess timed out after ${PYTHON_CHECK_TIMEOUT_MS}ms.`
        : `Python subprocess exited with code ${status ?? 'unknown'}.`,
    });
  }

  return createStructuralFallbackResult(
    `Python interpreter unavailable; structural/AST fallback used. ${unavailableNotes.join(' | ')}`.trim(),
  );
}

/**
 * Computes the ratio of key code symbols (identifiers, parameter names) from the prompt preserved in emitted output.
 */
export function computeKeySymbolPreservation(
  prompt: string,
  emittedOutput: string,
  _language?: string,
): number {
  const promptSymbols = extractKeySymbols(prompt);
  if (promptSymbols.length === 0) {
    return 1.0;
  }

  let preservedCount = 0;
  for (const sym of promptSymbols) {
    if (new RegExp('\\b' + sym.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\b').test(emittedOutput)) {
      preservedCount++;
    }
  }

  return preservedCount / promptSymbols.length;
}

/**
 * Computes Jaccard token similarity (intersection over union) between raw prompt and emitted context.
 */
export function computeTokenSimilarity(prompt: string, emittedOutput: string): number {
  const promptTokens = new Set(tokenizeText(prompt));
  const emittedTokens = new Set(tokenizeText(emittedOutput));

  if (promptTokens.size === 0 && emittedTokens.size === 0) {
    return 1.0;
  }

  let intersectionSize = 0;
  for (const token of promptTokens) {
    if (emittedTokens.has(token)) {
      intersectionSize++;
    }
  }

  const unionSize = new Set([...promptTokens, ...emittedTokens]).size;
  return unionSize > 0 ? intersectionSize / unionSize : 1.0;
}

function buildPythonCheckScript(code: string, testCode: string, entryPoint?: string): string {
  const invocation = entryPoint && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entryPoint)
    ? `\ncheck(${entryPoint})\n`
    : '';

  return [
    'import math',
    'import re',
    'import sys',
    'from typing import *',
    '',
    code,
    '',
    testCode,
    invocation,
  ].join('\n');
}

function getPythonCommandCandidates(script: string): ReadonlyArray<{ readonly command: string; readonly args: ReadonlyArray<string> }> {
  if (process.platform === 'win32') {
    return Object.freeze([
      { command: 'python', args: Object.freeze(['-c', script]) },
      { command: 'py', args: Object.freeze(['-3', '-c', script]) },
      { command: 'python3', args: Object.freeze(['-c', script]) },
    ]);
  }

  return Object.freeze([
    { command: 'python3', args: Object.freeze(['-c', script]) },
    { command: 'python', args: Object.freeze(['-c', script]) },
  ]);
}

function createStructuralFallbackResult(note: string): PythonCheckResult {
  return Object.freeze({
    attempted: false,
    passed: false,
    exitCode: null,
    timedOut: false,
    stdout: '',
    stderr: '',
    note,
  });
}

function isCommandUnavailableError(error: Error): boolean {
  return 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function normalizeProcessOutput(output: string | Buffer | null | undefined): string {
  if (output === null || output === undefined) {
    return '';
  }
  return typeof output === 'string' ? output : output.toString('utf8');
}

function extractKeySymbols(text: string): string[] {
  const matches = text.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g);
  if (!matches) {
    return [];
  }

  const unique = new Set<string>();
  for (const word of matches) {
    if (word.length >= 2 && !KEYWORD_SET.has(word.toLowerCase())) {
      unique.add(word);
    }
  }

  return Array.from(unique);
}

function tokenizeText(text: string): string[] {
  const words = text.toLowerCase().match(/\b\w+\b/g);
  return words ? Array.from(new Set(words)) : [];
}
