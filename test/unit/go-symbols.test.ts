import { describe, expect, it } from 'vitest';
import { DriftTracker } from '../../src/core/ledger/drift-tracker';
import { createBundleFromItems, createContextItem } from '../../src/core/model/constructors';
import { describeLanguageSupport } from '../../src/core/validation/language-support';

/**
 * Step 1 of widening elision to Go: `DriftTracker.extractSymbols` (DECISIONS §56, §59).
 *
 * **The order is `extractSymbols` -> validator -> region scanner, and it is a safety ordering
 * rather than a tidy one.** `extractSymbols` is regex over `item.content` and never consults
 * `selectValidator`, so it is the only one of the three that can be widened while the language
 * is still unelidable. §56 measured what happens if the scanner goes first: a Go file carrying
 * a `struct` or an `import` yields `type:Point` and `import:fmt`, both signature-level and both
 * surviving body elision by construction, so the drift gate reports `astMeasured: true` with
 * `S_k = 0.0000` having witnessed nothing. That is §33's defect one step over — a before-set
 * that is *non-empty but structurally incapable of registering the loss* — and on the CLI,
 * where elision is irreversible, it is data loss with every gate green.
 *
 * **Which of these fail against the unfixed engine, and which are negative controls.** Measured
 * by reverting `src/core/ledger/drift-tracker.ts` and re-running: **9 of the 14 fail, 5 pass**.
 * The five that pass both ways are controls against this change reaching further than Go, and
 * they are not evidence that it works — they are `does not harvest interface method
 * declarations`, both cases in `the Go patterns do not reach TypeScript or Python`, `still
 * scores a signature-preserving elision at zero`, and `leaves the language-support verdict
 * alone`. Note that the two tests whose subject is a symbol being *absent* are not both
 * controls: `invents nothing for an anonymous literal` and `is anchored to the start of a line`
 * each also assert the one real declaration in their fixture, so both fail without the change.
 */
const tracker = new DriftTracker();

const goBundle = (content: string) =>
  createBundleFromItems(
    [createContextItem({ id: 'g1', kind: 'file', content, path: 'report.go', language: 'go', contentType: 'code' })],
    'file',
  );

describe('extractSymbols harvests Go function declarations', () => {
  const symbolsOf = (content: string) => tracker.extractSymbols(goBundle(content));

  it('takes a plain function declaration, generic or not', () => {
    const symbols = symbolsOf(
      [
        'package main',
        '',
        'func main() {',
        '\tprintln("hi")',
        '}',
        '',
        'func computeTotal(items []int) (int, error) {',
        '\treturn 0, nil',
        '}',
        '',
        'func Map[T any, U any](in []T, f func(T) U) []U {',
        '\treturn nil',
        '}',
        '',
      ].join('\n'),
    );

    expect(symbols.has('fn:main')).toBe(true);
    expect(symbols.has('fn:computeTotal')).toBe(true);
    // The type parameter list is cleared by admitting `[` where `(` would otherwise be, rather
    // than by balancing brackets — the name is what identifies the function.
    expect(symbols.has('fn:Map')).toBe(true);
  });

  it('takes methods, qualified by receiver type', () => {
    const symbols = symbolsOf(
      [
        'package main',
        '',
        'func (p *Point) Translate(dx int, dy int) {',
        '\tp.X += dx',
        '}',
        '',
        'func (p Point) String() string {',
        '\treturn ""',
        '}',
        '',
        'func (Point) Reset() {',
        '}',
        '',
        'func (s *Stack[T]) Push(v T) {',
        '}',
        '',
      ].join('\n'),
    );

    expect(symbols.has('method:Point.Translate')).toBe(true); // pointer receiver
    expect(symbols.has('method:Point.String')).toBe(true); // value receiver
    expect(symbols.has('method:Point.Reset')).toBe(true); // receiver with no name — legal Go
    expect(symbols.has('method:Stack.Push')).toBe(true); // generic receiver
  });

  it('keeps two same-named methods apart, where a bare name would collapse them', () => {
    // Why Go methods are qualified and the class methods in block 8 are not: `String`, `Error`
    // and `Read` recur across every type in a file by convention, so a bare `method:String`
    // would make losing both of these read as losing one.
    const symbols = symbolsOf(
      [
        'package main',
        '',
        'func (p Point) String() string { return "" }',
        '',
        'func (r Rect) String() string { return "" }',
        '',
      ].join('\n'),
    );

    expect(symbols.has('method:Point.String')).toBe(true);
    expect(symbols.has('method:Rect.String')).toBe(true);
  });

  it('invents nothing for an anonymous literal or a func type', () => {
    const symbols = symbolsOf(
      [
        'package main',
        '',
        'type Handler func(int) error',
        '',
        'var fallback = func(n int) error {',
        '\treturn nil',
        '}',
        '',
        'func register() {',
        '\th := func(n int) error { return nil }',
        '\t_ = h',
        '}',
        '',
      ].join('\n'),
    );

    // The declaration that does exist.
    expect(symbols.has('fn:register')).toBe(true);

    // `type Handler func(...)` is a type, harvested as one by the class regex rather than as a
    // function, and neither closure has a name to take.
    expect(symbols.has('type:Handler')).toBe(true);
    expect(symbols.has('fn:Handler')).toBe(false);
    expect([...symbols].filter((s) => s.startsWith('fn:'))).toEqual(['fn:register']);
  });

  it('does not harvest interface method declarations', () => {
    // A deliberate omission, not an oversight. An interface method has no body, so it would be
    // one more symbol that survives elision by construction — the exact dependency this block
    // exists to remove.
    const symbols = symbolsOf(
      ['package main', '', 'type Reader interface {', '\tRead(p []byte) (int, error)', '\tClose() error', '}', ''].join(
        '\n',
      ),
    );

    expect(symbols.has('type:Reader')).toBe(true);
    expect([...symbols].some((s) => s.startsWith('fn:') || s.startsWith('method:'))).toBe(false);
  });

  it('is anchored to the start of a line, so a mid-line func is not a declaration', () => {
    const symbols = symbolsOf(
      [
        'package main',
        '',
        '// See func computeTotal(items) for the arithmetic.',
        '/*',
        ' * func renderReport(p Point) is described here, not declared.',
        ' */',
        'var doc = "func inlineThing(x int) int"',
        '',
        'func real() {}',
        '',
      ].join('\n'),
    );

    expect(symbols.has('fn:real')).toBe(true);
    expect(symbols.has('fn:computeTotal')).toBe(false); // line comment
    expect(symbols.has('fn:renderReport')).toBe(false); // block comment, indented by ' * '
    expect(symbols.has('fn:inlineThing')).toBe(false); // inside a string literal
  });

  it('does take a declaration sitting at column 0 of a raw string — characterized, not fixed', () => {
    // A Go raw string can hold Go source (code generators, golden files), and a line anchor
    // cannot tell that from a declaration. Pinned rather than fixed because it errs in the
    // conservative direction: the symbol lives inside a body, so body elision removes it,
    // `R_AST` falls, and drift becomes *more* likely to refuse rather than less. A rule erring
    // the other way would be the §56 hazard over again.
    const symbols = symbolsOf(
      ['package main', '', 'const tmpl = `', 'func Generated(x int) int {', '\treturn x', '}', '`', ''].join('\n'),
    );

    expect(symbols.has('fn:Generated')).toBe(true);
  });
});

describe('the Go patterns do not reach TypeScript or Python', () => {
  const codeBundle = (content: string, path: string, language: string) =>
    createBundleFromItems(
      [createContextItem({ id: 'x', kind: 'file', content, path, language, contentType: 'code' })],
      'file',
    );

  // Measured alongside these: 0 of the 287 files in the frozen corpus match either Go pattern,
  // and the corpus A/B is 574/574 byte-identical with `symbolsBefore` unchanged on every row.
  // Byte-identical is not the same as inert (§56) — that corpus contains no Go at all, so these
  // two cases are where the blast radius is actually checked.
  it('leaves TypeScript that merely contains the letters func alone', () => {
    const symbols = tracker.extractSymbols(
      codeBundle(
        [
          '// func-style helpers live here.',
          'import { applyFunc } from "./util";',
          '',
          'export function runAll(fns: Array<() => void>): void {',
          '  for (const func of fns) {',
          '    func();',
          '  }',
          '  applyFunc(() => undefined);',
          '}',
          '',
        ].join('\n'),
        'src/thing.ts',
        'typescript',
      ),
    );

    expect(symbols.has('fn:runAll')).toBe(true);
    expect([...symbols].filter((s) => s.startsWith('fn:'))).toEqual(['fn:runAll']);
    expect([...symbols].some((s) => s.startsWith('method:'))).toBe(false);
  });

  it('leaves Python that names a parameter func alone', () => {
    const symbols = tracker.extractSymbols(
      codeBundle(
        [
          'import functools',
          '',
          'def apply(func, value):',
          '    return func(value)',
          '',
          'wrapped = functools.wraps',
          '',
        ].join('\n'),
        'thing.py',
        'python',
      ),
    );

    expect(symbols.has('fn:apply')).toBe(true);
    expect([...symbols].filter((s) => s.startsWith('fn:'))).toEqual(['fn:apply']);
    expect([...symbols].some((s) => s.startsWith('method:'))).toBe(false);
  });
});

/**
 * The step-1 negative control, as the `widen-language` skill specifies it: nothing can elide
 * yet, so reduction stays 0% everywhere, while drift on a hand-elided Go file becomes non-zero.
 * The shapes below are §56's simulation table, re-measured through the shipped tracker.
 */
describe('what the drift gate can now witness on Go', () => {
  const GO = [
    'package report',
    '',
    'import "strings"',
    '',
    'type Point struct {',
    '\tX int',
    '\tY int',
    '}',
    '',
    'func computeTotal(items []int) int {',
    '\ttotal := 0',
    '\tfor _, v := range items {',
    '\t\ttotal += v',
    '\t}',
    '\treturn total',
    '}',
    '',
    'func renderReport(p Point) string {',
    '\tvar b strings.Builder',
    '\treturn b.String()',
    '}',
    '',
    'func (p *Point) Translate(dx int, dy int) {',
    '\tp.X += dx',
    '\tp.Y += dy',
    '}',
    '',
    'func (p Point) String() string {',
    '\treturn "point"',
    '}',
    '',
  ].join('\n');

  const MARKER = '[TokenDamper: 4 code lines elided, 96 bytes, sha256:10a4b0eb949b]';

  /** What a region scanner produces: every body replaced, every signature retained. */
  const BODIES_ELIDED = [
    'package report',
    '',
    'import "strings"',
    '',
    'type Point struct {',
    '\tX int',
    '\tY int',
    '}',
    '',
    'func computeTotal(items []int) int {',
    '\t' + MARKER,
    '}',
    '',
    'func renderReport(p Point) string {',
    '\t' + MARKER,
    '}',
    '',
    'func (p *Point) Translate(dx int, dy int) {',
    '\t' + MARKER,
    '}',
    '',
    'func (p Point) String() string {',
    '\t' + MARKER,
    '}',
    '',
  ].join('\n');

  /** One whole declaration gone — a scanner that took a brace span too far. */
  const ONE_DECL_DROPPED = GO.split('\n\n')
    .filter((block) => !block.startsWith('func renderReport'))
    .join('\n\n');

  /** Every declaration gone; package, import and struct survive. */
  const ALL_DECLS_DROPPED = GO.split('\n\n')
    .filter((block) => !block.startsWith('func'))
    .join('\n\n');

  const driftOf = (after: string) => tracker.calculateDrift(goBundle(GO), goBundle(after));

  it('sees the declarations, where it used to see only a struct and an import', () => {
    const symbols = tracker.extractSymbols(goBundle(GO));

    // What §56 measured before this change: these two, and nothing else.
    expect(symbols.has('type:Point')).toBe(true);
    expect(symbols.has('import:strings')).toBe(true);

    // What it can see now.
    expect(symbols.has('fn:computeTotal')).toBe(true);
    expect(symbols.has('fn:renderReport')).toBe(true);
    expect(symbols.has('method:Point.Translate')).toBe(true);
    expect(symbols.has('method:Point.String')).toBe(true);
    expect(symbols.size).toBe(6);
  });

  it('still scores a signature-preserving elision at zero, which it must', () => {
    // This one passes with the change reverted, and that is not a weakness — it is the property
    // that lets step 3 ship at all. Region elision keeps signatures, the symbols survive, and
    // there is no semantic loss to report. What changed is that the gate can now *tell this
    // apart* from the two cases below; before, all three read 0.0000.
    const report = driftOf(BODIES_ELIDED);

    expect(BODIES_ELIDED).not.toBe(GO); // the fixture really did elide something
    expect(report.driftScore).toBe(0.0);
    expect(report.astSymbolRetentionRatio).toBe(1.0);
    expect(report.shouldFallback).toBe(false);
  });

  it('now scores a whole declaration disappearing', () => {
    const report = driftOf(ONE_DECL_DROPPED);

    // 5 of 6 symbols retained. `R_struct`'s before-set is empty for code, so it does not vote
    // and its weight is redistributed (§40): S_k = 1 - R_AST = 0.1667. Before this change the
    // same file scored 2 of 2 retained and S_k = 0.0000 — indistinguishable from the case above.
    expect(report.astSymbolRetentionRatio).toBeCloseTo(5 / 6, 4);
    expect(report.driftScore).toBeCloseTo(1 / 6, 4);
    expect(report.driftScore).toBeGreaterThan(0);
  });

  it('refuses a file whose every declaration was taken, which used to pass every gate', () => {
    const report = driftOf(ALL_DECLS_DROPPED);

    // The two survivors are exactly the symbols §56 named as incapable of witnessing this:
    // `type:Point` and `import:strings` are still there with all four functions deleted.
    expect(report.astSymbolRetentionRatio).toBeCloseTo(2 / 6, 4);
    expect(report.driftScore).toBeCloseTo(2 / 3, 4);
    expect(report.retentionGate).toBe('refuse');
    expect(report.shouldFallback).toBe(true);

    // The measurement gate passed before this change too — that was §56's whole point. It is
    // the retention gate that had nothing to work with.
    expect(report.measurementGate).toBe('pass');
    expect(report.astMeasured).toBe(true);
  });
});

describe('step 1 does not make Go elidable', () => {
  it('leaves the language-support verdict alone', () => {
    // The negative control that matters most: symbols are not the gate that decides whether
    // elision can run. `supportsRegionElision` still answers no for Go, so reduction stays
    // 0.00% until the validator and the region scanner land — and the corpus A/B agrees at
    // 574/574 byte-identical.
    const bundle = goBundle(
      'package main\n\nimport "fmt"\n\nfunc compute(items []int) int {\n\ttotal := 0\n\treturn total\n}\n',
    );

    expect(describeLanguageSupport(bundle).noneSupported).toBe(true);
  });
});
