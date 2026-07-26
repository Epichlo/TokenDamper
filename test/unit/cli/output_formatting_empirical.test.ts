import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderTerminalDiff } from '../../../src/cli/diff-renderer';
import { generateHtmlReport } from '../../../src/cli/html-reporter';
import { createUnifiedDiff, runDeltaCompressionStage } from '../../../src/stages/compression/delta-compression';
import { computeLineDiff } from '../../../src/core/utils/myers-diff';
import {
  createContextBundle,
  createContextItem,
  createOptimizationBudget,
  createOptimizationResult,
  freeze,
  hashContent,
} from '../../../src/core/model/constructors';
import type { ContextBundle } from '../../../src/core/model/types';

describe('Empirical Verification: Visual Diff & Output Formatting', () => {
  // --------------------------------------------------------------------------
  // 1. Terminal Visual Diff (diff-renderer.ts)
  // --------------------------------------------------------------------------
  describe('Terminal Visual Diff (renderTerminalDiff)', () => {
    const beforeText = [
      '// Line 1: Header',
      '// Line 2: Setup',
      'const a = 1;',
      'const b = 2;',
      'const c = 3;',
      'TD_PRESERVE:CRITICAL_CONFIG',
      'const d = 4;',
      'const e = 5;',
      'const f = 6;',
      '// Line 10: Footer',
    ].join('\n');

    const afterText = [
      '// Line 1: Header',
      '// Line 2: Setup',
      'const a = 1;',
      'const b = 99;', // modification
      'const c = 3;',
      'TD_PRESERVE:CRITICAL_CONFIG',
      '<BLOCK_HASH:abc123def4567890abc123def4567890abc123def4567890abc123def4567890>',
      'const e = 5;',
      'const f = 6;',
      '// Line 10: Footer',
    ].join('\n');

    it('renders unified diff correctly without ANSI colors when color=false', () => {
      const result = renderTerminalDiff(beforeText, afterText, { color: false, mode: 'unified' });

      expect(result).toContain('TokenDamper Optimization Visual Diff');
      expect(result).toContain('============================================================');
      expect(result).not.toContain('\x1b[');

      // Verify diff headers and line prefixes
      expect(result).toContain('@@ -1,10 +1,10 @@');
      expect(result).toContain('- const b = 2;');
      expect(result).toContain('+ const b = 99;');
      expect(result).toContain('- const d = 4;');
      expect(result).toContain('+ <BLOCK_HASH:abc123def4567890abc123def4567890abc123def4567890abc123def4567890>');
    });

    it('renders unified diff with correct ANSI colors and token highlighting when color=true', () => {
      const result = renderTerminalDiff(beforeText, afterText, { color: true, mode: 'unified' });

      expect(result).toContain('\x1b[1;36m============================================================\x1b[0m');
      expect(result).toContain('\x1b[36m@@ -1,10 +1,10 @@\x1b[0m');
      // Red for delete
      expect(result).toContain('\x1b[31m- const b = 2;\x1b[0m');
      // Green for add
      expect(result).toContain('\x1b[32m+ const b = 99;\x1b[0m');
      // Special highlighting for BLOCK_HASH (Yellow bold: \x1b[1;93m)
      expect(result).toContain('\x1b[1;93m<BLOCK_HASH:abc123def4567890abc123def4567890abc123def4567890abc123def4567890>\x1b[0m');
      // Special highlighting for TD_PRESERVE (Magenta bold: \x1b[1;95m✓ )
      expect(result).toContain('\x1b[1;95m✓ TD_PRESERVE:CRITICAL_CONFIG\x1b[0m');
    });

    it('renders side-by-side diff with column alignment', () => {
      const plainResult = renderTerminalDiff(beforeText, afterText, { color: false, mode: 'side-by-side' });

      expect(plainResult).toContain('BEFORE (Original)                             | AFTER (Optimized)');
      expect(plainResult).toContain('------------------------------------------------------------------------------------------');
      expect(plainResult).not.toContain('\x1b[');

      const colorResult = renderTerminalDiff(beforeText, afterText, { color: true, mode: 'side-by-side' });
      expect(colorResult).toContain('\x1b[1;33mBEFORE (Original)                            \x1b[0m | \x1b[1;32mAFTER (Optimized)\x1b[0m');
    });

    it('handles identical inputs by returning "No differences found"', () => {
      const text = 'line 1\nline 2\nline 3';
      const plain = renderTerminalDiff(text, text, { color: false });
      expect(plain).toContain('No differences found between context bundles.');

      const color = renderTerminalDiff(text, text, { color: true });
      expect(color).toContain('\x1b[2mNo differences found between context bundles.\x1b[0m');
    });

    it('accepts ContextBundle instances seamlessly', () => {
      const bundle1 = createContextBundle('const x = 1;', 'file', 'file1.ts');
      const bundle2 = createContextBundle('const x = 2;', 'file', 'file1.ts');

      const diff = renderTerminalDiff(bundle1, bundle2, { color: false });
      expect(diff).toContain('- const x = 1;');
      expect(diff).toContain('+ const x = 2;');
    });
  });

  // --------------------------------------------------------------------------
  // 2. HTML Report Rendering & CSS Styling (html-reporter.ts)
  // --------------------------------------------------------------------------
  describe('HTML Report Rendering (generateHtmlReport)', () => {
    const beforeBundle = createContextBundle(
      '// System prompt\nfunction main() {\n  console.log("hello");\n  TD_PRESERVE:MUST_KEEP\n  return 0;\n}',
      'file',
      'src/index.ts'
    );

    const afterBundle = createContextBundle(
      '// System prompt\nfunction main() {\n  [TokenDamper Elided 2 Lines]\n  ✓ TD_PRESERVE:MUST_KEEP\n  return 0;\n}',
      'file',
      'src/index.ts'
    );

    const result = createOptimizationResult({
      finalBundle: afterBundle,
      emittedOutput: afterBundle.items.map((i) => i.content).join('\n'),
      stageResults: [],
      trace: {
        requestId: 'req-1',
        bundleId: 'b-1',
        bundleContentHash: 'h-1',
        planMode: 'pass_through',
        stageCount: 1,
        stageTraces: [],
        inputTokenEstimate: 50,
        outputTokenEstimate: 30,
        tokenBefore: 50,
        tokenAfter: 30,
        bundleStatistics: afterBundle.statistics,
        fallbackUsed: false,
        debtScore: 25.0,
        driftScore: 0.15,
      },
      validation: {
        passed: true,
        confidence: 0.9,
        issues: [],
        shouldFallback: false,
        driftReport: {
          driftScore: 0.15,
          astSymbolRetentionRatio: 1.0,
          structuralIntegrityRatio: 1.0,
          symbolsBeforeCount: 5,
          symbolsAfterCount: 5,
          markersBeforeCount: 5,
          markersAfterCount: 5,
          shouldFallback: false,
        },
      },
      fallbackUsed: false,
    } as any);

    it('generates a valid HTML document with correct CSS classes and structure', () => {
      const html = generateHtmlReport(result, beforeBundle, { title: 'Custom Test Report' });

      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<title>Custom Test Report</title>');

      // Verify dark mode theme root CSS variables
      expect(html).toContain('--bg-color: #1e1e2e;');
      expect(html).toContain('--card-bg: #181825;');
      expect(html).toContain('--added-bg: #1e3a29;');
      expect(html).toContain('--deleted-bg: #3a1e28;');

      // Verify SVG gauges for D_k and S_k
      expect(html).toContain('<svg width="90" height="90" viewBox="0 0 90 90">');
      expect(html).toContain('Optimization Debt (D_k)');
      expect(html).toContain('Semantic Drift (S_k)');

      // Verify diff table rows and CSS classes
      expect(html).toContain('<table class="diff-table">');
      expect(html).toContain('<tr class="deleted">');
      expect(html).toContain('<tr class="added">');
      expect(html).toContain('<tr class="keep">');
      expect(html).toContain('class="line-no"');

      // Verify HTML tokens highlighting
      expect(html).toContain('<span class="token-elided">[TokenDamper Elided 2 Lines]</span>');
      expect(html).toContain('<span class="token-directive">✓ TD_PRESERVE:MUST_KEEP</span>');
    });

    it('properly escapes HTML special characters in code content to prevent XSS / formatting corruption', () => {
      const unsafeBefore = createContextBundle('if (a < b && c > d) { return "<h1>unsafe</h1>"; }', 'file', 'x.ts');
      const unsafeAfter = createContextBundle('if (a < b && c > d) { return "<h2>safe</h2>"; }', 'file', 'x.ts');

      const unsafeResult = createOptimizationResult({
        finalBundle: unsafeAfter,
        emittedOutput: unsafeAfter.items.map((i) => i.content).join('\n'),
        stageResults: [],
        trace: {
          requestId: 'req-2',
          bundleId: 'b-2',
          bundleContentHash: 'h-2',
          planMode: 'pass_through',
          stageCount: 0,
          stageTraces: [],
          inputTokenEstimate: 20,
          outputTokenEstimate: 20,
          tokenBefore: 20,
          tokenAfter: 20,
          bundleStatistics: unsafeAfter.statistics,
          fallbackUsed: false,
        },
        validation: { passed: true, confidence: 1.0, issues: [], shouldFallback: false },
        fallbackUsed: false,
      } as any);

      const html = generateHtmlReport(unsafeResult, unsafeBefore);

      expect(html).toContain('&lt;h1&gt;unsafe&lt;/h1&gt;');
      expect(html).toContain('&lt;h2&gt;safe&lt;/h2&gt;');
      expect(html).not.toContain('<h1>unsafe</h1>');
    });

    it('writes report file to disk when outputPath option is specified', () => {
      const tempPath = join(tmpdir(), `tokendamper_test_report_${Date.now()}.html`);

      try {
        const html = generateHtmlReport(result, beforeBundle, { outputPath: tempPath });
        expect(existsSync(tempPath)).toBe(true);

        const fileContent = readFileSync(tempPath, 'utf8');
        expect(fileContent).toBe(html);
      } finally {
        if (existsSync(tempPath)) {
          unlinkSync(tempPath);
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // 3. Context-Window Hunking & Delta Compression (delta-compression.ts)
  // --------------------------------------------------------------------------
  describe('Context-Window Hunking & Delta Compression', () => {
    it('createUnifiedDiff outputs 3-line before/after padding context hunks', () => {
      const linesOld = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`);
      const linesNew = [...linesOld];
      linesNew[10] = 'Line 11 MODIFIED';

      const oldText = linesOld.join('\n');
      const newText = linesNew.join('\n');

      const diff = createUnifiedDiff(oldText, newText, 'file.txt', 'file.txt', 3);

      expect(diff).toContain('--- file.txt');
      expect(diff).toContain('+++ file.txt');
      expect(diff).toContain('@@ -8,7 +8,7 @@');

      // Verify exact 3 lines before: Line 8, Line 9, Line 10
      expect(diff).toContain(' Line 8');
      expect(diff).toContain(' Line 9');
      expect(diff).toContain(' Line 10');
      expect(diff).toContain('-Line 11');
      expect(diff).toContain('+Line 11 MODIFIED');
      // Verify exact 3 lines after: Line 12, Line 13, Line 14
      expect(diff).toContain(' Line 12');
      expect(diff).toContain(' Line 13');
      expect(diff).toContain(' Line 14');
      expect(diff).not.toContain(' Line 15');
    });

    it('merges close changes into a single hunk when gap <= 2 * contextSize', () => {
      const linesOld = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`);
      const linesNew = [...linesOld];
      linesNew[5] = 'Line 6 MOD 1';
      linesNew[9] = 'Line 10 MOD 2'; // gap of 3 lines (7, 8, 9)

      const diff = createUnifiedDiff(linesOld.join('\n'), linesNew.join('\n'), 'file.txt', 'file.txt', 3);

      // Should form 1 unified hunk header @@ -3,11 +3,11 @@ instead of 2 separate hunks
      const hunkHeaderMatches = diff.match(/@@ -\d+,\d+ \+\d+,\d+ @@/g);
      expect(hunkHeaderMatches).toHaveLength(1);
    });

    it('runDeltaCompressionStage produces valid delta compressed bundle and statistics', () => {
      const baseLines = Array.from({ length: 30 }, (_, i) => `export const val_${i} = ${i};`);
      const newLines = [...baseLines];
      newLines[15] = 'export const val_15 = 999999;';

      const baseText = baseLines.join('\n');
      const newText = newLines.join('\n');
      const baseHash = hashContent(baseText);

      const item = createContextItem({
        id: 'item-1',
        kind: 'file',
        path: 'src/config.ts',
        contentType: 'code',
        content: newText,
        origin: 'src/config.ts',
      });

      const bundle: ContextBundle = freeze({
        id: 'bundle-test',
        bundleId: 'bundle-test',
        source: 'file',
        items: freeze([item]),
        summary: freeze({ itemCount: 1, tokenEstimate: 100, preview: newText }),
        statistics: freeze({
          itemCount: 1,
          contentTypeCounts: freeze({ text: 0, markdown: 0, code: 1, html: 0, json: 0, yaml: 0, logs: 0, unknown: 0 }),
          kindCounts: freeze({ prompt: 0, file: 1, diff: 0, conversation: 0, note: 0 }),
          totalCharacters: newText.length,
        }),
        contentHash: 'bundle-test',
      });
      const budget = createOptimizationBudget({ riskTolerance: 'medium' });

      const stageResult = runDeltaCompressionStage(bundle, budget, {
        baseVersions: new Map([['src/config.ts', baseText]]),
      });

      expect(stageResult.changed).toBe(true);
      expect(stageResult.metrics.itemsCompressed).toBe(1);
      expect(stageResult.metrics.bytesSaved).toBeGreaterThan(0);

      const compressedItem = stageResult.bundle.items[0]!;
      expect(compressedItem.metadata.deltaCompressed).toBe(true);
      expect(compressedItem.metadata.elided).toBe(true);
      expect(compressedItem.metadata.baseContentHash).toBe(baseHash);
      expect(compressedItem.content).toContain('[TokenDamper Delta: path=src/config.ts');
      expect(compressedItem.content).toContain('-export const val_15 = 15;');
      expect(compressedItem.content).toContain('+export const val_15 = 999999;');
    });
  });
});
