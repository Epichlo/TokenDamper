import { describe, expect, it } from 'vitest';
import {
  createBundleStatistics,
  createContextBundle,
  createContextItem,
  freeze,
  hashContent,
} from '../../src/core/model/constructors';
import { DriftTracker } from '../../src/core/ledger/drift-tracker';

describe('DriftTracker', () => {
  it('calculates zero semantic drift (S_k = 0.0) for identical bundles', () => {
    const tracker = new DriftTracker();
    const code = `
      import { loadConfig } from './config';

      export interface User {
        id: string;
      }

      # User Service Header

      export function getUser(id: string): User {
        return { id };
      }
    `;

    const before = createContextBundle(code, 'text', 'src/user.ts');
    const after = createContextBundle(code, 'text', 'src/user.ts');

    const report = tracker.calculateDrift(before, after);

    expect(report.driftScore).toBe(0.0);
    expect(report.astSymbolRetentionRatio).toBe(1.0);
    expect(report.structuralIntegrityRatio).toBe(1.0);
    expect(report.shouldFallback).toBe(false);
    expect(report.reason).toBeUndefined();
  });

  it('detects loss of AST symbols and computes reduced R_AST', () => {
    const tracker = new DriftTracker();
    const beforeCode = `
      export function functionOne() {}
      export function functionTwo() {}
      export class ClassAlpha {}
      export interface TypeBeta {}
    `;
    // After code drops functionTwo and ClassAlpha
    const afterCode = `
      export function functionOne() {}
      export interface TypeBeta {}
    `;

    const before = createContextBundle(beforeCode, 'text', 'src/code.ts');
    const after = createContextBundle(afterCode, 'text', 'src/code.ts');

    const report = tracker.calculateDrift(before, after);

    // 4 symbols total before: fn:functionOne, fn:functionTwo, type:ClassAlpha, type:TypeBeta
    // 2 retained: fn:functionOne, type:TypeBeta => R_AST = 2 / 4 = 0.50
    expect(report.symbolsBeforeCount).toBe(4);
    expect(report.symbolsAfterCount).toBe(2);
    expect(report.astSymbolRetentionRatio).toBeCloseTo(0.50);
  });

  it('detects loss of structural markers and computes reduced R_struct', () => {
    const tracker = new DriftTracker();
    const beforeCode = `
      # Main Header
      ## Subsection
      TD_PRESERVE:CRITICAL_LOGIC
      \`\`\`typescript
      const x = 1;
      \`\`\`
    `;
    // After code drops heading and TD_PRESERVE
    const afterCode = `
      \`\`\`typescript
      const x = 1;
      \`\`\`
    `;

    const before = createContextBundle(beforeCode, 'text', 'src/doc.md');
    const after = createContextBundle(afterCode, 'text', 'src/doc.md');

    const report = tracker.calculateDrift(before, after);

    expect(report.markersBeforeCount).toBeGreaterThan(0);
    expect(report.structuralIntegrityRatio).toBeLessThan(1.0);
  });

  it('triggers fallback when semantic drift metric S_k > 0.40 threshold', () => {
    const tracker = new DriftTracker({ maxDriftThreshold: 0.40 });
    const beforeCode = `
      # Section One
      ## Section Two
      TD_PRESERVE:DIRECTIVE_1
      export function fn1() {}
      export function fn2() {}
      export function fn3() {}
      export class Class1 {}
      export class Class2 {}
    `;
    // Extreme elision dropping almost all code and markers
    const afterCode = `
      [TokenDamper Elided]
    `;

    const before = createContextBundle(beforeCode, 'text', 'src/main.ts');
    const after = createContextBundle(afterCode, 'text', 'src/main.ts');

    const report = tracker.calculateDrift(before, after);

    expect(report.driftScore).toBeGreaterThan(0.40);
    expect(report.shouldFallback).toBe(true);
    expect(report.reason).toContain('exceeds maximum threshold');
  });

  it('exempts recoverable elisions from drift but still scores lossy ones (1.0b)', () => {
    const tracker = new DriftTracker({ maxDriftThreshold: 0.40 });
    const code = 'export function computeTotal(a, b) { const sum = a + b; return sum; }\nexport class Ledger {}';
    const marker = '[TokenDamper Elided: ref=abc123def456 bytes=91 kind=conversation]';

    const makeBundle = (content: string, metadata: Record<string, string | number | boolean | null>) => {
      const items = [
        createContextItem({
          id: 'item-1',
          kind: 'conversation',
          contentType: 'text',
          content,
          origin: 'test',
          contentHash: hashContent(content),
          metadata: freeze(metadata),
        }),
      ];
      return freeze({
        id: 'bundle',
        bundleId: 'bundle',
        source: 'text' as const,
        items: freeze(items),
        summary: freeze({ itemCount: 1, tokenEstimate: 1, preview: '' }),
        statistics: createBundleStatistics(items),
        contentHash: 'bundle',
      });
    };

    const before = makeBundle(code, {});

    // cleanup:session-dedup marks its elisions recoverable: the full text is retained in
    // the session store and can be restored, so the reference is not semantic loss.
    const recoverable = tracker.calculateDrift(
      before,
      makeBundle(marker, { elided: true, recoverable: true, originalContentHash: 'h1' }),
    );

    // compression:token-hashing elides the same bytes lossily and sets no `recoverable`
    // flag, so invariant 5 must still fire on it.
    const lossy = tracker.calculateDrift(
      before,
      makeBundle(marker, { elided: true, tokenHashed: true, originalContentHash: 'h1' }),
    );

    expect(recoverable.driftScore).toBe(0.0);
    expect(recoverable.shouldFallback).toBe(false);

    expect(lossy.driftScore).toBeGreaterThan(0.40);
    expect(lossy.shouldFallback).toBe(true);
  });

  it('extracts Python symbols and structural markers correctly', () => {
    const tracker = new DriftTracker();
    const pyCode = `
      import os
      from sys import exit

      class ModelPipeline:
          def train(self):
              pass

          def evaluate(self):
              pass
    `;

    const bundle = createContextBundle(pyCode, 'text', 'pipeline.py');
    const symbols = tracker.extractSymbols(bundle);

    expect(symbols.has('import:os')).toBe(true);
    expect(symbols.has('type:ModelPipeline')).toBe(true);
    expect(symbols.has('fn:train')).toBe(true);
    expect(symbols.has('fn:evaluate')).toBe(true);
  });

  describe('markdown markers are not harvested from code', () => {
    const commented = '# Configuration section\n# Another note\nimport os\n\nclass Widget:\n    def render(self):\n        return 1\n';

    it('does not read Python comments as markdown headings', () => {
      const tracker = new DriftTracker();
      const bundle = createContextBundle(commented, 'file', 'src/widget.py');
      expect(bundle.items[0]!.contentType).toBe('code');

      const markers = tracker.extractMarkers(bundle);
      // `filepath:` only. Before the fix this also contained two `heading:` entries, one
      // per `#` comment, because /^#{1,6}\s+/ cannot tell a comment from a heading.
      expect([...markers]).toEqual(['filepath:src/widget.py']);
    });

    it('still harvests real markdown headings from markdown', () => {
      // The complement, and unlike its two siblings this one passes with the fix reverted —
      // verified. It is not evidence the fix works; it guards against the gate over-firing
      // and silently disarming heading detection everywhere.
      const tracker = new DriftTracker();
      const bundle = createContextBundle('# Title\n\nSome prose.\n\n## Section\n', 'file', 'notes.md');
      expect(bundle.items[0]!.contentType).toBe('markdown');

      const markers = tracker.extractMarkers(bundle);
      expect(markers.has('heading:# Title')).toBe(true);
      expect(markers.has('heading:## Section')).toBe(true);
    });

    it('keeps drift on commented code inside the ceiling that applies to code', () => {
      // The measured consequence. Eliding this file destroys every symbol, so R_AST = 0 and
      // S_k must land on exactly w_AST = 0.60 — the ceiling for code established in
      // DECISIONS.md §18, since `filepath:` survives and pins R_struct at 1.0.
      //
      // Before the fix the two comments were counted as markers, destroyed along with the
      // content, and drift read R_struct = 0.3333 / S_k = 0.8667 — above a ceiling it should
      // not have been able to exceed, scaling with comment density rather than with loss.
      const tracker = new DriftTracker();
      const before = createContextBundle(commented, 'file', 'src/widget.py');
      const elided = createContextItem({
        id: before.items[0]!.id,
        kind: 'file',
        contentType: 'code',
        content: '<BLOCK_HASH:0000000000000000000000000000000000000000000000000000000000000000>',
        origin: 'src/widget.py',
        path: 'src/widget.py',
        metadata: freeze({ elided: true }),
      });
      const after = freeze({
        ...before,
        items: freeze([elided]),
        statistics: createBundleStatistics([elided]),
      });

      const report = tracker.calculateDrift(before, after);
      expect(report.astSymbolRetentionRatio).toBe(0);
      expect(report.structuralIntegrityRatio).toBe(1);
      expect(report.driftScore).toBeCloseTo(0.6, 10);
    });
  });
});
