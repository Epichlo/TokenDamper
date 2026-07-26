import { describe, expect, it } from 'vitest';
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
} from '../../../src/core/model/constructors';
import type { ContextBundle } from '../../../src/core/model/types';

describe('Adversarial Stress Test: Output Formatting, Visual Diffs & Hunking', () => {
  // --------------------------------------------------------------------------
  // 1. Adversarial Terminal Diff Stress Tests
  // --------------------------------------------------------------------------
  describe('Adversarial Terminal Diff', () => {
    it('handles completely empty before and after inputs', () => {
      const diff = renderTerminalDiff('', '', { color: false });
      expect(diff).toContain('TokenDamper Optimization Visual Diff');
      expect(diff).toContain('No differences found between context bundles.');
    });

    it('handles transition from empty string to multi-line string', () => {
      const diff = renderTerminalDiff('', 'line 1\nline 2', { color: false });
      expect(diff).toContain('+ line 1');
      expect(diff).toContain('+ line 2');
      expect(diff).toContain('@@ -1,1 +1,2 @@');
    });

    it('handles transition from multi-line string to empty string', () => {
      const diff = renderTerminalDiff('line 1\nline 2', '', { color: false });
      expect(diff).toContain('- line 1');
      expect(diff).toContain('- line 2');
      expect(diff).toContain('@@ -1,2 +1,1 @@');
    });

    it('truncates long lines in side-by-side mode with "..." to preserve column alignment', () => {
      const longLineBefore = 'A'.repeat(100);
      const longLineAfter = 'B'.repeat(100);

      const diff = renderTerminalDiff(longLineBefore, longLineAfter, { color: false, mode: 'side-by-side' });
      const lines = diff.split('\n');
      const dataLine = lines[5]!;

      expect(dataLine).toContain('...');
      const parts = dataLine.split('|');
      expect(parts[0]!.length).toBe(46); // 45 width + 1 space before pipe
    });

    it('handles contextLines: 0 correctly without crashing', () => {
      const before = 'l1\nl2\nl3\nl4\nl5';
      const after = 'l1\nl2\nl3 modified\nl4\nl5';

      const diff = renderTerminalDiff(before, after, { color: false, contextLines: 0 });
      expect(diff).toContain('- l3');
      expect(diff).toContain('+ l3 modified');
      expect(diff).not.toContain(' l1');
      expect(diff).not.toContain(' l5');
    });

    it('handles contextLines larger than file length', () => {
      const before = 'a\nb';
      const after = 'a\nc';

      const diff = renderTerminalDiff(before, after, { color: false, contextLines: 50 });
      expect(diff).toContain('@@ -1,2 +1,2 @@');
      expect(diff).toContain(' a');
      expect(diff).toContain('- b');
      expect(diff).toContain('+ c');
    });
  });

  // --------------------------------------------------------------------------
  // 2. Adversarial HTML Reporter Stress Tests
  // --------------------------------------------------------------------------
  describe('Adversarial HTML Reporter', () => {
    it('handles XSS injection attempts in context content, title, and metadata', () => {
      const xssBefore = createContextBundle('<script>alert("xss_before")</script>', 'file', 'xss.ts');
      const xssAfter = createContextBundle('<script>alert("xss_after")</script>', 'file', 'xss.ts');

      const xssResult = createOptimizationResult({
        finalBundle: xssAfter,
        emittedOutput: xssAfter.items.map((i) => i.content).join('\n'),
        stageResults: [],
        trace: {
          requestId: 'req-xss',
          bundleId: 'b-xss',
          bundleContentHash: 'h-xss',
          planMode: 'pass_through',
          stageCount: 0,
          stageTraces: [],
          inputTokenEstimate: 10,
          outputTokenEstimate: 10,
          tokenBefore: 10,
          tokenAfter: 10,
          bundleStatistics: xssAfter.statistics,
          fallbackUsed: false,
        },
        validation: { passed: true, confidence: 1.0, issues: [], shouldFallback: false },
        fallbackUsed: false,
      } as any);

      const html = generateHtmlReport(xssResult, xssBefore, { title: '"><script>alert(1)</script>' });

      expect(html).not.toContain('<script>alert("xss_before")</script>');
      expect(html).not.toContain('<script>alert("xss_after")</script>');
      expect(html).not.toContain('"><script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;alert(&quot;xss_before&quot;)&lt;/script&gt;');
      expect(html).toContain('&lt;script&gt;alert(&quot;xss_after&quot;)&lt;/script&gt;');
      expect(html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('handles extreme metric boundary values (0% savings, 100% debt, max drift, undefined trace metrics)', () => {
      const bundle = createContextBundle('same', 'stdin');
      const edgeResult = createOptimizationResult({
        finalBundle: bundle,
        emittedOutput: bundle.items.map((i) => i.content).join('\n'),
        stageResults: [],
        trace: {
          requestId: 'edge-1',
          bundleId: 'b-edge',
          bundleContentHash: 'h-edge',
          planMode: 'pass_through',
          stageCount: 0,
          stageTraces: [],
          inputTokenEstimate: 0,
          outputTokenEstimate: 0,
          tokenBefore: 0,
          tokenAfter: 0,
          bundleStatistics: bundle.statistics,
          fallbackUsed: true,
          debtScore: 100.0,
          driftScore: 0.99,
        },
        validation: { passed: false, confidence: 0.0, issues: [], shouldFallback: true },
        fallbackUsed: true,
      } as any);

      const html = generateHtmlReport(edgeResult, bundle);

      expect(html).toContain('FALLBACK USED');
      expect(html).toContain('HIGH');
      expect(html).toContain('HIGH DRIFT');
      expect(html).toContain('0.0% Savings');
    });
  });

  // --------------------------------------------------------------------------
  // 3. Adversarial Delta Compression & Myers Hunking Stress Tests
  // --------------------------------------------------------------------------
  describe('Adversarial Delta Compression & Myers Diff', () => {
    it('skips delta compression when delta diff output is larger than original content', () => {
      // Small 1-line file replaced by 1-line file: delta headers overhead makes delta bigger than content
      const baseContent = 'a';
      const newContent = 'b';

      const item = createContextItem({
        id: 'small-1',
        kind: 'file',
        path: 'small.txt',
        contentType: 'text',
        content: newContent,
        origin: 'small.txt',
      });

      const bundle: ContextBundle = freeze({
        id: 'bundle-small',
        bundleId: 'bundle-small',
        source: 'file',
        items: freeze([item]),
        summary: freeze({ itemCount: 1, tokenEstimate: 1, preview: newContent }),
        statistics: freeze({
          itemCount: 1,
          contentTypeCounts: freeze({ text: 1, markdown: 0, code: 0, html: 0, json: 0, yaml: 0, logs: 0, unknown: 0 }),
          kindCounts: freeze({ prompt: 0, file: 1, diff: 0, conversation: 0, note: 0 }),
          totalCharacters: newContent.length,
        }),
        contentHash: 'bundle-small',
      });

      const budget = createOptimizationBudget({ riskTolerance: 'high' });
      const result = runDeltaCompressionStage(bundle, budget, {
        baseVersions: { 'small.txt': baseContent },
      });

      // Compression skipped because deltaContent.length >= originalLength
      expect(result.changed).toBe(false);
      expect(result.bundle.items[0]?.content).toBe('b');
    });

    it('verifies computeLineDiff chronological ordering under alternating insertions and deletions', () => {
      const oldLines = ['A', 'B', 'C', 'D', 'E', 'F'];
      const newLines = ['A', 'X', 'C', 'Y', 'E', 'Z'];

      const ops = computeLineDiff(oldLines, newLines);

      // Verify that ops preserve chronological top-to-bottom line sequence
      const emitted = ops.map((op) => `${op.type}:${op.line}`);
      expect(emitted).toEqual([
        'keep:A',
        'delete:B',
        'add:X',
        'keep:C',
        'delete:D',
        'add:Y',
        'keep:E',
        'delete:F',
        'add:Z',
      ]);
    });

    it('handles Windows CRLF and Linux LF line endings consistently in createUnifiedDiff', () => {
      const crlfOld = 'line 1\r\nline 2\r\nline 3';
      const lfNew = 'line 1\nline 2 modified\nline 3';

      const diff = createUnifiedDiff(crlfOld, lfNew, 'old', 'new');

      expect(diff).toContain('-line 2');
      expect(diff).toContain('+line 2 modified');
    });
  });
});
