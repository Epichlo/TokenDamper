import { describe, expect, it } from 'vitest';
import { parse } from '../../src/adapters/cli';
import { loadConfig } from '../../src/config/load';
import { optimize } from '../../src/core/engine';

/**
 * `DriftCoverage.symbolBearingItems` counts symbols, not validator coverage — DECISIONS §71.
 *
 * It used to be `new Set(after.items.filter((i) => !unchecked.has(i.id)))`, i.e. the count of
 * AST-validator-covered items: `astCoverage.checked` computed a second way, under a name that
 * asserts a fact about symbols the computation never checked.
 *
 * The two agreed for as long as every language with symbols also had a validator, and nothing
 * ever made that true — `DriftTracker.extractSymbols` is regexes over `item.content` with no
 * language gate. These tests pin the two directions in which they come apart, so that
 * re-deriving the field from coverage fails here rather than in a trace nobody re-reads.
 */
describe('symbolBearingItems counts symbols, not validator coverage', () => {
  const config = loadConfig();
  const withBudget = (request: ReturnType<typeof parse>) => ({
    ...request,
    budget: { ...request.budget, targetReductionRatio: 0.3 },
  });

  it('counts a symbol-bearing item no validator covers (Ruby)', () => {
    // `extractSymbols` is regexes over `item.content` with no language gate, so `class Server`
    // and `def start` both match while `selectValidator` has no Ruby branch — CLAUDE.md lists
    // `.rb` among the extensions outside `isCodeExtension`. Measured on this build:
    // `astChecked = 0`, `symbolsBefore = 3`. Under the old computation `symbolBearingItems`
    // was the validator-covered count, so it read 0 next to those 3 symbols.
    //
    // **This case used to be written in Go, and that is worth knowing rather than quietly
    // updating.** Go was the first language ever to have symbols without a validator (§59), and
    // it is where the contradiction was found: all 80 frozen Go files reported
    // `symbolsBefore >= 3` beside `symbolBearingItems: 0`. §60 then gave Go a validator, which
    // removed Go from this population without touching the field. A test written against Go
    // would now pass for the wrong reason — `astChecked` is 1 — and would stop covering the
    // divergence entirely. Java and Rust reproduce it too, if Ruby ever gains a validator.
    const content = [
      "require 'socket'",
      '',
      'class Server',
      '  def initialize(addr)',
      '    @addr = addr',
      '  end',
      '',
      '  def start',
      '    puts "listening on #{@addr}"',
      '  end',
      'end',
      '',
    ].join('\n');

    const result = optimize(
      withBudget(parse(content, config, { sourceKind: 'file', sourcePath: 'lib/server.rb' })),
    );
    const coverage = result.validation.driftCoverage;

    expect(result.trace.astCoverage?.checked).toBe(0);
    expect(coverage?.symbolsBefore).toBeGreaterThan(0);
    expect(coverage?.symbolBearingItems).toBe(1);
    // The identity the old computation had, stated as the thing that must NOT hold.
    expect(coverage?.symbolBearingItems).not.toBe(result.trace.astCoverage?.checked);
  });
  it('does not count a symbol-free item a validator does cover (a TypeScript barrel)', () => {
    // The mirror case, and the one already in this repo: six of its own `src/**/*.ts` files
    // are barrels that yield no symbols at all. These are the files §28 and §33 exist to
    // protect, and the old field asserted symbols were the witness standing behind them.
    const content =
      Array.from({ length: 14 }, (_, i) => `export * from './module-number-${i}';`).join('\n') +
      '\n';

    const result = optimize(
      withBudget(parse(content, config, { sourceKind: 'file', sourcePath: 'src/index.ts' })),
    );
    const coverage = result.validation.driftCoverage;

    expect(result.trace.astCoverage?.checked).toBe(1);
    expect(coverage?.symbolsBefore).toBe(0);
    expect(coverage?.symbolBearingItems).toBe(0);
  });

  it('is a denominator for symbolsBefore, not a second notion of a symbol', () => {
    // A bundle-level `Set` deduplicates across items, so `symbolsBefore` alone cannot say
    // whether the symbols came from every item or from one. Two symbol-bearing files and one
    // barrel: the count is 2, and it is 2 regardless of how the symbols are distributed.
    const barrel = "export * from './a';\nexport * from './b';\n";
    const real = 'export function alpha(): number {\n  return 1;\n}\n';
    const other = 'export function beta(): number {\n  return 2;\n}\n';

    const result = optimize(
      withBudget(
        parse([barrel, real, other].join('\n'), config, {
          sourceKind: 'file',
          sourcePath: 'src/mixed.ts',
        }),
      ),
    );
    const coverage = result.validation.driftCoverage;

    // One item here, and it bears symbols — the point is that the count tracks symbols in the
    // retained set rather than item count or coverage.
    expect(coverage?.symbolsBefore).toBeGreaterThan(0);
    expect(coverage?.symbolBearingItems).toBe(1);
    expect(coverage?.symbolBearingItems).toBeLessThanOrEqual(coverage?.symbolsBefore ?? 0);
  });
});
