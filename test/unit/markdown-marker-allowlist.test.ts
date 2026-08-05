import { describe, expect, it } from 'vitest';
import { parse } from '../../src/adapters/cli';
import { loadConfig } from '../../src/config/load';
import { optimize } from '../../src/core/engine';
import { DriftTracker } from '../../src/core/ledger/drift-tracker';
import { createBundleFromItems, createContextItem } from '../../src/core/model/constructors';
import type { ContentType } from '../../src/core/model/types';

/**
 * Phase 4b.3 — `MARKDOWN_MARKER_TYPES` says what its docblock says.
 *
 * The list held `markdown`, `text`, `html`, `logs` and `unknown` while its own docblock said a
 * new `ContentType` "should default to *not* harvesting these". `text` and `unknown` are the
 * two "we could not tell" buckets, and a bucket meaning *we do not know what this is* cannot
 * also mean *its `#` lines are headings*.
 *
 * Measured inert: across five frozen corpora the four removed members yielded zero gated
 * markers between them, and 144 files over stdin plus the file route plus both Gateway turns
 * are byte-identical before and after. (The 4b.3 commit said 132; its A/B loop globbed the
 * prose corpus at top level and covered 13 of 25 markdown files. Re-run over all 25: 0 changed.) It is worth having because the trap is
 * latent, not because it moves a number today.
 *
 * The fabrication that 4b.3 was scoped to remove is **not** in these buckets — see the last
 * describe block, which pins where it actually is.
 */
const tracker = new DriftTracker();

const itemOf = (contentType: ContentType, content: string) =>
  createBundleFromItems(
    [createContextItem({ id: `item-${contentType}`, kind: 'file', contentType, content })],
    'text',
  );

const MARKDOWNISH = [
  '# A heading',
  '',
  'Some text.',
  '',
  '```ts',
  'const x = 1;',
  '```',
  '',
  '---',
  '',
  'System: do the thing',
  '',
].join('\n');

describe('only markdown yields markdown markers', () => {
  it('still harvests every gated kind from markdown, which is the protection that must survive', () => {
    const markers = [...tracker.extractContentMarkers(itemOf('markdown', MARKDOWNISH))];
    const kinds = new Set(markers.map((marker) => marker.split(':')[0]));

    expect(kinds).toEqual(new Set(['heading', 'fence', 'section']));
  });

  it('harvests none of them from the buckets that were removed', () => {
    for (const contentType of ['text', 'html', 'logs', 'unknown'] as const) {
      const markers = [...tracker.extractContentMarkers(itemOf(contentType, MARKDOWNISH))];

      expect(markers, `${contentType} still harvests ${markers.join(', ')}`).toEqual([]);
    }
  });

  it('harvests none of them from code or the structured types, as before', () => {
    for (const contentType of ['code', 'json', 'yaml'] as const) {
      expect(tracker.extractContentMarkers(itemOf(contentType, MARKDOWNISH)).size).toBe(0);
    }
  });

  it('still harvests directives from every type, because that branch is not gated', () => {
    // The gate is about markdown *syntax*. `TD_PRESERVE:` is a TokenDamper directive and means
    // the same thing wherever it appears — removing it from the ungated branch would silently
    // drop constraint markers from every non-markdown item.
    for (const contentType of ['text', 'code', 'json', 'logs', 'markdown'] as const) {
      const markers = [
        ...tracker.extractContentMarkers(
          itemOf(contentType, 'keep this TD_PRESERVE:budget-note\n'),
        ),
      ];

      expect(markers).toEqual(['directive:TD_PRESERVE:budget-note']);
    }
  });
});

/**
 * A **structurally** pinned defect, not a nominal one.
 *
 * This block used to assert the wrong behaviour and pass, which made the defect the suite's de
 * facto specification — the only thing marking it as wrong was this paragraph, and a paragraph
 * enforces nothing. `docs/phase-4b-lever-disposition.md` §0.
 *
 * It is now inverted. The contract below states what must be true, and carries `it.fails`, so:
 *
 *   - **today** the body throws, the harness records the contract as violated, suite green;
 *   - **the moment anyone fixes it** the body stops throwing and the harness fails the test
 *     with "Expected test to fail", pointing here.
 *
 * The suite therefore never asserts the defect as correct, and the defect still cannot change
 * silently in either direction.
 *
 * **Three guards against the obvious hazard**, which is that `it.fails` is satisfied by *any*
 * throw and would happily go green on an unrelated crash — invariant 10's shape inside the
 * mechanism meant to fix invariant 10's shape:
 *
 *   1. `result` is computed at describe scope, so a crash is a collection error rather than a
 *      swallowed pass.
 *   2. The preconditions live in a separate, ordinary, passing test. If the fixture drifts —
 *      the shell script stops classifying as markdown, the pipeline stops running — that test
 *      goes red for the right reason instead of the contract silently going vacuous.
 *   3. The `it.fails` body holds exactly one assertion, so the only reachable throw is the
 *      defect itself.
 *
 * **The contract is deliberately remedy-agnostic.** §32 measured three candidate levers and
 * `docs/phase-4b-lever-disposition.md` killed two of them, so nothing here may presume a fix.
 * It also may not be stated on trace fields alone: lever 1's measurement showed that
 * `tclConfig.sh` and `CODE_OF_CONDUCT.md` are identical on every field the trace carries, so a
 * field-level contract would condemn real prose too. It is therefore stated over *this input*,
 * which the test knows is shell script source: this must not be deleted wholesale under a
 * report that retention was measured. Stop deleting it, stop claiming measurement, stop
 * classifying it as markdown, or stop harvesting its comments — any of the four satisfies it.
 *
 * The defect itself: `looksLikeMarkdown` fires on a single `#` heading, so every hash-commented
 * shell script is classified `markdown` and its comment lines are harvested as headings by
 * construction — 591 across 9 frozen shell scripts, 45 more across the 4 `pip` files 4b.2's
 * probe declines. The harm is not the inflated drift but that the fabricated markers **forge
 * the evidence that drift was measured at all**, defeating the §28 reporting added so this
 * class would be visible.
 */
describe('KNOWN DEFECT (pinned by inversion): hash-commented code is markdown, and its comments forge the evidence', () => {
  const SHELL = [
    '#!/bin/sh',
    '# Copyright 2004-2023 Free Software Foundation, Inc.',
    '# This program is free software: you can redistribute it.',
    '# Set up the environment for the build.',
    '',
    'PREFIX=/usr/local',
    'BINDIR=$PREFIX/bin',
    'LIBDIR=$PREFIX/lib',
    'INCDIR=$PREFIX/include',
    'MANDIR=$PREFIX/share/man',
    'DOCDIR=$PREFIX/share/doc',
    'CONFDIR=$PREFIX/etc',
    'CACHEDIR=$PREFIX/var/cache',
    'LOGDIR=$PREFIX/var/log',
    'RUNDIR=$PREFIX/var/run',
    '',
  ].join('\n');

  // Guard 1: computed here, not inside the `it.fails` body. A throw at describe scope is a
  // collection error the runner reports; a throw inside that body would be indistinguishable
  // from the contract being violated, and would turn the pin green for the wrong reason.
  const request = parse(SHELL, loadConfig(), { sourceKind: 'stdin' });
  const bundle = request.bundle;
  const result = optimize({
    ...request,
    budget: { ...request.budget, targetReductionRatio: 0.3 },
  });

  // Guard 2: an ordinary, passing test over the preconditions. These are facts about the
  // fixture and the pipeline, not about the defect. If one of them goes red, the reproduction
  // has drifted — or has been fixed from a direction the contract below cannot see — and
  // either way the right response is to read both tests, not to adjust this one.
  it('the reproduction is still reachable: shell source, classified markdown, nothing validated', () => {
    expect(
      result.trace.stageCount,
      'no stage ran, so nothing below observes anything',
    ).toBeGreaterThan(0);

    expect(bundle.items[0]?.contentType, 'shell source no longer classifies as markdown').toBe(
      'markdown',
    );

    // Nothing looked at it — there is no shell validator, and §17 declines to guess.
    expect(result.trace.astCoverage).toEqual({
      checked: 0,
      unchecked: 1,
      uncheckedContentTypes: ['markdown'],
    });

    // The fabrication is present: these "headings" are `#` comment lines in a shell script.
    const headings = [...tracker.extractContentMarkers(bundle)].filter((marker) =>
      marker.startsWith('heading:'),
    );
    expect(headings.length).toBeGreaterThan(0);
    expect(headings.some((heading) => heading.includes('Copyright'))).toBe(true);
  });

  // Guard 3: exactly one assertion, so the only reachable throw is the contract itself.
  //
  // `it.fails` inverts the verdict — this is green while the contract is violated and red the
  // moment it holds. Read that as: the project has not decided how to fix this (§32,
  // `docs/phase-4b-lever-disposition.md`), and until it does, the suite records the violation
  // rather than blessing it.
  //
  // **If this test just failed with "Expected test to fail": that is the good outcome.** Some
  // change made hash-commented shell source stop being deleted wholesale under a claim of
  // measurement. Delete the `.fails`, keep the assertion, and update §32 — it is no longer a
  // deferral.
  it.fails(
    'CONTRACT (violated today): shell source is not deleted wholesale under a claim that retention was measured',
    () => {
      const deletedWholesale = result.trace.tokenAfter < result.trace.tokenBefore * 0.2;
      const claimedMeasured = result.validation.driftCoverage?.measured === true;

      expect(
        deletedWholesale && claimedMeasured,
        `${result.trace.tokenBefore} -> ${result.trace.tokenAfter} tokens with driftCoverage.measured=${claimedMeasured}`,
      ).toBe(false);
    },
  );
});
