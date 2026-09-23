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

// A nested function — a local helper in TypeScript, a closure in Python — is where the
// previous describe block's premise ("no construct either scanner finds ambiguous") stops
// holding. This block pins what actually happens there, on purpose, as a characterization
// rather than a defect.
//
// **Why this is not a bug.** `backend.regions()` (`packages/deep/src/regions.ts`) is discovery
// only: `walk` visits every node in the tree, so a `function_declaration`/`function_definition`
// nested inside another one is visited and matched just like the outer one — there is no
// "already inside a match" state to skip it. `selectElisionRegions`
// (`src/core/elision/regions.ts`) is discovery *and* a selection policy: `scanBraceSpans` and
// `scanPythonDefBodies` emit the same nested candidate Deep does (nothing in either scanner
// tracks nesting either), but the caller then runs `dropOverlapping` (`regions.ts:410-422`) over
// the candidate list, and that function's whole job is to keep the outer/earlier region and drop
// anything nested inside it — "kept" in `selectElisionRegions`'s own return statement is
// `dropOverlapping(candidates).filter(...)` (`regions.ts:1104`). Deep's candidate list is not
// run through that filter this release, so its nested candidate survives to the return value.
//
// **Why the fix is not in `regions.ts`.** Making `walk` skip a function nested inside an
// already-matched one would special-case Deep to imitate one caller's policy, permanently —
// even though `dropOverlapping` already does exactly that job, generically, for whichever
// candidate list it is handed, Fast's own included. That routing has since landed —
// `selectElisionRegions` consults the registry in deep mode, and
// `test/unit/elision-regions-mode.test.ts` pins that `dropOverlapping` discards Deep's nested
// region exactly as it discards Fast's, with no change to either scanner. This file still
// compares raw discovery against a post-filter list, which is why the counts below differ. So
// read the next paragraph as describing *this* comparison, not an unfinished one: Deep's raw
// discovery finding one more candidate than Fast's post-filter list is not a disagreement about
// what a function body is — it is a discovery pass being compared to a discovery-plus-policy
// pass. **If you "fix" `regions.ts` to make `deep.length` below read 1, you have made discovery
// worse (a real candidate a future sub-region caller may want is now gone) to paper over this
// comparison, and this test will fail on that line to tell you so.**
describe('deep regions() vs Fast — nested functions (a discovery/policy divergence, not a bug)', () => {
  it('typescript: Deep finds the outer body and the nested one; Fast keeps only the outer', async () => {
    const backends = await createDeepBackends();
    const ts = backends.find((b) => b.language === 'typescript')!;
    const src =
      'export function outer(a: number) {\n' +
      '  function inner(b: number) {\n' +
      '    return b + 1;\n' +
      '  }\n' +
      '  const x0 = a + 0;\n' +
      '  const x1 = a + 1;\n' +
      '  const x2 = a + 2;\n' +
      '  const x3 = a + 3;\n' +
      '  const x4 = a + 4;\n' +
      '  return inner(x0) + x1 + x2 + x3 + x4;\n' +
      '}\n';
    const item = createContextItem({
      id: 'nested-ts',
      kind: 'file',
      content: src,
      path: '/tmp/nested.ts',
      language: 'typescript',
    });

    const deep = ts.regions(src);
    const fast = selectElisionRegions(item);

    // Deep: outer's body (193 bytes, comfortably past the 104-byte floor Fast applies and
    // Deep does not) and, nested inside it, `inner`'s own body.
    expect(deep).toHaveLength(2);
    expect(src.slice(deep[0]!.start, deep[0]!.end)).toBe(
      '\n  function inner(b: number) {\n    return b + 1;\n  }\n  const x0 = a + 0;\n' +
        '  const x1 = a + 1;\n  const x2 = a + 2;\n  const x3 = a + 3;\n  const x4 = a + 4;\n' +
        '  return inner(x0) + x1 + x2 + x3 + x4;\n',
    );
    expect(src.slice(deep[1]!.start, deep[1]!.end)).toBe('\n    return b + 1;\n  ');

    // Fast: `scanBraceSpans` finds the identical nested candidate (its header,
    // `function inner(b: number) {`, passes `FUNCTION_HEADER` just like the outer one does).
    // `dropOverlapping` sorts candidates by ascending start, keeps the outer one first (its
    // start is earliest) and advances its cursor to the outer's end; when it then reaches the
    // nested candidate, that candidate's start is still behind the cursor, so it is dropped.
    // One region survives, and it is byte-identical to Deep's outer region — not a coincidence,
    // since both scanners found the same outer span.
    expect(fast).toHaveLength(1);
    expect(fast[0]).toEqual(deep[0]);
  });

  it('python: Deep finds the outer body and the nested one; Fast keeps only the outer', async () => {
    const backends = await createDeepBackends();
    const py = backends.find((b) => b.language === 'python')!;
    const src =
      'def outer(a):\n' +
      '    def inner(b):\n' +
      '        return b + 1\n' +
      '    x0 = a + 0\n' +
      '    x1 = a + 1\n' +
      '    x2 = a + 2\n' +
      '    x3 = a + 3\n' +
      '    x4 = a + 4\n' +
      '    return inner(x0) + x1 + x2 + x3 + x4\n';
    const item = createContextItem({
      id: 'nested-py',
      kind: 'file',
      content: src,
      path: '/tmp/nested.py',
      language: 'python',
    });

    const deep = py.regions(src);
    const fast = selectElisionRegions(item);

    // Deep: outer's body (150 bytes, past the same 104-byte floor) and, nested inside it,
    // `inner`'s own body.
    expect(deep).toHaveLength(2);
    expect(src.slice(deep[0]!.start, deep[0]!.end)).toBe(
      'def inner(b):\n        return b + 1\n    x0 = a + 0\n    x1 = a + 1\n' +
        '    x2 = a + 2\n    x3 = a + 3\n    x4 = a + 4\n    return inner(x0) + x1 + x2 + x3 + x4',
    );
    expect(src.slice(deep[1]!.start, deep[1]!.end)).toBe('return b + 1');

    // Fast: `scanPythonDefBodies` matches every `^\s*def\s.*:\s*$` line, nested ones included,
    // for the same reason `scanBraceSpans` does above — nothing in the scanner tracks nesting.
    // `dropOverlapping` then subsumes `inner`'s region into `outer`'s. One region survives, and
    // it is byte-identical to Deep's outer region.
    expect(fast).toHaveLength(1);
    expect(fast[0]).toEqual(deep[0]);
  });

  it('go: a closure is func_literal, matched by neither side, so nesting is not this test', async () => {
    const backends = await createDeepBackends();
    const go = backends.find((b) => b.language === 'go')!;
    const src =
      'package main\n\n' +
      'func outer(a int) int {\n' +
      '\thandler := func(b int) int {\n' +
      '\t\treturn b + 1\n' +
      '\t}\n' +
      '\tx0 := a + 0\n' +
      '\tx1 := a + 1\n' +
      '\tx2 := a + 2\n' +
      '\tx3 := a + 3\n' +
      '\tx4 := a + 4\n' +
      '\treturn handler(x0) + x1 + x2 + x3 + x4\n' +
      '}\n';
    const item = createContextItem({
      id: 'nested-go',
      kind: 'file',
      content: src,
      path: '/tmp/nested.go',
      language: 'go',
    });

    const deep = go.regions(src);
    const fast = selectElisionRegions(item);

    // Go has no equivalent of a nested named function — the closest a closure gets is a
    // `func_literal` assigned to a variable, and that node type is in neither side's function
    // set: `GO_FUNCTION_NODES` (packages/deep/src/regions.ts) is `function_declaration` and
    // `method_declaration` only, and Fast's `GO_FUNCTION_HEADER = /^func\b/`
    // (src/core/elision/regions.ts) requires the keyword to *start* the header line, which
    // `handler := func(b int) int {` does not (documented at that regex's definition as
    // deliberate: a closure's body "sit[s] inside an enclosing function body that is already a
    // candidate"). Both sides therefore see the outer function only, and the two agree exactly
    // — this is what stops a reader of the two tests above from concluding Deep/Fast diverge on
    // every nested construct; the divergence is specific to named nested functions in
    // TypeScript and Python, and Go has none.
    expect(deep).toHaveLength(1);
    expect(fast).toHaveLength(1);
    expect(src.slice(deep[0]!.start, deep[0]!.end)).toBe(
      '\n\thandler := func(b int) int {\n\t\treturn b + 1\n\t}\n\tx0 := a + 0\n\tx1 := a + 1\n' +
        '\tx2 := a + 2\n\tx3 := a + 3\n\tx4 := a + 4\n\treturn handler(x0) + x1 + x2 + x3 + x4\n',
    );
    expect(fast[0]).toEqual(deep[0]);
  });
});

/**
 * Fast and Deep disagree about where a Python body STARTS when it opens with a comment, and
 * the agreement block above does not cover it because all of its fixtures open with a statement.
 *
 * `scanPythonDefBodies` scans lines and starts at the first non-blank body line whatever it
 * holds, so a leading `#` comment is inside Fast's span. tree-sitter treats a comment as an
 * extra, so `block.namedChild(0)` is the first statement and the comment stays outside Deep's.
 * Same end, different start.
 *
 * Measured over the frozen 45-file pip corpus when R3 step 3 was recorded: 16 files contain at
 * least one such pair, and in 3 of them excluding the comment drops the span under
 * `MIN_REGION_BYTES` so Deep declines the region entirely — those three are `cli/parser.py`,
 * `exceptions.py` and `index/package_finder.py`.
 *
 * `locations/_distutils.py` is a *different* case and is why DECISIONS §81's superset table has a
 * non-zero only-in-fast column: the two region sets are disjoint there, not nested. Its Deep span
 * survives at 552 bytes — it is not one of the three declining files, and an earlier draft of
 * this comment said it was.
 *
 * This is a characterization test, not a defect report. Deep keeping the comment is the more
 * conservative slice. If someone makes the two agree, this fails on purpose and §81's numbers
 * need re-measuring, because the recovered-row attribution partly rests on this behaviour.
 */
describe('python bodies that open with a comment', () => {
  const SRC =
    'def f(a):\n' +
    '    # A leading note that is long enough to matter to the size filter downstream.\n' +
    '    total = a * 2\n' +
    '    return total\n';

  it('Fast starts at the comment, Deep starts at the first statement', async () => {
    const backends = await createDeepBackends();
    const py = backends.find((b) => b.language === 'python')!;
    const item = createContextItem({ id: 'p', kind: 'file', content: SRC, path: '/tmp/a.py', language: 'python' });

    const fast = selectElisionRegions(item, { minRegionBytes: 0 });
    const deep = py.regions(SRC);

    expect(fast).toHaveLength(1);
    expect(deep).toHaveLength(1);
    // Same end.
    expect(deep[0]!.end).toBe(fast[0]!.end);
    // Different start, and this is what the assertion is about.
    expect(deep[0]!.start).toBeGreaterThan(fast[0]!.start);
    expect(SRC.slice(fast[0]!.start, fast[0]!.start + 1)).toBe('#');
    expect(SRC.slice(deep[0]!.start).startsWith('total =')).toBe(true);
  });

  it('agrees again once the leading comment is gone', async () => {
    const backends = await createDeepBackends();
    const py = backends.find((b) => b.language === 'python')!;
    const noComment = 'def f(a):\n    total = a * 2\n    return total\n';
    const item = createContextItem({
      id: 'p2',
      kind: 'file',
      content: noComment,
      path: '/tmp/b.py',
      language: 'python',
    });

    const fast = selectElisionRegions(item, { minRegionBytes: 0 }).map((r) => ({ start: r.start, end: r.end }));
    const deep = py.regions(noComment).map((r) => ({ start: r.start, end: r.end }));
    expect(deep).toEqual(fast);
  });
});
