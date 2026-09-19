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

  it('leaves Axis B firing, deliberately', () => {
    // `do not support` describes behaviour rather than instructs, but it is one of the seven
    // keyword families §52 never touched and Axis A does not either. Under-narrowing costs
    // reduction; over-narrowing costs content, and this gate protects content.
    expect(directivesFor('check for VCS schemes that do not support lookup')).toHaveLength(1);
    expect(directivesFor('the field is required by the schema')).toHaveLength(1);
  });
});

describe('Axis A: present-tense descriptive never/always', () => {
  // A third-person `-s` verb cannot be an imperative. English imperatives are bare infinitives,
  // so `never happens` is provably a description in the way §52 required: from the words present,
  // not from a judgement about tone. 99 of 322 unexempted never/always segments on the frozen
  // corpus take this shape.
  const thirdPerson = [
    'the planner never returns an empty stageIds array here',
    'the cache always expires after the TTL window',
    'that branch never reaches the wire on a loopback bind',
    'the fallback always echoes the caller bytes',
  ];

  for (const line of thirdPerson) {
    it(`does not raise a directive for a third-person description: ${line.slice(0, 40)}...`, () => {
      expect(directivesFor(line)).toHaveLength(0);
    });
  }

  // A copula states a property. 39 of 322 take this shape.
  const copula = [
    'the spinner is always non-interactive under logging',
    'the estimator is never exact for cache boundaries',
    'these two fields are always populated together',
  ];

  for (const line of copula) {
    it(`does not raise a directive for a stated property: ${line.slice(0, 40)}...`, () => {
      expect(directivesFor(line)).toHaveLength(0);
    });
  }

  it('exempts a verb that has no imperative at all', () => {
    // `happen`, `occur`, `exist` are unaccusative — they have no agent, so there is no one to
    // instruct and no imperative form to confuse. You cannot tell code "never happen". This is
    // the shape CLAUDE.md records as dominating Go's fallbacks (`// Should never happen, but we`),
    // and it is exempted by the verb rather than by the modal in front of it.
    expect(directivesFor('this should never happen, but we guard it anyway')).toHaveLength(0);
    expect(directivesFor('a cycle can never occur in a linear pipeline')).toHaveLength(0);
  });

  it('leaves a modal alone, because should-never is both moods', () => {
    // `should never happen` describes; `should never call this` instructs. Both are modal +
    // never + bare verb, so a modal cannot discriminate them. 38 segments are left firing on
    // purpose - this is the blurry line §52 declined to cross and Axis A declines too.
    expect(directivesFor('you should never call this without the lock held')).toHaveLength(1);
    expect(directivesFor('callers must always drain the stream first')).toHaveLength(1);
  });

  it('keeps a bare-verb imperative firing next to the -s rule', () => {
    // The discriminator is the `-s`, so the imperative form of the same verb must survive.
    expect(directivesFor('never return a placeholder from this path')).toHaveLength(1);
    expect(directivesFor('this never returns a placeholder')).toHaveLength(0);
  });

  it('refuses to exempt a segment where only one occurrence is narrative', () => {
    // §52 tested the whole segment, so any narrative construction anywhere exempted everything
    // in it. Axis A matches far more shapes, which turns that into a live way to delete an
    // instruction: here `never happens` would have carried `never call it` out with it.
    expect(directivesFor('it never happens, so never call it directly')).toHaveLength(1);
    expect(directivesFor('the value is always set, so always check it first')).toHaveLength(1);
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
