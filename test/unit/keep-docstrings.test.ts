import { describe, expect, it } from 'vitest';
import { selectElisionRegions } from '../../src/core/elision';
import { createContextItem } from '../../src/core/model/constructors';

/**
 * `--keep-docstrings` keeps a function's leading docstring outside the elided region.
 *
 * Measured, docstrings are where a function's *why* survives elision: the retention test found 3
 * of 4 lost answers living in one. Keeping them is a retention/size trade the caller opts into —
 * 14.2% of the saving on real pip code, 21.1% on doc-heavy source — so it is off by default and
 * the default path stays byte-identical (pinned separately by the corpus A/B). DECISIONS §58.
 */
const pyItem = (content: string) =>
  createContextItem({ id: 'py', kind: 'file', contentType: 'code', content, path: 'a.py', language: 'python' });

const bodyLines = Array.from({ length: 10 }, (_, i) => `    step_${i} = compute(base, ${i}) * factor`).join('\n');

describe('--keep-docstrings region selection', () => {
  it('excludes a one-line triple-quoted docstring from the region', () => {
    const src = `def alpha(base, factor):\n    """Explain what alpha does and why it exists here."""\n${bodyLines}\n    return step_0\n`;

    const withDoc = selectElisionRegions(pyItem(src), { keepDocstrings: false });
    const kept = selectElisionRegions(pyItem(src), { keepDocstrings: true });

    expect(withDoc).toHaveLength(1);
    expect(kept).toHaveLength(1);

    // Default: the docstring is inside the region and would be removed.
    expect(src.slice(withDoc[0]!.start, withDoc[0]!.end)).toContain('Explain what alpha does');
    // With the flag: the region starts at the first code statement, docstring untouched.
    const keptText = src.slice(kept[0]!.start, kept[0]!.end);
    expect(keptText).not.toContain('Explain what alpha does');
    expect(keptText.startsWith('step_0')).toBe(true);
  });

  it('excludes a multi-line docstring from the region', () => {
    const src = [
      'def beta(base, factor):',
      '    """First line of the docstring.',
      '',
      '    A second paragraph explaining the rationale in more detail.',
      '    """',
      bodyLines,
      '    return step_0',
      '',
    ].join('\n');

    const kept = selectElisionRegions(pyItem(src), { keepDocstrings: true });
    expect(kept).toHaveLength(1);
    const keptText = src.slice(kept[0]!.start, kept[0]!.end);
    expect(keptText).not.toContain('First line of the docstring');
    expect(keptText).not.toContain('second paragraph');
    expect(keptText.startsWith('step_0')).toBe(true);
  });

  it('leaves a body without a docstring unchanged either way', () => {
    const src = `def gamma(base, factor):\n${bodyLines}\n    return step_0\n`;

    const off = selectElisionRegions(pyItem(src), { keepDocstrings: false });
    const on = selectElisionRegions(pyItem(src), { keepDocstrings: true });

    expect(off).toHaveLength(1);
    expect(on).toHaveLength(1);
    expect(off[0]).toEqual(on[0]);
  });

  it('drops the region when the docstring is the whole substantive body', () => {
    // Keeping the docstring leaves too little code to be worth a marker, so the function is not
    // elided at all — correct, since there is nothing meaningful left to remove.
    const src = `def delta():\n    """This function is a stub that only documents intent."""\n    pass\n`;

    const on = selectElisionRegions(pyItem(src), { keepDocstrings: true });
    expect(on).toHaveLength(0);
  });

  it('does not affect TypeScript, whose doc comments sit outside the body', () => {
    const ts = [
      '/** Doc comment above the function, not inside its braces. */',
      'export function alpha(base: number, factor: number): number {',
      Array.from({ length: 10 }, (_, i) => `  const step${i} = compute(base, ${i}) * factor;`).join('\n'),
      '  return step0;',
      '}',
    ].join('\n');
    const tsItem = createContextItem({ id: 'ts', kind: 'file', contentType: 'code', content: ts, path: 'a.ts', language: 'typescript' });

    const off = selectElisionRegions(tsItem, { keepDocstrings: false });
    const on = selectElisionRegions(tsItem, { keepDocstrings: true });
    expect(off).toEqual(on);
  });
});
