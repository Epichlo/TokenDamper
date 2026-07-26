import { describe, it, expect } from 'vitest';
import { computeLineDiff } from '../../src/core/utils/myers-diff';

describe('Myers O(ND) Diff Utility (computeLineDiff)', () => {
  it('handles empty inputs', () => {
    expect(computeLineDiff([], [])).toEqual([]);

    expect(computeLineDiff([], ['line1', 'line2'])).toEqual([
      { type: 'add', line: 'line1' },
      { type: 'add', line: 'line2' },
    ]);

    expect(computeLineDiff(['line1', 'line2'], [])).toEqual([
      { type: 'delete', line: 'line1' },
      { type: 'delete', line: 'line2' },
    ]);
  });

  it('handles identical inputs', () => {
    const lines = ['import fs from "fs";', 'const x = 1;', 'console.log(x);'];
    const diff = computeLineDiff(lines, lines);

    expect(diff).toEqual([
      { type: 'keep', line: 'import fs from "fs";' },
      { type: 'keep', line: 'const x = 1;' },
      { type: 'keep', line: 'console.log(x);' },
    ]);
  });

  it('handles pure additions', () => {
    const oldLines = ['header', 'footer'];
    const newLines = ['header', 'middle1', 'middle2', 'footer'];

    const diff = computeLineDiff(oldLines, newLines);

    expect(diff).toEqual([
      { type: 'keep', line: 'header' },
      { type: 'add', line: 'middle1' },
      { type: 'add', line: 'middle2' },
      { type: 'keep', line: 'footer' },
    ]);
  });

  it('handles pure deletions', () => {
    const oldLines = ['header', 'remove1', 'remove2', 'footer'];
    const newLines = ['header', 'footer'];

    const diff = computeLineDiff(oldLines, newLines);

    expect(diff).toEqual([
      { type: 'keep', line: 'header' },
      { type: 'delete', line: 'remove1' },
      { type: 'delete', line: 'remove2' },
      { type: 'keep', line: 'footer' },
    ]);
  });

  it('handles replacements (single & multi line)', () => {
    const oldLines = ['const a = 1;', 'const b = 2;', 'return a + b;'];
    const newLines = ['const a = 10;', 'const b = 20;', 'return a + b;'];

    const diff = computeLineDiff(oldLines, newLines);

    expect(diff).toEqual([
      { type: 'delete', line: 'const a = 1;' },
      { type: 'delete', line: 'const b = 2;' },
      { type: 'add', line: 'const a = 10;' },
      { type: 'add', line: 'const b = 20;' },
      { type: 'keep', line: 'return a + b;' },
    ]);
  });

  it('handles interleaved changes', () => {
    const oldLines = ['line1', 'line2', 'line3', 'line4', 'line5'];
    const newLines = ['line1', 'line2-mod', 'line3', 'line4-mod', 'line5'];

    const diff = computeLineDiff(oldLines, newLines);

    expect(diff).toEqual([
      { type: 'keep', line: 'line1' },
      { type: 'delete', line: 'line2' },
      { type: 'add', line: 'line2-mod' },
      { type: 'keep', line: 'line3' },
      { type: 'delete', line: 'line4' },
      { type: 'add', line: 'line4-mod' },
      { type: 'keep', line: 'line5' },
    ]);
  });

  it('handles duplicate lines correctly', () => {
    const oldLines = ['dup', 'dup', 'unique1', 'dup'];
    const newLines = ['dup', 'unique2', 'dup', 'dup'];

    const diff = computeLineDiff(oldLines, newLines);

    // Verify reconstruction property
    const reconstructedOld = diff
      .filter((op) => op.type === 'keep' || op.type === 'delete')
      .map((op) => op.line);
    const reconstructedNew = diff
      .filter((op) => op.type === 'keep' || op.type === 'add')
      .map((op) => op.line);

    expect(reconstructedOld).toEqual(oldLines);
    expect(reconstructedNew).toEqual(newLines);
  });

  it('handles blank lines correctly', () => {
    const oldLines = ['', 'function foo() {', '', '  return true;', '', '}'];
    const newLines = ['', 'function foo() {', '', '  return false;', '', '}'];

    const diff = computeLineDiff(oldLines, newLines);

    expect(diff).toEqual([
      { type: 'keep', line: '' },
      { type: 'keep', line: 'function foo() {' },
      { type: 'keep', line: '' },
      { type: 'delete', line: '  return true;' },
      { type: 'add', line: '  return false;' },
      { type: 'keep', line: '' },
      { type: 'keep', line: '}' },
    ]);
  });

  it('strictly preserves chronological order and sequence integrity', () => {
    const oldLines = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const newLines = ['A', 'X', 'B', 'D', 'Y', 'G'];

    const diff = computeLineDiff(oldLines, newLines);

    // Reconstructed sequences
    const oldSequence: string[] = [];
    const newSequence: string[] = [];

    for (const op of diff) {
      if (op.type === 'keep') {
        oldSequence.push(op.line);
        newSequence.push(op.line);
      } else if (op.type === 'delete') {
        oldSequence.push(op.line);
      } else if (op.type === 'add') {
        newSequence.push(op.line);
      }
    }

    expect(oldSequence).toEqual(oldLines);
    expect(newSequence).toEqual(newLines);
  });

  it('leverages prefix and suffix trimming on large inputs with minor modifications', () => {
    const prefix = Array.from({ length: 500 }, (_, i) => `prefix_line_${i}`);
    const suffix = Array.from({ length: 500 }, (_, i) => `suffix_line_${i}`);

    const oldLines = [...prefix, 'old_middle_1', 'old_middle_2', ...suffix];
    const newLines = [...prefix, 'new_middle_1', ...suffix];

    const startTime = performance.now();
    const diff = computeLineDiff(oldLines, newLines);
    const duration = performance.now() - startTime;

    expect(duration).toBeLessThan(50); // fast path prefix/suffix trimming

    const keeps = diff.filter((op) => op.type === 'keep');
    const deletes = diff.filter((op) => op.type === 'delete');
    const adds = diff.filter((op) => op.type === 'add');

    expect(keeps.length).toBe(1000);
    expect(deletes).toEqual([
      { type: 'delete', line: 'old_middle_1' },
      { type: 'delete', line: 'old_middle_2' },
    ]);
    expect(adds).toEqual([{ type: 'add', line: 'new_middle_1' }]);
  });
});
