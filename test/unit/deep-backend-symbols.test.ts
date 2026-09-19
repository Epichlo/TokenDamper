import { beforeAll, describe, expect, it } from 'vitest';

import { createDeepBackends } from '../../packages/deep/src/index';
import { DriftTracker } from '../../src/core/ledger/drift-tracker';
import { createContextItem } from '../../src/core/model/constructors';
import type { ParserAdapter } from '../../src/core/parser/types';

/**
 * R3 step 1 — Deep `symbols()`, measured against the shipped extractor.
 *
 * **The assertion is "equal or superset", and the direction matters.** §59 measured the hazard
 * this test exists to catch: a symbol set that is *structurally incapable of registering body
 * elision* passes every gate having witnessed nothing. Go files with a `struct` and an `import`
 * scored `S_k = 0.0000` with `astMeasured: true` while every function body in them had been
 * deleted, because `type:Point` and `import:fmt` survive body elision by construction.
 *
 * So a backend that returns *fewer* symbols is dangerous, and a backend that returns *more*
 * symbols is only safe if the extra ones are destroyed by body elision like the rest. The
 * second half is what `S_k must not fall on a hand-elided control` checks, further down.
 *
 * Nothing here is wired to elision. Step 1 ships symbols alone, which is the ordering §56
 * measured and the `widen-language` skill encodes.
 */

const shipped = new DriftTracker();
const shippedSymbols = (content: string, language: string): Set<string> =>
  shipped.extractItemSymbols(createContextItem({ id: 's', kind: 'file', content, language }));

let backends: Map<string, ParserAdapter>;

beforeAll(async () => {
  // Async work happens once, at registration. `ParserAdapter` is sync thereafter (§3.4).
  backends = new Map((await createDeepBackends()).map((b) => [b.language, b]));
});

const SOURCES: Record<string, string> = {
  typescript: [
    'import { readFileSync } from "node:fs";',
    '',
    'export interface Shape { area(): number; }',
    '',
    'export class Circle implements Shape {',
    '  constructor(private r: number) {}',
    '  area(): number { return Math.PI * this.r * this.r; }',
    '}',
    '',
    'export function makeCircle(r: number): Circle {',
    '  const c = new Circle(r);',
    '  return c;',
    '}',
    '',
    'export type Maybe<T> = T | undefined;',
    '',
  ].join('\n'),
  python: [
    'import os',
    '',
    'class Shape:',
    '    def area(self):',
    '        raise NotImplementedError',
    '',
    'def make_shape(kind):',
    '    s = Shape()',
    '    return s',
    '',
  ].join('\n'),
  go: [
    'package geometry',
    '',
    // A *grouped* import and a top-level `var`, both of which a single-line `import "math"`
    // and a var-free file hide. An earlier draft of this file used the easy shapes, passed,
    // and concealed two real disagreements.
    'import (',
    '\t"math"',
    '\t"fmt"',
    ')',
    '',
    'var Origin = 0.0',
    '',
    'type Circle struct {',
    '\tR float64',
    '}',
    '',
    'func NewCircle(r float64) *Circle {',
    '\tfmt.Println("new")',
    '\treturn &Circle{R: r}',
    '}',
    '',
    'func (c *Circle) Area() float64 {',
    '\treturn math.Pi * c.R * c.R',
    '}',
    '',
  ].join('\n'),
};

describe('the deep backend covers the four languages Fast already identifies', () => {
  it('registers exactly typescript, javascript, python and go', () => {
    expect([...backends.keys()].sort()).toEqual(['go', 'javascript', 'python', 'typescript']);
  });

  it('exposes a synchronous surface', () => {
    const ts = backends.get('typescript');
    expect(ts?.symbols('const a = 1;\n')).toBeInstanceOf(Set);
    expect(ts?.symbols('const a = 1;\n')).not.toBeInstanceOf(Promise);
  });
});

/**
 * **Equality, not superset — and the design's "equal or superset" needs this qualification.**
 *
 * A superset is only safe when the extra symbols are ones body elision destroys. The symbols a
 * parser most easily finds *extra* are the opposite: `import:` and `type:` are signature-level
 * and survive body elision by construction, so adding them raises `R_AST` toward 1 and
 * therefore *lowers* `S_k` for the same transform. That is the falling drift score §59
 * measured, arriving through the front door.
 *
 * So the target here is set equality, and every disagreement found on the way to it was read
 * rather than tuned away. Two were real and both were on Go:
 *
 *  - the shipped `jsImportRegex` cannot match a **grouped** `import ( … )` block, so it misses
 *    `import:math` and `import:fmt`. Deep found them, which *lowers* drift — refused here.
 *  - `var Origin = 0.0` at the top level: the shipped column-0 regex catches it and Deep's
 *    first draft did not, because `var_spec` is nested inside `var_declaration`. A lost symbol
 *    is the other dangerous direction — fixed.
 *
 * The first is a defect in the shipped extractor that Deep must **not** fix in R3, because R3's
 * constraint is no reduction change and fixing it would move files across the drift gate. It is
 * recorded for R4.
 */
describe('deep symbols equal the shipped extractor', () => {
  for (const [language, content] of Object.entries(SOURCES)) {
    it(`agrees exactly on ${language}`, () => {
      const deep = backends.get(language)!.symbols(content);
      const fast = shippedSymbols(content, language);

      const lost = [...fast].filter((s) => !deep.has(s)).sort();
      const extra = [...deep].filter((s) => !fast.has(s)).sort();

      expect(lost, 'symbols the shipped extractor found and deep dropped').toEqual([]);
      expect(extra, 'symbols deep invented; signature-level ones LOWER drift').toEqual([]);
    });
  }

  it('finds the declarations the shipped regexes are known to find on typescript', () => {
    const deep = backends.get('typescript')!.symbols(SOURCES.typescript!);

    expect(deep).toContain('fn:makeCircle');
    expect(deep).toContain('type:Circle');
    expect(deep).toContain('type:Shape');
    expect(deep).toContain('type:Maybe');
  });

  it('qualifies a go method by its receiver, as the shipped extractor does', () => {
    // §59: a bare `method:Area` collapses every type's `Area` into one symbol, so losing ten
    // would read as losing one. The backend must not regress that resolution.
    expect(backends.get('go')!.symbols(SOURCES.go!)).toContain('method:Circle.Area');
  });
});

/**
 * Characterization, in the style of `validator-guarantee.test.ts`: these assert what the shipped
 * extractor **cannot see**, and Deep matching that blindness is the behaviour under test.
 *
 * Go writes most package-level declarations in grouped blocks, and every shipped rule needs the
 * keyword and the name adjacent — so the shipped extractor harvests nothing from them. Measured
 * over the frozen 80-file Go corpus, emitting them anyway produced **142 extra symbols**, all of
 * them top-level and therefore retained by construction, which is the `S_k`-lowering direction
 * §59 named. After the fix: **0 extras**, and `S_k` fell on 1 of 60 transformed files, that one
 * phantom-only.
 *
 * **If a future change makes Deep see grouped declarations, these fail on purpose.** That is a
 * deliberate, separately measured move and it belongs with a re-run of the drift control, not
 * with a quiet test update.
 */
describe('deep reproduces what the shipped extractor cannot see in Go', () => {
  const grouped = [
    'package tar',
    '',
    'const (',
    '\tTypeReg = 48',
    '\tTypeDir = 53',
    ')',
    '',
    'type (',
    '\tfileMaker interface{ f() }',
    ')',
    '',
    'import (',
    '\t"math"',
    ')',
    '',
    'var _ Reader = (*reader)(nil)',
    '',
  ].join('\n');

  it('skips grouped const, type and import blocks, as the shipped regexes do', () => {
    const deep = backends.get('go')!.symbols(grouped);
    const fast = shippedSymbols(grouped, 'go');

    for (const invisible of ['var:TypeReg', 'var:TypeDir', 'type:fileMaker', 'import:math']) {
      expect(fast, `shipped extractor unexpectedly sees ${invisible}`).not.toContain(invisible);
      expect(deep, `deep must reproduce the blindness for ${invisible}`).not.toContain(invisible);
    }
  });

  it('skips a typed blank-identifier assertion, because the annotation defeats the shipped regex', () => {
    // `var _ Reader = (*reader)(nil)` — the `var:` rule needs `=` right after the name.
    expect(shippedSymbols(grouped, 'go')).not.toContain('var:_');
    expect(backends.get('go')!.symbols(grouped)).not.toContain('var:_');
  });

  it('still sees the single-line forms of all four', () => {
    const single = [
      'package tar',
      '',
      'import "math"',
      '',
      'const Single = 1',
      '',
      'type Solo struct{ n int }',
      '',
      'func Do() {}',
      '',
    ].join('\n');
    const deep = backends.get('go')!.symbols(single);

    expect(deep).toContain('import:math');
    expect(deep).toContain('var:Single');
    expect(deep).toContain('type:Solo');
    expect(deep).toContain('fn:Do');
    expect(deep).toEqual(shippedSymbols(single, 'go'));
  });
});

describe('S_k must not fall on a hand-elided control file', () => {
  /**
   * The step-1 control from §59, run per language.
   *
   * Body elision with the signature retained is what the product actually does, so this is the
   * transform the symbol set has to be able to witness. A backend scoring *lower* drift than the
   * shipped extractor here is manufacturing symbols that survive body elision — §56's hazard,
   * and the reason step 1 ships before any region scanner.
   */
  const HAND_ELIDED: Record<string, string> = {
    typescript: [
      'import { readFileSync } from "node:fs";',
      '',
      'export interface Shape { area(): number; }',
      '',
      'export class Circle implements Shape {',
      '  constructor(private r: number) {}',
      '  area(): number { return Math.PI * this.r * this.r; }',
      '}',
      '',
      'export type Maybe<T> = T | undefined;',
      '',
    ].join('\n'),
    python: ['import os', '', 'class Shape:', '    def area(self):', '        raise NotImplementedError', ''].join('\n'),
    go: [
      'package geometry',
      '',
      'import "math"',
      '',
      'type Circle struct {',
      '\tR float64',
      '}',
      '',
      'func (c *Circle) Area() float64 {',
      '\treturn math.Pi * c.R * c.R',
      '}',
      '',
    ].join('\n'),
  };

  const retention = (symbols: (c: string) => Set<string>, before: string, after: string): number => {
    const b = symbols(before);
    if (b.size === 0) return 1;
    const a = symbols(after);
    return [...b].filter((s) => a.has(s)).length / b.size;
  };

  for (const [language, before] of Object.entries(SOURCES)) {
    it(`registers the deletion on ${language} at least as strongly as the shipped extractor`, () => {
      const after = HAND_ELIDED[language]!;
      const backend = backends.get(language)!;

      const fastRetention = retention((c) => shippedSymbols(c, language), before, after);
      const deepRetention = retention((c) => backend.symbols(c), before, after);

      // Retention below 1.0 means the deletion was witnessed at all.
      expect(fastRetention, 'the shipped extractor should already see this deletion').toBeLessThan(1);
      // `S_k = 1 - R_AST` for code, so retention must not RISE — a rising retention is a
      // falling drift score, which is the failure §59 names.
      expect(deepRetention).toBeLessThanOrEqual(fastRetention);
    });
  }
});

/**
 * **The criterion above is necessary and not sufficient, and the corpus is what showed it.**
 *
 * Run over 75 transformed corpus files, `S_k` *fell* under Deep on **9 of them** — five all the
 * way to `0.0000`. Read individually, none was §59's hazard. Every one was caused by Deep
 * declining to harvest a symbol the shipped regexes had invented out of **English prose in a
 * comment**: `type:keeps` from *"the content type keeps the message concrete"*,
 * `fn:existed` from *"the before-set existed"*, `type:methods type:or type:was`. When such a
 * phantom sits inside a body the engine elides, Fast scores it as destroyed — so dropping it
 * lowers `S_k` while losing no information whatsoever.
 *
 * A raw "must not fall" comparison cannot tell that from its opposite. What separates them is
 * whether Deep **had** the symbol and retained it anyway:
 *
 *  - Deep invents an always-retained symbol -> `R_AST` rises -> §59's hazard. Found twice, in
 *    Go grouped imports and annotated top-level consts, and refused in `symbols.ts`.
 *  - Deep declines to invent a phantom -> `R_AST` rises -> harmless.
 *
 * Measured on the frozen corpus: **0** files of the first kind, 9 of the second. The tool is
 * `tools/corpus-harness/deep-drift-control.js` and it refuses a run in which nothing was
 * transformed, because two extractors compared over files nothing touched agree perfectly.
 */
describe('a fall in S_k is only safe when Deep never had the symbol', () => {
  // A doc comment inside a function body, phrased the way this repository phrases them. The
  // shipped `function\s+(\w+)` matches `function bodies` and harvests `fn:bodies`.
  const WITH_PHANTOM = [
    'export function selectRegions(src: string): number {',
    '  // This selector selects function bodies only, never a class body.',
    '  const n = src.length;',
    '  return n;',
    '}',
    '',
    'export function other(): number { return 1; }',
    '',
  ].join('\n');

  // The same file with the first body elided, signature retained — what the engine does.
  const BODY_ELIDED = [
    'export function selectRegions(src: string): number {}',
    '',
    'export function other(): number { return 1; }',
    '',
  ].join('\n');

  it('the shipped extractor harvests a symbol out of the comment prose', () => {
    expect(shippedSymbols(WITH_PHANTOM, 'typescript')).toContain('fn:bodies');
  });

  it('deep does not, because a parser knows a comment is a comment', () => {
    expect(backends.get('typescript')!.symbols(WITH_PHANTOM)).not.toContain('fn:bodies');
  });

  it('so S_k falls — and the fall is attributable entirely to the phantom', () => {
    const backend = backends.get('typescript')!;
    const fastBefore = shippedSymbols(WITH_PHANTOM, 'typescript');
    const fastAfter = shippedSymbols(BODY_ELIDED, 'typescript');
    const deepBefore = backend.symbols(WITH_PHANTOM);
    const deepAfter = backend.symbols(BODY_ELIDED);

    const fastDestroyed = [...fastBefore].filter((s) => !fastAfter.has(s));
    expect(fastDestroyed).toContain('fn:bodies');

    // The failure condition: a symbol Deep HAS, that Fast saw destroyed and Deep retained.
    const unwitnessed = fastDestroyed.filter((s) => deepBefore.has(s) && deepAfter.has(s));
    expect(unwitnessed, 'a symbol deep holds and failed to register as lost').toEqual([]);
  });
});
