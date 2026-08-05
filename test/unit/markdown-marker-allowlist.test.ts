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
 * markers between them, and 132 files over stdin plus 40 over the file route plus both
 * Gateway turns are byte-identical before and after. It is worth having because the trap is
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
 * A characterization test. Read this before trusting it: **these assertions pass, and a
 * passing assertion is a specification.** Nothing in the harness marks them as pending —
 * no `.skip`, no `.fails`, no `.todo` — so the only thing distinguishing "this is wrong" from
 * "this is the contract" is the name of this block and the paragraph you are reading.
 *
 * The mechanism is that they will *begin* failing the moment someone fixes the defect, which
 * forces the encounter. That is real, but it is the opposite of the "deliberately failing
 * assertion" the 4b.3 commit message described, and the difference matters: right now the
 * suite asserts `structMeasured: true` on a 99%-deleted shell script as correct behaviour.
 * Making that structural rather than nominal is open work — see
 * `docs/phase-4b-lever-disposition.md` §0.
 *
 * Found while measuring 4b.3, which is scoped to `text`/`unknown` and therefore cannot fix it:
 * `looksLikeMarkdown` fires on a single `#` heading, so **every hash-commented shell script is
 * classified `markdown`** and its comment lines are harvested as headings by construction —
 * 591 of them across 9 frozen shell scripts, 45 more across the 4 `pip` files 4b.2's probe
 * declines.
 *
 * The harm is not the inflated drift. It is that the fabricated markers **forge the evidence
 * that drift was measured at all**: `DriftCoverage.structMeasured` goes true on the strength
 * of markers that are all comment lines, so §28's reporting — added precisely so this class
 * would be visible — reports the item as witnessed while it is deleted whole.
 *
 * Fixing it means deciding what drift owes an item no validator covers, which §28 deferred as
 * a product question about prose. This is the same question arriving with a much worse
 * example: not prose, but real code in every language the AST-lite suite does not implement.
 */
describe('KNOWN DEFECT: hash-commented code is markdown, and its comments forge the evidence', () => {
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

  it('classifies it as markdown and reads its comments as headings', () => {
    const bundle = parse(SHELL, loadConfig(), { sourceKind: 'stdin' }).bundle;
    const item = bundle.items[0]!;

    expect(item.contentType).toBe('markdown');

    const headings = [...tracker.extractContentMarkers(bundle)].filter((marker) =>
      marker.startsWith('heading:'),
    );
    // Every one of these is a `#` comment line in a shell script.
    expect(headings.length).toBeGreaterThan(0);
    expect(headings.some((heading) => heading.includes('Copyright'))).toBe(true);
  });

  it('reports structMeasured on those fabricated markers while nothing validated the item', () => {
    const request = parse(SHELL, loadConfig(), { sourceKind: 'stdin' });
    const result = optimize({
      ...request,
      budget: { ...request.budget, targetReductionRatio: 0.3 },
    });

    // Invariant 10: the pipeline must actually have run, or everything below is vacuous.
    expect(result.trace.stageCount).toBeGreaterThan(0);

    // Nothing looked at it — there is no shell validator, and §17 declines to guess.
    expect(result.trace.astCoverage).toEqual({
      checked: 0,
      unchecked: 1,
      uncheckedContentTypes: ['markdown'],
    });

    // …yet drift reports that it measured retention, on comment lines.
    expect(result.validation.driftCoverage?.structMeasured).toBe(true);
    expect(result.validation.driftCoverage?.measured).toBe(true);
    expect(result.validation.driftCoverage?.contentMarkersBefore).toBeGreaterThan(0);
    expect(result.validation.driftCoverage?.unwitnessedItems).toEqual([]);
  });
});
