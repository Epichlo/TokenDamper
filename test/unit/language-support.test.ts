import { describe, expect, it } from 'vitest';
import { optimize } from '../../src/core/engine';
import {
  createContextBundle,
  createOptimizationBudget,
  createOptimizationRequest,
} from '../../src/core/model/constructors';
import { DEFAULT_CONFIG } from '../../src/config/schema';
import { validate } from '../../src/core/validation';
import { describeLanguageSupport } from '../../src/core/validation/language-support';
import type { OptimizationPlan } from '../../src/core/model/types';

/**
 * Audit H2 — twelve of nineteen recognised languages cannot produce a non-zero reduction under
 * any flag combination, and a user seeing 0% had no way to tell that apart from a file with
 * nothing worth compressing. Those two call for different responses and looked identical.
 *
 * The decision taken was to keep accepting every language and **report why**, rather than narrow
 * the accepted set: pass-through is byte-identical and harmless, so refusing it would remove a
 * working behaviour to make a point. This is the same correction M5a made for budgets.
 */

const JS_BODY = 'function alpha(a){ return a + 1; }\nfunction beta(b){ return b * 2; }\n';
const PY_BODY = 'def alpha(a):\n    return a + 1\n\ndef beta(b):\n    return b * 2\n';
const GO_BODY = 'package x\n\nfunc alpha(a int) int {\n\treturn a + 1\n}\n';
// Rust replaces Go as the "has an incidental symbol, still cannot reduce" example: a `struct`
// yields `type:Point` through the TypeScript class regex, and there is no Rust region scanner.
const RS_BODY = 'struct Point { x: i32, y: i32 }\n\nfn alpha(a: i32) -> i32 { a + 1 }\n';

const bundleFor = (body: string, path: string, language?: string) =>
  createContextBundle(body, 'file', path, undefined, language);

const PLAN: OptimizationPlan = {
  planId: 'p',
  mode: 'topology_knapsack',
  stageIds: Object.freeze([]),
  revalidationPoints: Object.freeze(['end']),
  fallbackPolicy: 'original_input',
};

describe('which languages elision can reduce (H2)', () => {
  // The ones that can, and a representative spread of those that cannot. Kept as one table so
  // the ratio is visible: this was the audit's "three of nineteen" headline, and it is now
  // four — Go landed in DECISIONS §61. The table is the assertion; update it when that changes.
  const cases: ReadonlyArray<readonly [string, string, string, boolean]> = [
    ['typescript', 'x.ts', JS_BODY, true],
    ['javascript', 'x.js', JS_BODY, true],
    ['python', 'x.py', PY_BODY, true],
    ['go', 'x.go', GO_BODY, true],
    ['rust', 'x.rs', JS_BODY, false],
    ['c', 'x.c', JS_BODY, false],
    ['java', 'x.java', JS_BODY, false],
    ['shell', 'x.sh', JS_BODY, false],
    ['sql', 'x.sql', JS_BODY, false],
    ['css', 'x.css', JS_BODY, false],
    ['json', 'x.json', '{"alpha":1,"beta":2}', false],
    ['markdown', 'x.md', '# Title\n\nSome prose that goes on for a little while.', false],
    ['yaml', 'x.yaml', 'alpha: 1\nbeta: 2\n', false],
  ];

  for (const [language, path, body, expected] of cases) {
    it(`${language} is ${expected ? '' : 'not '}reducible by elision`, () => {
      const report = describeLanguageSupport(bundleFor(body, path, language));
      expect(report.supported).toBe(expected ? 1 : 0);
      expect(report.unsupported).toBe(expected ? 0 : 1);
      expect(report.noneSupported).toBe(!expected);
    });
  }

  it('is four of the thirteen probed, matching the corpus', () => {
    // The corpus agrees independently: python, typescript and go reduce; shell, perl, tcl, c,
    // rust and css are 0.00% on both routes. A predicate that disagreed with that would be
    // wrong however reasonable it looked.
    //
    // Was three until DECISIONS §61. Measured on a frozen 80-file Go corpus at target 0.3,
    // application Go reduces 27.46% and the stdlib 19.42%, against this repo's TypeScript at
    // 21.22% — so the newest language is also the strongest one, which is what §56 projected.
    const supported = cases.filter(([lang, path, body]) => describeLanguageSupport(bundleFor(body, path, lang)).supported > 0);
    expect(supported.map(([lang]) => lang)).toEqual(['typescript', 'javascript', 'python', 'go']);
  });

  it('does not mistake an incidental symbol match for support', () => {
    // The first version of this predicate asked "does the item yield symbols or markers?" and
    // called Go supported, because a trivial Go file yielded exactly one symbol: `import:fmt`,
    // matched by the TypeScript import regex. It witnessed nothing about the function bodies,
    // and Go could not reduce. The gate to ask about is the one that actually decides.
    //
    // **Go stopped being the example in §61, when the region scanner landed and it started
    // reducing for real.** Rust is the same shape today, and the reasoning is unchanged: a
    // `struct` yields `type:Point` by the same incidental match, and there is no Rust scanner,
    // so the symbol says nothing about whether elision can do anything.
    const rust = 'struct Point { x: i32 }\n\nfn compute(items: &[i32]) -> i32 {\n    items.len() as i32\n}\n';
    expect(describeLanguageSupport(bundleFor(rust, 'a.rs', 'rust')).noneSupported).toBe(true);
  });
});

describe('the report reaches the caller (H2)', () => {
  it('validate() reports an info issue naming the language, and does not fail the run', () => {
    // Rust rather than Go since §61 — Go is elidable now, so it no longer raises this issue.
    const bundle = bundleFor(RS_BODY, 'a.rs', 'rust');
    const report = validate(bundle, bundle, PLAN, createOptimizationBudget({}));

    const issue = report.issues.find((i) => i.code === 'LANGUAGE_NOT_ELIDIBLE');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('info');
    expect(issue!.message).toContain('rust');
    // Informational, not a verdict — an unsupported language passes through correctly.
    expect(report.passed).toBe(true);
    expect(report.shouldFallback).toBe(false);
  });

  it('says nothing for a language elision can reduce', () => {
    const bundle = bundleFor(JS_BODY, 'a.ts', 'typescript');
    const report = validate(bundle, bundle, PLAN, createOptimizationBudget({}));
    expect(report.issues.find((i) => i.code === 'LANGUAGE_NOT_ELIDIBLE')).toBeUndefined();
    expect(report.languageSupport?.noneSupported).toBe(false);
  });

  it('survives every whitelist between validate() and the trace', () => {
    // **This is the regression guard, and it is not hypothetical.** The field has to pass through
    // four separate object literals that each enumerate their keys — `validate`'s return,
    // `createValidationReport`, `buildTrace` and `createOptimizationTrace`. Three of them dropped
    // it silently while it was being developed, and the symptom each time was
    // `trace.languageSupport: undefined` with everything else correct. Asserting on the trace,
    // rather than on `validate()`, is what catches that.
    const config = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, targetReductionRatio: 0.5 } };
    const request = createOptimizationRequest(RS_BODY, config, {
      requestId: 'h2-trace',
      adapterName: 'test',
      adapterVersion: '1',
      source: 'file',
      sourcePath: 'a.rs',
      language: 'rust',
    });

    const result = optimize(request, {});
    expect(result.trace.languageSupport).toBeDefined();
    expect(result.trace.languageSupport!.noneSupported).toBe(true);
    expect(result.trace.languageSupport!.unsupportedLanguages).toContain('rust');
  });

  it('carries its explanation inside the report, not alongside it', () => {
    // The CLI writes the trace to stderr as a JSON document and consumers parse the whole
    // stream — `test/integration/cli.test.ts` and `byte-identity-fallback.test.ts` both do.
    // A first attempt at H2 printed a friendly notice line *before* the JSON and broke four of
    // them: stderr stopped being parseable. The explanation belongs in a field.
    const bundle = bundleFor(RS_BODY, 'a.rs', 'rust');
    const report = describeLanguageSupport(bundle);
    expect(report.reason).toMatch(/Elision cannot reduce rust/);

    // And nothing is emitted for a supported language, so the field stays absent rather than
    // carrying an empty string.
    expect(describeLanguageSupport(bundleFor(JS_BODY, 'a.ts', 'typescript')).reason).toBeUndefined();
  });
});
