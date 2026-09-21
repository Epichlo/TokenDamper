import { describe, expect, it } from 'vitest';
// Source, not `dist` — this is what `deep-backend-symbols.test.ts` does, and vitest transpiles
// it. Importing the build would silently test a stale artifact.
import { createDeepBackends } from '../../packages/deep/src/index';
import { selectElisionRegions } from '../../src/core/elision/regions';
import { createContextItem } from '../../src/core/model/constructors';

describe('deep regions() — typescript', () => {
  it('returns the brace interior of a function body, matching Fast convention', async () => {
    const backends = await createDeepBackends();
    const ts = backends.find((b) => b.language === 'typescript')!;
    const src = 'function add(a: number, b: number) {\n  return a + b;\n}\n';
    const regions = ts.regions(src);

    expect(regions).toHaveLength(1);
    // `start` just after `{`, `end` at the `}` — exactly scanBraceSpans's convention.
    expect(src.slice(regions[0]!.start, regions[0]!.end)).toBe('\n  return a + b;\n');
  });

  it('does not emit control-flow blocks', async () => {
    const backends = await createDeepBackends();
    const ts = backends.find((b) => b.language === 'typescript')!;
    const src = 'function f(x: number) {\n  if (x) {\n    return 1;\n  }\n  return 0;\n}\n';
    const regions = ts.regions(src);

    // The `if` block is a statement_block too; only the function body is a candidate.
    expect(regions).toHaveLength(1);
    expect(src.slice(regions[0]!.start, regions[0]!.end)).toContain('if (x)');
  });

  it('skips an expression-bodied arrow, which has no brace interior to take', async () => {
    const backends = await createDeepBackends();
    const ts = backends.find((b) => b.language === 'typescript')!;
    expect(ts.regions('const f = (x: number) => x + 1;\n')).toHaveLength(0);
  });
});

describe('deep regions() — python', () => {
  it('spans first-body-char to end of last body line', async () => {
    const backends = await createDeepBackends();
    const py = backends.find((b) => b.language === 'python')!;
    const src = 'def add(a, b):\n    return a + b\n';
    const regions = py.regions(src);

    expect(regions).toHaveLength(1);
    // Starts at `return`, not at the indent — scanPythonDefBodies uses
    // `firstBody.start + bodyIndent`. Ends at the end of the line, excluding `\n`.
    expect(src.slice(regions[0]!.start, regions[0]!.end)).toBe('return a + b');
  });

  it('keeps the docstring outside the region when asked', async () => {
    const backends = await createDeepBackends();
    const py = backends.find((b) => b.language === 'python')!;
    const src = 'def f():\n    """Doc."""\n    return 1\n';
    const kept = py.regions(src, { keepDocstrings: true });

    expect(kept).toHaveLength(1);
    expect(src.slice(kept[0]!.start, kept[0]!.end)).toBe('return 1');
  });

  it('emits no region for a body that is only a docstring when docstrings are kept', async () => {
    const backends = await createDeepBackends();
    const py = backends.find((b) => b.language === 'python')!;
    // Keeping the docstring leaves nothing to elide. An empty span here would be a region
    // that removes zero bytes and still writes a marker — strictly worse than the original.
    expect(py.regions('def f():\n    """Only a doc."""\n', { keepDocstrings: true })).toHaveLength(0);
  });
});

describe('deep regions() — go', () => {
  it('takes a func body and a method body', async () => {
    const backends = await createDeepBackends();
    const go = backends.find((b) => b.language === 'go')!;
    const src =
      'package main\n\nfunc add(a, b int) int {\n\treturn a + b\n}\n\nfunc (p *Point) X() int {\n\treturn p.x\n}\n';
    const regions = go.regions(src);

    expect(regions).toHaveLength(2);
    expect(src.slice(regions[0]!.start, regions[0]!.end)).toBe('\n\treturn a + b\n');
    expect(src.slice(regions[1]!.start, regions[1]!.end)).toBe('\n\treturn p.x\n');
  });

  it('does not take a struct body, which is not a function', async () => {
    const backends = await createDeepBackends();
    const go = backends.find((b) => b.language === 'go')!;
    expect(go.regions('package main\n\ntype Point struct {\n\tx int\n}\n')).toHaveLength(0);
  });
});

describe('deep regions() agree with Fast on straightforward source', () => {
  // Not a demand that they always agree — step 3's assertion is explicitly not identity.
  // This pins the *convention*: on source containing no construct either scanner finds
  // ambiguous, the two produce the same spans, so a later difference is a real discovery
  // difference rather than an off-by-one in how a span is expressed.
  //
  // Bodies below are sized well past MIN_REGION_BYTES (src/core/elision/regions.ts —
  // ELISION_MARKER_BYTES(80) + 24 = 104) on purpose. A first draft used 2-3-line bodies
  // (~20-30 bytes) and `selectElisionRegions` returned `[]` for all three languages while
  // `backend.regions()` still returned the discovered span — not an offset bug: a
  // `{ minRegionBytes: 0 }` probe showed the offsets already agreed exactly at that size.
  // Fast's default declines to select a region too small to be worth a marker; Deep's
  // `regionsFromTree` deliberately returns raw candidates only (its own doc comment: "a
  // parse tree into candidate elision spans"), with no size or substantive-content policy —
  // that policy lives one layer up, which this release of Deep does not have. Comparing the
  // two below the floor was measuring that scope gap, not the span convention. Sized above
  // it, the comparison exercises Fast's real default path, which is what a later corpus
  // measurement will actually call.
  const cases = [
    {
      language: 'typescript',
      path: '/tmp/a.ts',
      content:
        'export function f(a: number) {\n  const x0 = a + 0;\n  const x1 = a + 1;\n  const x2 = a + 2;\n' +
        '  const x3 = a + 3;\n  const x4 = a + 4;\n  const x5 = a + 5;\n  const x6 = a + 6;\n' +
        '  const x7 = a + 7;\n  const x8 = a + 8;\n  const x9 = a + 9;\n  return a;\n}\n',
    },
    {
      language: 'go',
      path: '/tmp/a.go',
      content:
        'package main\n\nfunc f(a int) int {\n\tx0 := a + 0\n\tx1 := a + 1\n\tx2 := a + 2\n\tx3 := a + 3\n' +
        '\tx4 := a + 4\n\tx5 := a + 5\n\tx6 := a + 6\n\tx7 := a + 7\n\tx8 := a + 8\n\tx9 := a + 9\n' +
        '\treturn a\n}\n',
    },
    {
      language: 'python',
      path: '/tmp/a.py',
      content:
        'def f(a):\n    x0 = a + 0\n    x1 = a + 1\n    x2 = a + 2\n    x3 = a + 3\n    x4 = a + 4\n' +
        '    x5 = a + 5\n    x6 = a + 6\n    x7 = a + 7\n    x8 = a + 8\n    x9 = a + 9\n    return a\n',
    },
  ];

  it.each(cases)('$language', async ({ language, path, content }) => {
    const backends = await createDeepBackends();
    const backend = backends.find((b) => b.language === language)!;
    const item = createContextItem({ id: 'i1', kind: 'file', content, path, language });

    const fast = selectElisionRegions(item).map((r) => ({ start: r.start, end: r.end }));
    const deep = backend.regions(content).map((r) => ({ start: r.start, end: r.end }));

    expect(deep).toEqual(fast);
  });

  // CRLF pin: `endOfLineContaining` (packages/deep/src/regions.ts) claims that on a CRLF file
  // the Python region's last character is the `\r`, matching Fast's `lineAt(last).end` — true,
  // but every case above is LF-only and cannot witness it. Without this row, someone could
  // simplify `endOfLineContaining` to `block.endIndex` and stay green here while every Python
  // region on this repository's own CRLF corpus came out one byte short. The TypeScript row is
  // cheap insurance: brace-interior spans are purely positional, so CRLF should not move them
  // either, but "should" is exactly what this file exists to stop asserting from the armchair.
  const crlfCases = [
    {
      language: 'python',
      path: '/tmp/b.py',
      content:
        'def f(a):\r\n    x0 = a + 0\r\n    x1 = a + 1\r\n    x2 = a + 2\r\n    x3 = a + 3\r\n' +
        '    x4 = a + 4\r\n    x5 = a + 5\r\n    x6 = a + 6\r\n    x7 = a + 7\r\n    x8 = a + 8\r\n' +
        '    x9 = a + 9\r\n    return a\r\n',
    },
    {
      language: 'typescript',
      path: '/tmp/b.ts',
      content:
        'export function f(a: number) {\r\n  const x0 = a + 0;\r\n  const x1 = a + 1;\r\n  const x2 = a + 2;\r\n' +
        '  const x3 = a + 3;\r\n  const x4 = a + 4;\r\n  const x5 = a + 5;\r\n  const x6 = a + 6;\r\n' +
        '  const x7 = a + 7;\r\n  const x8 = a + 8;\r\n  const x9 = a + 9;\r\n  return a;\r\n}\r\n',
    },
  ];

  it.each(crlfCases)('$language, CRLF', async ({ language, path, content }) => {
    const backends = await createDeepBackends();
    const backend = backends.find((b) => b.language === language)!;
    const item = createContextItem({ id: 'i2', kind: 'file', content, path, language });

    const fast = selectElisionRegions(item).map((r) => ({ start: r.start, end: r.end }));
    const deep = backend.regions(content).map((r) => ({ start: r.start, end: r.end }));

    expect(deep).toEqual(fast);
  });
});
