import { describe, expect, it } from 'vitest';
import {
  elideRegions,
  isSubstantiveRegion,
  MIN_REGION_BYTES,
  selectElisionRegions,
} from '../../src/core/elision';
import { createContextItem } from '../../src/core/model/constructors';
import { TokenHasher } from '../../src/core/hashing/token-hasher';
import { validateItemAst } from '../../src/core/validation/ast';

const item = (content: string, path: string, language?: string) =>
  createContextItem({
    id: 'i1',
    kind: 'file',
    contentType: 'code',
    content,
    path,
    ...(language ? { language } : {}),
  });

const pad = (n: number) => `  const filler${n} = ${'"' + 'x'.repeat(60) + '"'};`;

describe('sub-item elision regions', () => {
  describe('selection', () => {
    it('selects function bodies and leaves declarations outside the region', () => {
      const src = ['export function alpha(x: number): number {', pad(1), pad(2), '  return x;', '}'].join('\n');
      const regions = selectElisionRegions(item(src, 'src/a.ts'));

      expect(regions).toHaveLength(1);
      const text = src.slice(regions[0]!.start, regions[0]!.end);
      expect(text).not.toContain('export function alpha');
      expect(text).toContain('return x;');
      // The braces stay outside, which is what keeps the result bracket-balanced.
      expect(src[regions[0]!.start - 1]).toBe('{');
      expect(src[regions[0]!.end]).toBe('}');
    });

    it('never selects a class body, because that would destroy its method signatures', () => {
      const src = [
        'export class Widget {',
        '  render(): string {',
        pad(1),
        pad(2),
        '    return "w";',
        '  }',
        '}',
      ].join('\n');
      const regions = selectElisionRegions(item(src, 'src/a.ts'));

      expect(regions).toHaveLength(1);
      const text = src.slice(regions[0]!.start, regions[0]!.end);
      expect(text).not.toContain('render()');
      expect(text).toContain('return "w";');
    });

    it('subsumes a nested function body into its enclosing one rather than overlapping', () => {
      const src = [
        'export function outer(): void {',
        pad(1),
        '  function inner(): void {',
        pad(2),
        '  }',
        '}',
      ].join('\n');
      const regions = selectElisionRegions(item(src, 'src/a.ts'));

      expect(regions).toHaveLength(1);
      for (let i = 1; i < regions.length; i++) {
        expect(regions[i]!.start).toBeGreaterThanOrEqual(regions[i - 1]!.end);
      }
    });

    it('selects a Python def body starting after its indentation', () => {
      const src = ['def alpha(x):', `    total = ${'1 + '.repeat(30)}1`, '    return total', ''].join('\n');
      const regions = selectElisionRegions(item(src, 'src/a.py'));

      expect(regions).toHaveLength(1);
      const text = src.slice(regions[0]!.start, regions[0]!.end);
      // Rule B: the indentation is NOT part of the region, so the marker inherits its column.
      expect(text.startsWith('total =')).toBe(true);
      expect(src.slice(regions[0]!.start - 4, regions[0]!.start)).toBe('    ');
    });

    it('does not select a Python class body', () => {
      const src = ['class Widget:', '    def render(self):', `        return "${'w'.repeat(140)}"`, ''].join('\n');
      const regions = selectElisionRegions(item(src, 'src/a.py'));

      for (const region of regions) {
        expect(src.slice(region.start, region.end)).not.toContain('def render');
      }
    });

    it('returns nothing for JSON, prose, or an unrecognised language', () => {
      expect(selectElisionRegions(item(JSON.stringify({ a: 'x'.repeat(300) }), 'data.json'))).toHaveLength(0);
      expect(selectElisionRegions(item('just some prose '.repeat(40), 'notes.txt'))).toHaveLength(0);
    });

    it('is deterministic', () => {
      const src = ['function a(): void {', pad(1), pad(2), '}', 'function b(): void {', pad(3), pad(4), '}'].join('\n');
      const one = selectElisionRegions(item(src, 'src/a.ts'));
      const two = selectElisionRegions(item(src, 'src/a.ts'));
      expect(JSON.stringify(two)).toBe(JSON.stringify(one));
      expect(one.length).toBeGreaterThan(0);
    });
  });

  describe('the scanner does not mistake data for structure', () => {
    it('ignores braces inside strings, comments and regex literals', () => {
      const src = [
        'export function alpha(): string {',
        '  const a = "a { brace in a string";',
        '  // a { brace in a comment',
        '  /* a } brace in a block comment */',
        '  const re = /\\([^)]+\\{/;',
        '  return a + String(re);',
        '}',
      ].join('\n');
      const regions = selectElisionRegions(item(src, 'src/a.ts'));

      expect(regions).toHaveLength(1);
      const text = src.slice(regions[0]!.start, regions[0]!.end);
      // One region spanning the whole body: no spurious brace split it.
      expect(text).toContain('brace in a string');
      expect(text).toContain('return a + String(re);');
    });

    it('treats a slash after a value as division, not a regex opener', () => {
      const src = ['export function alpha(a: number, b: number): number {', pad(1), '  return (a + b) / 2;', '}'].join('\n');
      const regions = selectElisionRegions(item(src, 'src/a.ts'));
      expect(regions).toHaveLength(1);
      expect(src.slice(regions[0]!.start, regions[0]!.end)).toContain('return (a + b) / 2;');
    });
  });

  describe('the docstring guard (Phase 1d precondition)', () => {
    it('classifies comment-only and docstring-only regions as non-substantive', () => {
      expect(isSubstantiveRegion('  """ Return the thing.\n  More words. """\n', 'python')).toBe(false);
      expect(isSubstantiveRegion('  // explanation\n  /* more */\n', 'typescript')).toBe(false);
      expect(isSubstantiveRegion('  return "x";\n', 'typescript')).toBe(true);
      expect(isSubstantiveRegion('  return 1\n', 'python')).toBe(true);
    });

    it('refuses a docstring-only Python body — the HumanEval failure mode', () => {
      // This is HumanEval/0's exact shape: the prompt IS the docstring, and eliding it
      // measured 55.66% reduction at S_k = 0.0000 because docstrings carry no symbols.
      const src = [
        'def has_close_elements(numbers, threshold):',
        '    """ Check if in given list of numbers, any two numbers are closer to each other',
        '    than the given threshold.',
        '    >>> has_close_elements([1.0, 2.0, 3.0], 0.5)',
        '    False',
        '    """',
        '',
      ].join('\n');

      expect(src.length).toBeGreaterThan(MIN_REGION_BYTES);
      expect(selectElisionRegions(item(src, 'src/a.py'))).toHaveLength(0);
    });

    it('still selects a body that mixes a docstring with real code', () => {
      const src = [
        'def alpha(x):',
        '    """ Doc. """',
        `    total = ${'1 + '.repeat(30)}1`,
        '    return total',
        '',
      ].join('\n');
      expect(selectElisionRegions(item(src, 'src/a.py'))).toHaveLength(1);
    });
  });

  describe('elideRegions', () => {
    // Both bodies are deliberately well clear of MIN_REGION_BYTES; sized to the floor they
    // straddle it and the region count becomes an accident of filler length.
    const src = [
      'import { helper } from "./helper";',
      'export function alpha(x: number): number {',
      pad(1),
      pad(2),
      '  return helper(x);',
      '}',
      'export function beta(x: number): number {',
      pad(3),
      pad(4),
      '  return x * 3;',
      '}',
    ].join('\n');

    const elide = (source: string, path: string) => {
      const target = item(source, path);
      const regions = selectElisionRegions(target);
      const hasher = new TokenHasher();
      const outcome = elideRegions({
        item: target,
        regions,
        markerFor: (text) => hasher.createBlockPlaceholder(text),
        metadata: { elided: true, tokenHashed: true },
      });
      return { target, regions, hasher, outcome };
    };

    it('replaces regions, keeps everything else, and shrinks the item', () => {
      const { target, regions, outcome } = elide(src, 'src/a.ts');
      expect(regions.length).toBe(2);
      expect(outcome.status).toBe('elided');
      if (outcome.status !== 'elided') return;

      expect(outcome.item.content).toContain('export function alpha(x: number): number {');
      expect(outcome.item.content).toContain('import { helper } from "./helper";');
      expect(outcome.item.content).not.toContain('return helper(x);');
      expect(outcome.bytesSaved).toBeGreaterThan(0);
      expect(outcome.item.content.length).toBeLessThan(target.content.length);
    });

    it('round-trips byte-identically through the existing recovery valve', () => {
      const { target, hasher, outcome } = elide(src, 'src/a.ts');
      expect(outcome.status).toBe('elided');
      if (outcome.status !== 'elided') return;

      // Rule A. `rehydrateText` substitutes in place, so the elided region must be exactly
      // the bytes replaced. Nothing may be added around the marker.
      expect(hasher.rehydrateText(outcome.item.content)).toBe(target.content);
    });

    it('keeps Python output indented and reversible at the same time', () => {
      const py = ['def alpha(x):', `    total = ${'1 + '.repeat(30)}1`, '    return total', ''].join('\n');
      const { target, hasher, outcome } = elide(py, 'src/a.py');
      expect(outcome.status).toBe('elided');
      if (outcome.status !== 'elided') return;

      // Rules A and B together: indented (so the validator accepts it) AND exactly
      // reversible (so the recovery valve restores the original bytes).
      expect(outcome.item.content).toMatch(/\n {4}<BLOCK_HASH:/);
      expect(validateItemAst(outcome.item).valid).toBe(true);
      expect(hasher.rehydrateText(outcome.item.content)).toBe(target.content);
    });

    it('introduces no new AST issues', () => {
      const { target, outcome } = elide(src, 'src/a.ts');
      expect(outcome.status).toBe('elided');
      if (outcome.status !== 'elided') return;

      expect(validateItemAst(outcome.item).issues.length).toBeLessThanOrEqual(
        validateItemAst(target).issues.length,
      );
    });

    it('accepts input that is already AST-invalid, without requiring it to become valid', () => {
      // A truncated completion prompt — three of the ten bundled bench fixtures are these.
      // An absolute post-condition would refuse every one of them forever.
      const truncated = ['export function alpha(x: number): number {', pad(1), '  return helper(x);'].join('\n');
      const target = item(truncated, 'src/a.ts');
      expect(validateItemAst(target).valid).toBe(false);

      const regions = selectElisionRegions(target);
      expect(regions.length).toBe(0); // no closing brace, so no complete body to elide
    });

    it('refuses overlapping, inverted or out-of-bounds regions rather than guessing', () => {
      const target = item(src, 'src/a.ts');
      const hasher = new TokenHasher();
      const attempt = (regions: ReadonlyArray<{ start: number; end: number }>) =>
        elideRegions({
          item: target,
          regions,
          markerFor: (t) => hasher.createBlockPlaceholder(t),
          metadata: {},
        });

      expect(attempt([{ start: 10, end: 40 }, { start: 30, end: 60 }]).status).toBe('skipped');
      expect(attempt([{ start: 40, end: 10 }]).status).toBe('skipped');
      expect(attempt([{ start: 0, end: src.length + 5 }]).status).toBe('skipped');
    });

    it('skips when there is nothing to elide or nothing to save', () => {
      const target = item(src, 'src/a.ts');
      expect(
        elideRegions({ item: target, regions: [], markerFor: (t) => t, metadata: {} }).status,
      ).toBe('skipped');
      // A marker longer than the region it replaces must not be accepted.
      expect(
        elideRegions({
          item: target,
          regions: [{ start: 0, end: 5 }],
          markerFor: () => 'x'.repeat(500),
          metadata: {},
        }).status,
      ).toBe('skipped');
    });

    it('refuses JSON items outright, because the wrapper does not compose', () => {
      const jsonItem = item(JSON.stringify({ payload: 'x'.repeat(400) }), 'data.json');
      const hasher = new TokenHasher();
      const outcome = elideRegions({
        item: jsonItem,
        regions: [{ start: 14, end: 400 }],
        markerFor: (t) => hasher.createBlockPlaceholder(t),
        metadata: {},
      });
      expect(outcome.status).toBe('skipped');
      if (outcome.status === 'skipped') {
        expect(outcome.reason).toBe('post_condition_rejected');
      }
    });
  });
});
