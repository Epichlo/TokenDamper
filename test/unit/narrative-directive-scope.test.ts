import { describe, expect, it } from 'vitest';
import { extractConstraintDirectives } from '../../src/stages/cleanup/constraint-preservation';
import { isNarrativeUse } from '../../src/core/constraints/directives';

/**
 * The constraint gate refuses to lose an imperative, and it is the cause of **29 of 29**
 * code-bucket fallbacks on the frozen corpus. H6 (§42) scoped it by region — an instruction
 * lives in a comment, not an expression. This scopes it by *mood* within a comment, because a
 * comment is also where a codebase narrates its own history.
 *
 * **The load-bearing half of this file is the negative control.** Narrowing a gate that protects
 * content can only be justified if the things it protects still fire, so every sentence below
 * that carries a real instruction is asserted to survive the change. A rule that drops one of
 * those is not a better rule at any reduction figure.
 */

const directivesFor = (line: string): ReadonlyArray<string> =>
  extractConstraintDirectives(`// ${line}`, 'code').directives;

describe('narrative uses of never/always are not directives', () => {
  // Verbatim from the corpus fallbacks these were measured on.
  const narrative = [
    'The MCP branch of `runCli` has always read these two',
    'It never did: this branch bypassed pruning entirely whenever only a ratio was set',
    '`HTTP_PROXY` and `HTTPS_PROXY` used to be set here too, and could never have worked',
    'a saving that never reached the wire (audit C4)',
    '`findUnwitnessedItems` has always exempted an item absent from `after`',
    'That is invariant 10 shape — a clean result from something that never looked',
    'this had always been the behaviour before the fix landed',
    'the emitter and the matcher never agreed',
  ];

  for (const line of narrative) {
    it(`does not raise a directive for: ${line.slice(0, 48)}…`, () => {
      expect(isNarrativeUse(line)).toBe(true);
      expect(directivesFor(line)).toHaveLength(0);
    });
  }
});

describe('the negative control: real instructions still fire', () => {
  // If any of these stops producing a directive, the narrowing has cost content and must be
  // reverted rather than tuned. Several are taken verbatim from this repository's own source.
  const instructions = [
    'Rule 1: Never hash items matching preserveKinds in OptimizationBudget',
    'never call this twice',
    'Installations or downloads using dist restrictions must not combine',
    'get_not_required must be called firstly in order to find and',
    'unknown string must not throw here, because this sits inside the fail-open path',
    'Do not canonicalize this value with e',
    'This must be done in a second pass, as the pyproject metadata is not yet known',
    'File must have a valid wheel or sdist name',
    'The backend must build a fresh instance representing',
    'Both sides must measure the same kind of thing, or the ratio is meaningless',
    'always pass the ledger explicitly, or turn 2 falls back',
    'this must have been called before the stage runs',
    'never elide an item carrying structured content',
    'make sure to freeze the metadata before returning it',
    'only if the candidate re-validates may it be adopted',
    'except when the item is pinned, in which case it bypasses the knapsack',
  ];

  for (const line of instructions) {
    it(`still raises a directive for: ${line.slice(0, 48)}…`, () => {
      expect(directivesFor(line)).toHaveLength(1);
    });
  }
});

describe('the narrowing is scoped to never/always only', () => {
  it('leaves `must` in a perfect construction alone — a requirement about a past state', () => {
    // "must have been" is an instruction, not a narrative. Applying the perfect-tense test to
    // `must` would drop it, which is exactly the failure this scoping exists to prevent.
    expect(directivesFor('the ledger must have been created per request')).toHaveLength(1);
  });

  it('keeps a segment where one keyword is narrative and another instructs', () => {
    const line = 'this has always been true, so you must call it first';
    expect(isNarrativeUse(line)).toBe(true);
    // Unanimity is required before dropping: the `must` keeps it.
    expect(directivesFor(line)).toHaveLength(1);
  });

  it('leaves descriptive present-tense uses firing, deliberately', () => {
    // "is always" and "do not support" describe behaviour rather than instruct, but the line
    // between describing a constraint and stating one is blurry, and a wrong call here deletes
    // a real directive. Under-narrowing costs reduction; over-narrowing costs content.
    expect(directivesFor('the spinner is always non-interactive under logging')).toHaveLength(1);
    expect(directivesFor('check for VCS schemes that do not support lookup')).toHaveLength(1);
  });
});

describe('the scoping from H6 still holds', () => {
  it('does not raise a directive from an expression, narrative or not', () => {
    expect(extractConstraintDirectives('logger.critical(exc)', 'code').directives).toHaveLength(0);
    expect(extractConstraintDirectives('const required = true;', 'code').directives).toHaveLength(0);
  });

  it('still reads prose content in full', () => {
    expect(extractConstraintDirectives('You must not delete the manifest.', 'text').directives).toHaveLength(1);
  });
});
