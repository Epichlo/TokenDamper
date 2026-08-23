import { describe, expect, it } from 'vitest';
import { isSubstantiveRegion, selectElisionRegions, splitRegionIntoStatements } from '../../src/core/elision/regions';
import { createContextItem } from '../../src/core/model/constructors';

/**
 * Step 3 of widening elision to Go: the region scanner (DECISIONS §56, §61).
 *
 * **This is the step that changes output**, which is why it went last. §59 gave the drift gate
 * Go symbols so it can witness a scanner that takes more than a body; §60 gave Go a validator so
 * a boundary landing inside a raw string is caught as an unbalanced bracket. Both instruments
 * exist before the thing they instrument.
 *
 * The `widen-language` skill requires a scanner to pass known-answer cases *before* its output is
 * used to justify a number: the language's raw/multi-line string form, both comment forms, a
 * declaration with no body, a nested closure counted once, and a brace inside a string literal.
 * §56's Go ceiling was only trustworthy because an ad-hoc scanner passed 12 of those first; this
 * file is that set against the shipped one.
 *
 * **Against the unfixed engine, 9 of these 13 fail and 4 pass.** The 4 are the ones asserting an
 * *absence* — no region for a struct, an interface or a composite literal; none for a
 * declaration with no body; none for a signature broken across lines; and the
 * comments-and-strings guard — all of which are trivially true when the scanner selects nothing
 * at all. They are controls on over-selection, not evidence the scanner works.
 */
const goItem = (content: string) =>
  createContextItem({ id: 'g1', kind: 'file', contentType: 'code', content, path: 'report.go', language: 'go' });

/** The text each selected region covers, which is what an elision would remove. */
const regionTexts = (content: string) =>
  selectElisionRegions(goItem(content)).map((r) => content.slice(r.start, r.end));

// Bodies have to clear MIN_REGION_BYTES (104), so fixtures are padded with real statements
// rather than with one line. A fixture under the floor tests the floor, not the scanner.
const BODY = [
  '\tresult := make([]string, 0, len(items))',
  '\tfor _, item := range items {',
  '\t\tresult = append(result, strings.TrimSpace(item))',
  '\t}',
  '\treturn result',
].join('\n');

describe('the Go region scanner selects function bodies', () => {
  it('selects a plain function body, and keeps the signature and both braces outside it', () => {
    const src = ['package report', '', 'func normalize(items []string) []string {', BODY, '}', ''].join('\n');
    const regions = selectElisionRegions(goItem(src));

    expect(regions).toHaveLength(1);

    // The byte before the region is the opening brace and the byte at its end is the closing
    // one, so an elision cannot take either. Asserted on offsets rather than on the text,
    // because the body itself contains braces — `for ... {` — and always will.
    expect(src[regions[0]!.start - 1]).toBe('{');
    expect(src[regions[0]!.end]).toBe('}');

    const text = src.slice(regions[0]!.start, regions[0]!.end);
    expect(text).not.toContain('func normalize');
    expect(text).toContain('result := make');
  });

  it('selects a method body, receiver and all', () => {
    const src = ['package report', '', 'func (r *Repo) Normalize(items []string) []string {', BODY, '}', ''].join('\n');

    expect(regionTexts(src)).toHaveLength(1);
  });

  it('does not select a struct, an interface, or a composite literal', () => {
    // None of them begin with `func`, so the keyword test needs no subtraction — where the
    // TypeScript shape test needs CONTROL_FLOW_HEADER to undo its own over-matching.
    const src = [
      'package report',
      '',
      'type Point struct {',
      '\tX int',
      '\tY int',
      '\tLabel string',
      '\tExtra string',
      '\tMore  string',
      '}',
      '',
      'type Reader interface {',
      '\tRead(p []byte) (int, error)',
      '\tClose() error',
      '\tName() string',
      '\tReset() error',
      '}',
      '',
      'var defaults = Config{',
      '\tRetries: 3,',
      '\tTimeout: 30,',
      '\tVerbose: false,',
      '\tName:    "x",',
      '}',
      '',
    ].join('\n');

    expect(regionTexts(src)).toHaveLength(0);
  });

  it('does not select a declaration that has no body', () => {
    const src = [
      'package report',
      '',
      'type Handler func(int) error',
      '',
      '//go:linkname runtimeNano runtime.nanotime',
      'func runtimeNano() int64',
      '',
    ].join('\n');

    expect(regionTexts(src)).toHaveLength(0);
  });

  it('counts a nested closure once, as part of the body that contains it', () => {
    const src = [
      'package report',
      '',
      'func schedule(items []string) {',
      '\thandler := func(s string) error {',
      '\t\treturn process(strings.TrimSpace(s))',
      '\t}',
      '\tfor _, item := range items {',
      '\t\t_ = handler(item)',
      '\t}',
      '}',
      '',
    ].join('\n');
    const regions = regionTexts(src);

    // One region — the outer body. `handler := func(...)` carries the keyword mid-header, so it
    // is not a candidate, and the closure's body is inside the region already selected.
    expect(regions).toHaveLength(1);
    expect(regions[0]).toContain('handler := func');
  });

  it('is not confused by braces inside a raw string that spans lines', () => {
    // The case that makes Go need its own scanner. Under the TypeScript scanner the backslash
    // escapes the closing backtick, the literal never ends, and every brace after it is read as
    // being inside a string.
    const src = [
      'package report',
      '',
      'const tmpl = `',
      '{{if .Enabled}}',
      '  path = C:\\Users\\x\\',
      '{{end}}',
      '`',
      '',
      'func render(items []string) []string {',
      BODY,
      '}',
      '',
    ].join('\n');
    const regions = regionTexts(src);

    expect(regions).toHaveLength(1);
    expect(regions[0]).toContain('result := make');
    expect(regions[0]).not.toContain('{{if .Enabled}}');
  });

  it('is not confused by a brace in a rune literal or an interpreted string', () => {
    const src = [
      'package report',
      '',
      'func classify(c byte, s string) string {',
      "\tif c == '{' || c == '}' {",
      '\t\treturn "brace"',
      '\t}',
      '\tif strings.Contains(s, "}{") {',
      '\t\treturn "both"',
      '\t}',
      '\treturn "other"',
      '}',
      '',
    ].join('\n');
    const regions = regionTexts(src);

    expect(regions).toHaveLength(1);
    expect(regions[0]).toContain('return "other"');
  });

  it('is not confused by braces in either comment form', () => {
    const src = [
      'package report',
      '',
      '// func orphan() { — described, not declared',
      '/*',
      '#include <stdio.h>',
      'static void hello(void) {',
      '\tprintf("hi");',
      '}',
      '*/',
      'func render(items []string) []string {',
      BODY,
      '}',
      '',
    ].join('\n');

    expect(regionTexts(src)).toHaveLength(1);
  });

  it('under-selects a signature broken across lines, which is the safe direction', () => {
    // Characterized, not fixed. `scanBraceSpans` takes the header from the line carrying the
    // `{`, so this one presents as `) []string` and the keyword test misses it. Missing a region
    // costs reduction; matching the wrong one costs content.
    const src = [
      'package report',
      '',
      'func normalize(',
      '\titems []string,',
      '\tsep string,',
      ') []string {',
      BODY,
      '}',
      '',
    ].join('\n');

    expect(regionTexts(src)).toHaveLength(0);
  });

  it('refuses a body that is only comments and strings', () => {
    // `isSubstantiveRegion` through the Go stripper. This is the HumanEval/0 guard: a body whose
    // whole content is prose carries no symbols, so drift scores its removal as perfect.
    expect(isSubstantiveRegion('\n\t// explanation only\n\t/* and more of it, at length, here */\n', 'go')).toBe(false);
    expect(isSubstantiveRegion('\n\t`a raw string and nothing else at all, padded out`\n', 'go')).toBe(false);
    expect(isSubstantiveRegion('\n\ttotal := 0\n', 'go')).toBe(true);
  });
});

describe('Go statement splitting divides on newlines, not semicolons', () => {
  // `minRegionBytes: 1` on purpose. At the shipped floor (104 bytes) every span in a fixture
  // of ordinary Go lines is dropped, the division falls below MIN_DIVISION_COVERAGE and
  // `splitRegionIntoStatements` correctly returns nothing — so a fixture at the default floor
  // tests the floor rather than the boundary rule these cases are named for. The floor has its
  // own coverage in `sub-region-elision.test.ts`, and the corpus measurement in §61 exercises
  // both together at the shipped value.
  const spansOf = (content: string) => {
    const item = goItem(content);
    const region = selectElisionRegions(item)[0]!;
    return splitRegionIntoStatements(item, region, { minRegionBytes: 1 }).map((s) =>
      content.slice(s.start, s.end),
    );
  };

  it('splits a body of simple statements into one span per line', () => {
    // Gofmt-ed Go writes almost no semicolons, so the TypeScript splitter — which boundaries on
    // `;` at depth 0 — reports a body like this as one indivisible span. That is
    // `--target-reduction-ratio` overshooting again (§50), one language along.
    const src = [
      'package report',
      '',
      'func compute(items []int) int {',
      '\ttotal := 0000000000000000000000000000000',
      '\tcount := 1111111111111111111111111111111',
      '\tratio := 2222222222222222222222222222222',
      '\tvalue := 3333333333333333333333333333333',
      '\treturn total + count + ratio + value + 4',
      '}',
      '',
    ].join('\n');

    expect(spansOf(src).length).toBeGreaterThan(1);
  });

  it('keeps a multi-line call as one span, because its newlines are at depth 1', () => {
    const src = [
      'package report',
      '',
      'func report(w io.Writer, items []string) {',
      '\tfmt.Fprintf(',
      '\t\tw,',
      '\t\t"%s %s %s",',
      '\t\titems[0], items[1], items[2],',
      '\t)',
      '\tfmt.Fprintln(w, "done and dusted, at some length")',
      '}',
      '',
    ].join('\n');
    const spans = spansOf(src);

    // The `Fprintf(...)` call is one span even though it covers five lines.
    const multiline = spans.find((s) => s.includes('Fprintf'));
    expect(multiline).toBeDefined();
    expect(multiline).toContain('items[0], items[1], items[2],');
  });

  it('does not split inside a raw string that spans lines', () => {
    const src = [
      'package report',
      '',
      'func banner() string {',
      '\ttext := `',
      'line one of the banner text here',
      'line two of the banner text here',
      '`',
      '\treturn strings.TrimSpace(text) + " suffix"',
      '}',
      '',
    ].join('\n');
    const spans = spansOf(src);

    const raw = spans.find((s) => s.includes('line one'));
    expect(raw).toBeDefined();
    expect(raw).toContain('line two of the banner text here');
  });
});
