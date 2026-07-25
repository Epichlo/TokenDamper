import { describe, expect, it } from 'vitest';
import { createContextBundle } from '../../src/core/model/constructors';
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
});
