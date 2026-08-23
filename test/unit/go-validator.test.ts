import { describe, expect, it } from 'vitest';
import { parse } from '../../src/adapters/cli';
import { loadConfig } from '../../src/config/load';
import { optimize } from '../../src/core/engine';
import { supportsRegionElision } from '../../src/core/elision/regions';
import { createContextItem } from '../../src/core/model/constructors';
import { GoValidator, selectValidator, TypeScriptValidator, validateItemAst } from '../../src/core/validation/ast';
import { describeLanguageSupport } from '../../src/core/validation/language-support';

/**
 * Step 2 of widening elision to Go: the validator (DECISIONS §56, §60).
 *
 * **Go is still unelidable after this.** `regionElisionLanguage` needs the language to be in
 * `REGION_ELISION_LANGUAGES` as well as to have a validator, and `'go'` is not in that list
 * until step 3. What this step buys is coverage: a `.go` item stops reporting
 * `validated: false` on `trace.astCoverage` and starts being checked — §23's distinction, which
 * is the whole reason an unexamined item is not a passing one.
 *
 * **On "fails against the unfixed engine".** The usual check is weaker than normal here: the
 * class did not exist before, so reverting `src/` fails this file at import rather than at an
 * assertion. The assertions that carry real weight are the ones that could have been wrong
 * *with* the change — the differential cases below, where the TypeScript lexer flags valid Go
 * and this validator does not, and the two negative controls that Go is still not
 * region-elidable and reduction is still zero.
 *
 * The known-answer set is what the `widen-language` skill requires before an instrument's
 * output is used to justify anything: the language's raw string form, both comment forms, a
 * declaration with no body, and a brace inside a string literal. Measured on real Go
 * alongside these — 9,181 files, 1 flag, and that one is the compiler's own deliberately
 * malformed testdata. §60.
 */
const go = new GoValidator();
const ts = new TypeScriptValidator();

const accepts = (src: string) => go.validate(src).valid;

describe('GoValidator accepts valid Go', () => {
  it('accepts an ordinary file with declarations, methods and nesting', () => {
    const src = [
      'package report',
      '',
      'import (',
      '\t"fmt"',
      '\t"strings"',
      ')',
      '',
      'type Point struct {',
      '\tX int',
      '\tY int',
      '}',
      '',
      'func (p Point) String() string {',
      '\treturn fmt.Sprintf("(%d, %d)", p.X, p.Y)',
      '}',
      '',
      'func render(points []Point) string {',
      '\tvar b strings.Builder',
      '\tfor _, p := range points {',
      '\t\tif p.X > 0 {',
      '\t\t\tb.WriteString(p.String())',
      '\t\t}',
      '\t}',
      '\treturn b.String()',
      '}',
      '',
    ].join('\n');

    expect(accepts(src)).toBe(true);
  });

  it('accepts a raw string that spans lines and holds braces and quotes', () => {
    // Go's `` ` `` string has no escapes and no interpolation. This is the form a TS lexer
    // reads as a template literal.
    const src = [
      'package main',
      '',
      'const tmpl = `',
      '{{if .Enabled}}',
      '  name = "{{.Name}}"',
      '  path = C:\\Users\\x',
      '{{end}}',
      '`',
      '',
      'func use() string { return tmpl }',
      '',
    ].join('\n');

    expect(accepts(src)).toBe(true);
  });

  it('accepts a raw string holding a lone backslash', () => {
    // Real: `cmd/go/internal/fips140/fips140.go:184`. A TS lexer reads the backslash as
    // escaping the closing backtick, never closes the literal, and swallows the rest of the
    // file — which is 1 of the 72 files it flags and this one does not.
    const src = ['package main', '', 'func check(v string) bool {', '\treturn strings.Contains(v, `\\`)', '}', ''].join(
      '\n',
    );

    expect(accepts(src)).toBe(true);
    expect(ts.validate(src).valid).toBe(false); // the differential, pinned
  });

  it('accepts struct tags, which are raw strings full of quotes and colons', () => {
    const src = [
      'package main',
      '',
      'type User struct {',
      '\tName  string `json:"name" yaml:"name"`',
      '\tEmail string `json:"email,omitempty"`',
      '}',
      '',
    ].join('\n');

    expect(accepts(src)).toBe(true);
  });

  it('accepts rune literals, including the ones that are quote characters', () => {
    const src = [
      'package main',
      '',
      'func classify(c byte) string {',
      "\tif c == '\"' {",
      '\t\treturn "quote"',
      '\t}',
      "\tif c == '\\'' {",
      '\t\treturn "apostrophe"',
      '\t}',
      "\tif c == '\\\\' || c == '{' || c == '}' {",
      '\t\treturn "punct"',
      '\t}',
      '\treturn "other"',
      '}',
      '',
    ].join('\n');

    expect(accepts(src)).toBe(true);
  });

  it('accepts braces and quotes inside both comment forms', () => {
    const src = [
      'package main',
      '',
      '// func orphan() { — described, not declared, and the brace is not real',
      "// it's fine to use an apostrophe here",
      '/*',
      ' * A block comment with { unbalanced braces and a " lone quote.',
      ' */',
      'func real() {}',
      '',
    ].join('\n');

    expect(accepts(src)).toBe(true);
  });

  it('accepts a cgo C preamble, which is a block comment full of C braces', () => {
    const src = [
      'package main',
      '',
      '/*',
      '#include <stdio.h>',
      'static void hello(void) {',
      '\tprintf("hi");',
      '}',
      '*/',
      'import "C"',
      '',
      'func main() { C.hello() }',
      '',
    ].join('\n');

    expect(accepts(src)).toBe(true);
  });

  it('accepts declarations with no body', () => {
    const src = [
      'package main',
      '',
      'type Reader interface {',
      '\tRead(p []byte) (int, error)',
      '\tClose() error',
      '}',
      '',
      'type Handler func(int) error',
      '',
      '//go:linkname runtimeNano runtime.nanotime',
      'func runtimeNano() int64',
      '',
    ].join('\n');

    expect(accepts(src)).toBe(true);
  });

  it('accepts the elision marker, which step 3 will splice into bodies', () => {
    // `elideItem` renders a marker in the syntax `selectValidator` resolves, then validates the
    // result with that same validator. If this were false, every Go elision would be rejected
    // by its own post-condition.
    const marker = '[TokenDamper: 12 code lines elided, 384 bytes, sha256:10a4b0eb949b]';

    expect(accepts(marker)).toBe(true);
    expect(accepts(['package main', '', 'func compute() int {', '\t' + marker, '}', ''].join('\n'))).toBe(true);
  });

  it('does not guess at regex literals, because Go has none', () => {
    // The TS lexer treats `/` after certain tokens as starting a regex. Division is ordinary
    // arithmetic here and there is nothing to disambiguate.
    const src = ['package main', '', 'func ratio(a int, b int) int {', '\treturn a / b / 2', '}', ''].join('\n');

    expect(accepts(src)).toBe(true);
  });
});

describe('GoValidator rejects what it claims to catch', () => {
  const rejects = (src: string, code: string) => {
    const result = go.validate(src);
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain(code);
  };

  it('rejects an unclosed brace', () => {
    rejects(['package main', '', 'func broken() {', '\treturn', ''].join('\n'), 'AST_UNBALANCED_BRACKET');
  });

  it('rejects a mismatched pair', () => {
    rejects(['package main', '', 'func broken() {', '\tx := []int{1, 2)', '}', ''].join('\n'), 'AST_UNBALANCED_BRACKET');
  });

  it('rejects a closing bracket with nothing open', () => {
    rejects(['package main', '', '}', ''].join('\n'), 'AST_UNBALANCED_BRACKET');
  });

  it('rejects an interpreted string running to the end of a line', () => {
    // Go has no line-continuation form inside a string literal, so this is unterminated
    // rather than continued — the one place the rule is stricter than the TypeScript lexer's.
    rejects(['package main', '', 'var broken = "oops', 'var other = 1', ''].join('\n'), 'AST_UNTERMINATED_STRING');
  });

  it('rejects an unterminated raw string at end of input', () => {
    rejects(['package main', '', 'var tmpl = `unclosed', 'still inside', ''].join('\n'), 'AST_UNTERMINATED_STRING');
  });

  it('rejects a rune literal running to the end of a line', () => {
    rejects(['package main', '', "var c = 'x", ''].join('\n'), 'AST_UNTERMINATED_STRING');
  });

  it('rejects an unterminated block comment', () => {
    rejects(['package main', '', '/* unclosed', 'more text', ''].join('\n'), 'AST_UNTERMINATED_COMMENT');
  });

  it('reports one issue for one stray quote, not one per following line', () => {
    // The literal is cleared once reported. Without that, a single typo produces an issue on
    // every remaining line and buries whatever else is wrong.
    const src = ['package main', '', 'var broken = "oops', 'a', 'b', 'c', 'd', ''].join('\n');

    expect(go.validate(src).issues.filter((i) => i.code === 'AST_UNTERMINATED_STRING')).toHaveLength(1);
  });
});

describe('dispatch reaches the Go validator by language and by path', () => {
  const itemWith = (fields: { language?: string; path?: string }) =>
    createContextItem({ id: 'g', kind: 'file', contentType: 'code', content: 'package main\n', ...fields });

  it('selects it for a declared language, in both spellings', () => {
    expect(selectValidator(itemWith({ language: 'go' }))?.language).toBe('go');
    expect(selectValidator(itemWith({ language: 'golang' }))?.language).toBe('go');
  });

  it('selects it for a .go path with no declaration — the file route', () => {
    // `classifyContentShape` returns `contentType: 'code'` and no language for a `.go` file,
    // and `code` deliberately maps to no validator, so the path branch is what covers this.
    expect(selectValidator(itemWith({ path: 'cmd/root.go' }))?.language).toBe('go');
  });

  it('reports the item as validated, not merely as passing', () => {
    const result = validateItemAst(itemWith({ language: 'go', path: 'cmd/root.go' }));

    expect(result.validated).toBe(true);
    expect(result.validatorLanguage).toBe('go');
    expect(result.valid).toBe(true);
  });

  it('leaves the other languages where they were', () => {
    expect(selectValidator(itemWith({ language: 'typescript' }))?.language).toBe('typescript');
    expect(selectValidator(itemWith({ language: 'python' }))?.language).toBe('python');
    expect(selectValidator(itemWith({ path: 'a.py' }))?.language).toBe('python');
    expect(selectValidator(itemWith({ path: 'a.ts' }))?.language).toBe('typescript');
    // A `code` tag with no language still selects nothing: `code` is a family, not a language.
    expect(selectValidator(itemWith({}))).toBeNull();
  });
});

describe('step 2 does not make Go elidable', () => {
  const GO_SOURCE = [
    'package report',
    '',
    'import "strings"',
    '',
    'func render(items []string) string {',
    '\tvar b strings.Builder',
    '\tfor _, item := range items {',
    '\t\tb.WriteString(item)',
    '\t\tb.WriteString(", ")',
    '\t}',
    '\treturn strings.TrimSuffix(b.String(), ", ")',
    '}',
    '',
    'func count(items []string) int {',
    '\ttotal := 0',
    '\tfor _, item := range items {',
    '\t\ttotal += len(item)',
    '\t}',
    '\treturn total',
    '}',
    '',
  ].join('\n');

  const item = createContextItem({
    id: 'g1',
    kind: 'file',
    contentType: 'code',
    content: GO_SOURCE,
    path: 'report.go',
    language: 'go',
  });

  it('has a validator and still no region selector', () => {
    // The two gates `supportsRegionElision` combines. Step 2 moves the first and not the
    // second: `'go'` joins `REGION_ELISION_LANGUAGES` in step 3, not here.
    expect(selectValidator(item)?.language).toBe('go');
    expect(supportsRegionElision(item)).toBe(false);
  });

  it('still reports the language as unsupported', () => {
    const report = describeLanguageSupport({ items: [item] } as never);

    expect(report.noneSupported).toBe(true);
    expect(report.unsupportedLanguages).toContain('go');
  });

  it('returns Go byte-identical through the engine, now with the check recorded as run', () => {
    const config = loadConfig();
    const request = parse(GO_SOURCE, config, { sourceKind: 'stdin', language: 'go' });
    const result = optimize({ ...request, budget: { ...request.budget, targetReductionRatio: 0.3 } });

    // The step-2 negative control: coverage moves, output does not.
    expect(result.trace.astCoverage).toEqual({ checked: 1, unchecked: 0, uncheckedContentTypes: [] });
    expect(result.emittedOutput).toBe(GO_SOURCE);
    expect(result.trace.tokenAfter).toBe(result.trace.tokenBefore);
  });
});
