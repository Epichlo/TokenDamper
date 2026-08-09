import { describe, expect, it } from 'vitest';
import { extractProseRegions } from '../../src/core/constraints/directives';
import {
  createBundleFromItems,
  createContextItem,
  createOptimizationBudget,
  createOptimizationPlan,
} from '../../src/core/model/constructors';
import { extractConstraintDirectives } from '../../src/stages/cleanup/constraint-preservation';
import { validate } from '../../src/core/validation';

/**
 * Imperative constraints live in prose, not in expressions — audit H6.
 *
 * The keyword list (`must`, `never`, `always`, `required`, `critical`, …) is written for
 * natural-language system prompts and was applied to raw content of every kind. In source,
 * `required` and `critical` are ordinary identifiers, so the check fired on them and reverted the
 * whole run: **24 of 40 fallbacks** on the audit's corpus involved `CONSTRAINT_DIRECTIVE_LOST`.
 *
 * Measured over a frozen 293-file corpus at `targetReductionRatio: 0.3`, of the directives a run
 * reported as dropped:
 *
 *   Python       16 from comments/docstrings, **38 from code** — nearly all `logger.critical(...)`
 *   TypeScript   38 from comments/docstrings, **13 from code** — `readonly required?`, error strings
 *
 * That rules out both extremes. Trusting it everywhere keeps 51 false positives; the audit's
 * proposed "skip `code` entirely" discards 54 genuine constraints — including the Python
 * docstring case `docs/phase-1d-semantic-gate-disposition.md` measured this check to be the only
 * thing catching. The separator is the *region*, not the content type.
 *
 * Measured effect of scoping to prose regions and attributing per item: Python 14.98% -> 23.14%,
 * TypeScript 23.38% -> 27.33%, **0 rows regressed** from reducing to falling back. DECISIONS §42.
 */
describe('constraint directives are extracted from prose regions only', () => {
  describe('extractProseRegions', () => {
    it('keeps line comments and drops the executable lines around them', () => {
      const python = [
        'import logging',
        'logger = logging.getLogger(__name__)',
        '',
        '# We must initialize this before the tempdir manager.',
        'def run(config):',
        '    logger.critical("Operation cancelled by user")',
        '    return config',
      ].join('\n');

      const prose = extractProseRegions(python, 'code');

      expect(prose).toContain('We must initialize this');
      // The line that produced most of the false positives on real Python.
      expect(prose).not.toContain('logger.critical');
    });

    it('keeps Python docstrings, including their interior lines', () => {
      // This is the case the semantic-gate disposition measured as the one real catch, so it is
      // the case that would have been lost by scoping the check off `code` wholesale.
      const python = [
        'def parse(value):',
        '    """Parse a value.',
        '',
        '    The caller must normalize hyphens to underscores first.',
        '    """',
        '    return value.replace("-", "_")',
      ].join('\n');

      const prose = extractProseRegions(python, 'code');

      expect(prose).toContain('must normalize hyphens');
      expect(prose).not.toContain('value.replace');
    });

    it('keeps block comments and JSDoc continuation lines', () => {
      const ts = [
        '/**',
        ' * The hasher must be the same instance the stage used.',
        ' */',
        'export function rehydrate(hasher: TokenHasher): void {',
        '  const required = hasher.resolveAll();',
        '  return required;',
        '}',
      ].join('\n');

      const prose = extractProseRegions(ts, 'code');

      expect(prose).toContain('must be the same instance');
      expect(prose).not.toContain('hasher.resolveAll');
    });

    it('treats prose content types as prose in their entirety', () => {
      const md = '# Runbook\n\nYou must scale the consumer group before paging.\n';
      expect(extractProseRegions(md, 'markdown')).toBe(md);
      expect(extractProseRegions(md, 'text')).toBe(md);
    });
  });

  describe('what now raises a directive, and what no longer does', () => {
    it('no longer raises one for a logger.critical call', () => {
      const { directives } = extractConstraintDirectives(
        'try:\n    run()\nexcept Exception as exc:\n    logger.critical("%s", exc)\n',
        'code',
      );
      expect(directives).toEqual([]);
    });

    it('no longer raises one for a required field in a type declaration', () => {
      const { directives } = extractConstraintDirectives(
        'export interface Options {\n  readonly required?: boolean;\n}\n',
        'code',
      );
      expect(directives).toEqual([]);
    });

    it('still raises one for an imperative in a comment', () => {
      const { directives } = extractConstraintDirectives(
        '// DO NOT switch this to result.emittedOutput.\nconst body = result.finalBundle;\n',
        'code',
      );
      expect(directives.length).toBeGreaterThan(0);
      expect(directives.join(' ')).toContain('DO NOT switch this');
    });

    it('scans everything when the content type is prose', () => {
      // Regression guard on the scoping itself: prose must not acquire the code filter.
      const { directives } = extractConstraintDirectives(
        'You must never paste the API key into the issue tracker.',
        'markdown',
      );
      expect(directives.length).toBeGreaterThan(0);
    });
  });

  describe('retention is attributed to the item it came from', () => {
    const budget = createOptimizationBudget({ riskTolerance: 'low' });
    const plan = createOptimizationPlan({
      planId: 'p',
      mode: 'pass_through',
      stageIds: [],
      revalidationPoints: ['end'],
      fallbackPolicy: 'original_input',
    });

    const item = (id: string, content: string) =>
      createContextItem({ id, kind: 'file', contentType: 'code', content, path: `src/${id}.ts` });

    const DIRECTIVE = '// The hasher must be the same instance the stage used.';

    it('fails when an item loses its own directive', () => {
      const before = createBundleFromItems([item('a', `${DIRECTIVE}\nexport const a = 1;\n`)], 'text');
      const after = createBundleFromItems([item('a', 'export const a = 1;\n')], 'text');

      const report = validate(before, after, plan, budget);
      const codes = report.issues.map((i) => i.code);

      expect(codes).toContain('CONSTRAINT_DIRECTIVE_LOST');
      // Attribution: the message must say which item, which the joined-blob check could not.
      const lost = report.issues.find((i) => i.code === 'CONSTRAINT_DIRECTIVE_LOST');
      expect(lost?.message).toContain('[a]');
    });

    it('no longer accepts a copy of the string surviving in a different item', () => {
      // The joined-blob check passed here: item `a` lost its directive, but the same text
      // appeared in item `b`, so `combined.includes(directive)` was true and the loss was
      // invisible. Per-item matching makes the destruction visible.
      const before = createBundleFromItems(
        [item('a', `${DIRECTIVE}\nexport const a = 1;\n`), item('b', `${DIRECTIVE}\nexport const b = 2;\n`)],
        'text',
      );
      const after = createBundleFromItems(
        [item('a', 'export const a = 1;\n'), item('b', `${DIRECTIVE}\nexport const b = 2;\n`)],
        'text',
      );

      const report = validate(before, after, plan, budget);
      const lost = report.issues.filter((i) => i.code === 'CONSTRAINT_DIRECTIVE_LOST');

      expect(lost.length).toBe(1);
      expect(lost[0]?.message).toContain('[a]');
    });

    it('does not fail for an item the planner dropped entirely', () => {
      // Selection is not elision — the same exemption `DriftTracker.findUnwitnessedItems` makes.
      // Without it, any prunable item carrying an imperative becomes unprunable.
      const before = createBundleFromItems(
        [item('keep', 'export const keep = 1;\n'), item('drop', `${DIRECTIVE}\nexport const drop = 2;\n`)],
        'text',
      );
      const after = createBundleFromItems([item('keep', 'export const keep = 1;\n')], 'text');

      const report = validate(before, after, plan, budget);

      expect(report.issues.map((i) => i.code)).not.toContain('CONSTRAINT_DIRECTIVE_LOST');
    });
  });
});
