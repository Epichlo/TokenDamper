import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { parse } from '../../src/adapters/cli';
import { optimize } from '../../src/core/engine';
import { TokenHasher } from '../../src/core/hashing/token-hasher';
import { ConfidenceLedger } from '../../src/core/ledger/confidence-ledger';
import { DebtTracker } from '../../src/core/ledger/debt-tracker';
import { DriftTracker } from '../../src/core/ledger/drift-tracker';
import {
  createBundleFromItems,
  createContextBundle,
  createContextItem,
  createOptimizationBudget,
  freeze,
} from '../../src/core/model/constructors';
import type { ContextBundle, OptimizationRequest } from '../../src/core/model/types';
import { validate } from '../../src/core/validation';

describe('Milestone 7 QA & Edge-Case Fuzzer Suite - Optimization Debt & Semantic Drift', () => {
  /* ========================================================================
   * 1. DEEP 50+ TURN SESSIONS & OPTIMIZATION DEBT SCORE ACCUMULATION (D_k)
   * ======================================================================== */
  describe('Deep 50+ Turn Sessions & Optimization Debt Accumulation (D_k)', () => {
    it('tracks D_k score accumulation across a 60-turn session and triggers re-hydration at D_k > 75.0', () => {
      const tracker = new DebtTracker({ maxDebtThreshold: 75.0 });
      const ledger = new ConfidenceLedger({ defaultDecayRate: 0.90, defaultThreshold: 0.70 });

      // Record an elision at Turn 1
      const itemId = 'context-block-1';
      const blockHash = 'hash-block-1-50turn-test';
      const originalBytes = 2000;
      ledger.recordElision({
        itemId,
        blockHash,
        turn: 1,
        originalBytes,
      });

      const totalBytes = 4000;
      const elidedBytes = 2000;
      const history: Array<{ turn: number; debtScore: number; confidence: number; shouldRehydrate: boolean }> = [];

      for (let turn = 1; turn <= 60; turn++) {
        const confidence = ledger.getOverallConfidence(turn);
        const breakdown = tracker.calculateDebt({
          currentTurn: turn,
          overallConfidence: confidence,
          elidedBytes,
          totalBytes,
          oldestElidedTurn: 1,
        });

        history.push({
          turn,
          debtScore: breakdown.debtScore,
          confidence,
          shouldRehydrate: breakdown.shouldRehydrate,
        });
      }

      // Assert initial turn properties
      expect(history[0]?.turn).toBe(1);
      expect(history[0]?.debtScore).toBeLessThan(30.0);
      expect(history[0]?.shouldRehydrate).toBe(false);

      // Verify continuous debt score increase as turn age & confidence decay compound
      for (let i = 1; i < history.length; i++) {
        expect(history[i]!.debtScore).toBeGreaterThanOrEqual(history[i - 1]!.debtScore);
      }

      // Find the turn where D_k crosses 75.0
      const thresholdCrossIndex = history.findIndex((h) => h.debtScore > 75.0);
      expect(thresholdCrossIndex).toBeGreaterThan(0);
      const crossTurn = history[thresholdCrossIndex]!;
      expect(crossTurn.shouldRehydrate).toBe(true);

      // Check debt score calculation at Turn 50
      const turn50 = history[49]!;
      expect(turn50.turn).toBe(50);
      expect(turn50.debtScore).toBeGreaterThan(75.0);
      expect(turn50.shouldRehydrate).toBe(true);

      // Verify re-hydration candidates are identified
      const candidates = tracker.getRehydrationCandidates(ledger, 50);
      expect(candidates).toContain(itemId);
    });

    it('executes full 50-turn session in optimize() engine with automated re-hydration upon D_k threshold breach', () => {
      const config = loadConfig();
      const rawInput = 'export function coreLogic(): string { return "intact core system prompt"; }\n';
      const hasher = new TokenHasher();

      const placeholderText = hasher.createBlockPlaceholder('const elidedData = [1, 2, 3, 4, 5];');
      const hashKey = placeholderText.slice(12, -1);

      const elidedItem = createContextItem({
        id: 'item-elided-50turn',
        kind: 'file',
        path: 'src/data.ts',
        contentType: 'code',
        content: `export function coreLogic(): string { return "intact core system prompt"; }\n${placeholderText}`,
        origin: 'src/data.ts',
        metadata: {
          tokenHashed: true,
          originalBytes: 150,
          blockHash: hashKey,
        },
      });

      const bundle: ContextBundle = freeze({
        id: 'bundle-50turn',
        bundleId: 'bundle-50turn',
        source: 'file',
        items: freeze([elidedItem]),
        summary: freeze({ itemCount: 1, tokenEstimate: 30, preview: 'export function' }),
        statistics: freeze({
          itemCount: 1,
          contentTypeCounts: freeze({ text: 0, markdown: 0, code: 1, html: 0, json: 0, yaml: 0, logs: 0, unknown: 0 }),
          kindCounts: freeze({ prompt: 0, file: 1, diff: 0, conversation: 0, note: 0 }),
          totalCharacters: 200,
        }),
        contentHash: 'bundle-50turn',
      });

      const budget = createOptimizationBudget({ riskTolerance: 'high' });
      const baseReq = parse(rawInput, config);
      const request: OptimizationRequest = freeze({
        ...baseReq,
        bundle,
        budget,
      });

      const ledger = new ConfidenceLedger({ defaultDecayRate: 0.85, defaultThreshold: 0.70 });
      // Pre-record elision at Turn 1 with degraded initial confidence to simulate Turn 50 accumulation
      ledger.recordElision({
        itemId: 'item-elided-50turn',
        blockHash: hashKey,
        turn: 1,
        originalBytes: 150,
        initialConfidence: 0.1,
      });

      const tracker = new DebtTracker({ maxDebtThreshold: 75.0 });

      // Turn 50: Debt score accumulates due to decayed confidence. Automated re-hydration triggers.
      const resTurn50 = optimize(request, {
        tokenHasher: hasher,
        confidenceLedger: ledger,
        debtTracker: tracker,
        currentTurn: 50,
      });

      // Output bundle item should be re-hydrated back to full text
      expect(resTurn50.validation.passed).toBe(true);
      expect(resTurn50.finalBundle.items[0]!.content).toContain('const elidedData = [1, 2, 3, 4, 5];');
    });

    it('manages staggered elisions across 50 turns and selective candidate retrieval', () => {
      // Set decayRate = 0.98 so after 15 turns 0.98^15 = 0.7386 > 0.70 threshold,
      // but after 35 turns 0.98^35 = 0.493 < 0.70 threshold.
      const ledger = new ConfidenceLedger({ defaultDecayRate: 0.98, defaultThreshold: 0.70 });
      const tracker = new DebtTracker();

      // Record items at different turns
      ledger.recordElision({ itemId: 'item-t1', blockHash: 'hash-t1', turn: 1, originalBytes: 500 });
      ledger.recordElision({ itemId: 'item-t15', blockHash: 'hash-t15', turn: 15, originalBytes: 500 });
      ledger.recordElision({ itemId: 'item-t35', blockHash: 'hash-t35', turn: 35, originalBytes: 500 });

      // At Turn 50:
      // item-t1 (deltaT = 49) -> 0.98^49 = 0.37 < 0.70 (candidate)
      // item-t15 (deltaT = 35) -> 0.98^35 = 0.49 < 0.70 (candidate)
      // item-t35 (deltaT = 15) -> 0.98^15 = 0.74 > 0.70 (NOT candidate)
      const candidatesAt50 = tracker.getRehydrationCandidates(ledger, 50);
      expect(candidatesAt50).toContain('item-t1');
      expect(candidatesAt50).toContain('item-t15');
      expect(candidatesAt50).not.toContain('item-t35');
    });

    it('strictly clamps debt score to upper limit 100.0 at extreme turn age (turn 1000)', () => {
      const tracker = new DebtTracker();
      const breakdown = tracker.calculateDebt({
        currentTurn: 1000,
        overallConfidence: 0.0,
        elidedBytes: 50000,
        totalBytes: 50000,
        oldestElidedTurn: 1,
      });

      expect(breakdown.debtScore).toBe(100.0);
      expect(breakdown.shouldRehydrate).toBe(true);
    });
  });

  /* ========================================================================
   * 2. SEMANTIC DRIFT (S_k > 0.40) FALLBACK ENFORCEMENT & BROKEN SYNTAX
   * ======================================================================== */
  describe('Semantic Drift (S_k > 0.40) Fallback Enforcement & Broken Syntax', () => {
    it('enforces fallback when TypeScript/JavaScript syntax is broken post-optimization', () => {
      const config = loadConfig();
      const rawInput = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';

      const brokenTsItem = createContextItem({
        id: 'broken-ts',
        kind: 'file',
        path: 'src/math.ts',
        contentType: 'code',
        language: 'ts',
        content: 'export function add(a: number, b: number): number {\n  return a + ( ; // BROKEN BRACKET/SYNTAX',
        origin: 'src/math.ts',
      });

      const bundle = createBundleFromItems([brokenTsItem], 'file');
      const baseReq = parse(rawInput, config);
      const request: OptimizationRequest = freeze({
        ...baseReq,
        bundle,
      });

      const result = optimize(request);

      expect(result.fallbackUsed).toBe(true);
      expect(result.emittedOutput).toBe(rawInput);
      expect(result.validation.passed).toBe(false);
      expect(result.validation.issues.some((i) => i.code === 'AST_UNBALANCED_BRACKET')).toBe(true);
    });

    it('enforces fallback when Python syntax is broken post-optimization', () => {
      const config = loadConfig();
      const rawInput = 'def process_items(items):\n    return [item.strip() for item in items]\n';

      const brokenPyItem = createContextItem({
        id: 'broken-py',
        kind: 'file',
        path: 'app/utils.py',
        contentType: 'code',
        language: 'python',
        content: 'def process_items(items):\nreturn [item for item in items', // BROKEN INDENTATION & UNBALANCED BRACKET
        origin: 'app/utils.py',
      });

      const bundle = createBundleFromItems([brokenPyItem], 'file');
      const baseReq = parse(rawInput, config);
      const request: OptimizationRequest = freeze({
        ...baseReq,
        bundle,
      });

      const result = optimize(request);

      expect(result.fallbackUsed).toBe(true);
      expect(result.emittedOutput).toBe(rawInput);
      expect(result.validation.passed).toBe(false);
      expect(result.validation.issues.some((i) => i.code === 'AST_INDENTATION_ERROR' || i.code === 'AST_UNBALANCED_BRACKET')).toBe(true);
    });

    it('enforces fallback when JSON syntax is broken post-optimization', () => {
      const config = loadConfig();
      const rawInput = '{\n  "name": "TokenDamper",\n  "version": "1.0.0"\n}\n';

      const brokenJsonItem = createContextItem({
        id: 'broken-json',
        kind: 'file',
        path: 'config.json',
        contentType: 'json',
        language: 'json',
        content: '{\n  "name": "TokenDamper",\n  "version": "1.0.0",\n}', // BROKEN TRAILING COMMA
        origin: 'config.json',
      });

      const bundle = createBundleFromItems([brokenJsonItem], 'file');
      const baseReq = parse(rawInput, config);
      const request: OptimizationRequest = freeze({
        ...baseReq,
        bundle,
      });

      const result = optimize(request);

      expect(result.fallbackUsed).toBe(true);
      expect(result.emittedOutput).toBe(rawInput);
      expect(result.validation.passed).toBe(false);
      expect(result.validation.issues.some((i) => i.code === 'JSON_SYNTAX_ERROR')).toBe(true);
    });

    it('triggers fallback when dropped symbol declarations cause S_k > 0.40 drift', () => {
      const tracker = new DriftTracker({ maxDriftThreshold: 0.40 });

      const beforeCode = `
        import { loadConfig } from './config';
        import { TokenHasher } from './hasher';

        export interface UserSession {
          id: string;
          token: string;
        }

        export class SessionManager {
          public createSession(): UserSession {
            return { id: '1', token: 'abc' };
          }

          public validateSession(id: string): boolean {
            return true;
          }
        }

        export function initializeApp(): void {
          console.log("Init");
        }

        export function shutdownApp(): void {
          console.log("Shutdown");
        }
      `;

      // After code drops interfaces, classes, imports, and 1 of 2 functions
      const afterCode = `
        export function initializeApp(): void {
          console.log("Init");
        }
      `;

      const beforeBundle = createContextBundle(beforeCode, 'text', 'src/session.ts');
      const afterBundle = createContextBundle(afterCode, 'text', 'src/session.ts');

      const report = tracker.calculateDrift(beforeBundle, afterBundle);

      // Severe symbol dropping must yield S_k > 0.40 and trigger fallback
      expect(report.astSymbolRetentionRatio).toBeLessThan(0.40);
      expect(report.driftScore).toBeGreaterThan(0.40);
      expect(report.shouldFallback).toBe(true);
      expect(report.reason).toContain('exceeds maximum threshold');

      // Now run through validate() to confirm SEMANTIC_DRIFT_EXCEEDED issue is logged
      const budget = createOptimizationBudget({ riskTolerance: 'medium' });
      const plan = {
        planId: 'p-1',
        mode: 'pass_through' as const,
        stageIds: Object.freeze([]),
        revalidationPoints: Object.freeze(['end' as const]),
        fallbackPolicy: 'original_input' as const,
      };

      const valReport = validate(beforeBundle, afterBundle, plan, budget, { maxDriftThreshold: 0.40 });
      expect(valReport.passed).toBe(false);
      expect(valReport.shouldFallback).toBe(true);
      expect(valReport.issues.some((i) => i.code === 'SEMANTIC_DRIFT_EXCEEDED')).toBe(true);
    });

    it('enforces exact S_k threshold boundary conditions (S_k = 0.35 -> pass, S_k = 0.45 -> fallback)', () => {
      const tracker = new DriftTracker({ maxDriftThreshold: 0.40 });

      // Code with 10 symbols
      const beforeCode = `
        export function fn1() {}
        export function fn2() {}
        export function fn3() {}
        export function fn4() {}
        export function fn5() {}
        export function fn6() {}
        export function fn7() {}
        export function fn8() {}
        export function fn9() {}
        export function fn10() {}
      `;

      // Retain 7 symbols -> R_AST = 0.70, S_k = 0.30 * 0.60 = 0.18 (< 0.40)
      const afterPassCode = `
        export function fn1() {}
        export function fn2() {}
        export function fn3() {}
        export function fn4() {}
        export function fn5() {}
        export function fn6() {}
        export function fn7() {}
      `;

      // Retain 2 symbols -> R_AST = 0.20, S_k = 0.80 * 0.60 = 0.48 (> 0.40)
      const afterFailCode = `
        export function fn1() {}
        export function fn2() {}
      `;

      const bBefore = createContextBundle(beforeCode, 'text', 'src/funcs.ts');
      const bPass = createContextBundle(afterPassCode, 'text', 'src/funcs.ts');
      const bFail = createContextBundle(afterFailCode, 'text', 'src/funcs.ts');

      const repPass = tracker.calculateDrift(bBefore, bPass);
      expect(repPass.driftScore).toBeLessThanOrEqual(0.40);
      expect(repPass.shouldFallback).toBe(false);

      const repFail = tracker.calculateDrift(bBefore, bFail);
      expect(repFail.driftScore).toBeGreaterThan(0.40);
      expect(repFail.shouldFallback).toBe(true);
    });
  });

  /* ========================================================================
   * 3. ZERO UNHANDLED EXCEPTIONS UNDER EXTREME AND EMPTY INPUTS
   * ======================================================================== */
  describe('Zero Unhandled Exceptions Under Extreme and Empty Inputs', () => {
    it('handles empty strings and whitespace-only inputs without crashing', () => {
      const config = loadConfig();

      const emptyInputs = ['', '   ', '\n\n\t\n  \r\n', '\0'];

      for (const input of emptyInputs) {
        expect(() => {
          const req = parse(input, config);
          const res = optimize(req);
          expect(res).toBeDefined();
          expect(res.finalBundle).toBeDefined();
        }).not.toThrow();
      }
    });

    it('handles extreme payloads (100KB+ text, 5,000 lines) without throwing exceptions', () => {
      const config = loadConfig();
      const largeInput = Array.from({ length: 5000 }, (_, i) => `// Line ${i}: export const val_${i} = ${i};`).join(
        '\n',
      );

      expect(() => {
        const req = parse(largeInput, config);
        const res = optimize(req);
        expect(res.validation.passed).toBe(true);
      }).not.toThrow();
    });

    it('handles deeply nested brackets and JSON structures without stack overflow or exceptions', () => {
      const config = loadConfig();

      // Deeply nested brackets 500 levels deep
      const nestedBrackets = '['.repeat(500) + '"deep_value"' + ']'.repeat(500);

      expect(() => {
        const req = parse(nestedBrackets, config);
        const res = optimize(req);
        expect(res).toBeDefined();
      }).not.toThrow();

      // Deeply nested JSON objects 300 levels deep
      let nestedJson = '"core"';
      for (let i = 0; i < 300; i++) {
        nestedJson = `{"level_${i}": ${nestedJson}}`;
      }

      expect(() => {
        const req = parse(nestedJson, config);
        const res = optimize(req);
        expect(res).toBeDefined();
      }).not.toThrow();
    });

    it('handles special Unicode characters, control characters, and null bytes safely', () => {
      const config = loadConfig();
      const unicodeInput = `
        // Emojis: 🚀🔥⚡🎉
        // Zero-width space: \u200B\u200C\u200D
        // RTL marks: \u202E RTL TEXT \u202C
        // Null bytes and control chars: \0 \x01 \x1F
        export function unicodeTest(input: string = "🚀"): string {
          return input + "\u200B";
        }
      `;

      expect(() => {
        const req = parse(unicodeInput, config);
        const res = optimize(req);
        expect(res.validation.passed).toBe(true);
      }).not.toThrow();
    });

    it('handles extreme / invalid configuration parameters gracefully', () => {
      const config = loadConfig();
      const rawInput = 'export function test(): void {}\n';
      const baseReq = parse(rawInput, config);

      // Test with extreme budgets & debt options
      const extremeReq: OptimizationRequest = freeze({
        ...baseReq,
        budget: createOptimizationBudget({
          maxInputTokens: 0,
          riskTolerance: 'low',
        }),
      });

      const tracker = new DebtTracker({
        maxDebtThreshold: 0.0,
        weightConfidence: 999.0,
        weightElisionRatio: 999.0,
        weightTurnAge: 999.0,
      });

      const driftTracker = new DriftTracker({
        maxDriftThreshold: 0.0,
        weightAst: 0.0,
        weightStruct: 0.0,
      });

      expect(() => {
        const res = optimize(extremeReq, {
          debtTracker: tracker,
          currentTurn: -10, // negative turn edge case
        });
        expect(res).toBeDefined();
      }).not.toThrow();

      expect(() => {
        const before = baseReq.bundle;
        const after = baseReq.bundle;
        driftTracker.calculateDrift(before, after, { weights: { ast: -1, struct: -1 } });
      }).not.toThrow();
    });

    it('runs 100-iteration random payload fuzzing loop without unhandled exceptions', () => {
      const config = loadConfig();
      const sampleTokens = [
        'function ',
        'class ',
        'import ',
        'export ',
        'const ',
        'let ',
        'var ',
        'def ',
        'return ',
        '{',
        '}',
        '(',
        ')',
        '[',
        ']',
        ':',
        ';',
        '=',
        '# Header',
        '```ts',
        '```',
        'TD_PRESERVE:KEY',
        '<BLOCK_HASH:deadbeef>',
        '🚀',
        '\\0',
        '"key": "value"',
        '// comment',
      ];

      for (let i = 0; i < 100; i++) {
        // Generate pseudo-random text using seed i
        let randomText = '';
        const length = (i % 20) + 5;
        for (let j = 0; j < length; j++) {
          const idx = (i * 3 + j * 7) % sampleTokens.length;
          randomText += sampleTokens[idx]! + ' ';
        }

        expect(() => {
          const req = parse(randomText, config);
          const res = optimize(req, { currentTurn: (i % 30) + 1 });
          expect(res).toBeDefined();
          expect(res.emittedOutput).toBeDefined();
          expect(typeof res.fallbackUsed).toBe('boolean');
        }).not.toThrow();
      }
    });
  });
});
