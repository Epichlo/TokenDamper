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

  // **This test's premise was narrowed by H5, and the narrowing is not the same as gating it by
  // content type.** It read: "`TD_PRESERVE:` is a TokenDamper directive and means the same thing
  // wherever it appears — removing it from the ungated branch would silently drop constraint
  // markers from every non-markdown item." That reasoning still holds and is still asserted: the
  // directive is harvested from every content *type*, including code.
  //
  // What changed is the *region*. Scanned over raw content the pattern matched its own
  // implementation — `src/core/ledger/drift-tracker.ts` and `src/cli/html-reporter.ts` each
  // acquired a marker from a regex literal mentioning the directive. Since `R_struct` is a
  // bundle-scoped set, one phantom marker being elided drove it to 0 and took a 16-file batch to
  // `S_k = 0.4053` on a run whose real symbol retention was 99.1%. A directive is an instruction,
  // and instructions live in prose — the same argument as DECISIONS §42, applied here. §43.
  it('harvests directives from every content type, but only from prose regions', () => {
    for (const contentType of ['text', 'json', 'logs', 'markdown'] as const) {
      const markers = [
        ...tracker.extractContentMarkers(
          itemOf(contentType, 'keep this TD_PRESERVE:budget-note\n'),
        ),
      ];

      expect(markers).toEqual(['directive:TD_PRESERVE:budget-note']);
    }

    // In code the directive must be in a comment, which is where an instruction to a reader is.
    expect([
      ...tracker.extractContentMarkers(itemOf('code', '// keep this TD_PRESERVE:budget-note\n')),
    ]).toEqual(['directive:TD_PRESERVE:budget-note']);

    // …and an expression that merely mentions the pattern is not a directive. This is the exact
    // shape that was failing real batches.
    expect(
      tracker.extractContentMarkers(
        itemOf('code', 'const directiveMatch = /(TD_PRESERVE:[^\\s>\\n]+)/g;\n'),
      ).size,
    ).toBe(0);
  });
});

/**
 * **Closed by Phase A.** This block was a defect pinned by inversion; it is now an ordinary
 * regression guard, and the history is worth keeping because of how it was closed.
 *
 * The defect: `looksLikeMarkdown` fired on a single `#` heading, so every hash-commented shell
 * script was classified `markdown` and its comment lines were harvested as headings by
 * construction — 591 across 9 frozen shell scripts. The harm was not the inflated drift but
 * that the fabricated markers **forged the evidence that drift had measured anything**,
 * defeating the §28 reporting added so this class would be visible. `tclConfig.sh` went
 * 1,877 → 19 tokens with `fallbackUsed: false` and `driftCoverage.measured: true`.
 *
 * It took **both** halves of Phase A, and neither alone was enough:
 *
 *   - The **measurement gate** (§33) refuses an item that changed and left no witness — but it
 *     was powerless here, because the fabricated headings *were* the witness it checks.
 *     Measured: shell over stdin was byte-identical before and after that change.
 *   - **Seam 2** (§34) stopped a bare `#` line from making a document, so shell now classifies
 *     `text`, harvests zero headings, and lands in the measurement gate's reach.
 *
 * §32 deferred seam 2 on the belief that it meant "require more than one `#` line" — a *count*
 * threshold, which `docs/phase-4b-lever-disposition.md` had already shown points the wrong way,
 * since `tclConfig.sh` carries 79 markers to `CODE_OF_CONDUCT.md`'s 12. The discriminator that
 * works is *shape*, and its measured cost to prose is zero files.
 *
 * The `it.fails` inversion did its job exactly as designed: the contract went red with
 * "Expected test to fail" the moment the remedy landed, and the preconditions test went red
 * alongside it because the fix arrived from a direction the contract could not see. Both are
 * now stated positively.
 */
describe('hash-commented code is not markdown, and is not deleted under a claim of measurement', () => {
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

  // Still computed at describe scope: a crash here is a collection error the runner reports,
  // rather than something an individual assertion could swallow.
  const request = parse(SHELL, loadConfig(), { sourceKind: 'stdin' });
  const bundle = request.bundle;
  const result = optimize({
    ...request,
    budget: { ...request.budget, targetReductionRatio: 0.3 },
  });

  it('classifies shell source as text, and harvests no headings from its comments', () => {
    expect(
      result.trace.stageCount,
      'no stage ran, so nothing below observes anything',
    ).toBeGreaterThan(0);

    // Was `markdown` before seam 2, on the strength of one `# Copyright …` line.
    expect(bundle.items[0]?.contentType).toBe('text');

    // Still nothing looked at it — there is no shell validator, and §17 declines to guess.
    // That has not changed and is not the fix; the fix is that drift no longer pretends
    // otherwise.
    expect(result.trace.astCoverage).toEqual({
      checked: 0,
      unchecked: 1,
      uncheckedContentTypes: ['text'],
    });

    // The fabrication is gone. These were 4 "headings", every one a `#` comment line.
    const headings = [...tracker.extractContentMarkers(bundle)].filter((marker) =>
      marker.startsWith('heading:'),
    );
    expect(headings).toEqual([]);
  });

  it('is not deleted wholesale under a claim that retention was measured', () => {
    // The former CONTRACT, stated positively. Kept over the *input* rather than over trace
    // fields, for the reason lever 1's measurement established: `tclConfig.sh` and
    // `CODE_OF_CONDUCT.md` were identical on every field the trace carries, so a field-level
    // assertion would condemn real prose too.
    const deletedWholesale = result.trace.tokenAfter < result.trace.tokenBefore * 0.2;
    const claimedMeasured = result.validation.driftCoverage?.measured === true;

    expect(
      deletedWholesale && claimedMeasured,
      `${result.trace.tokenBefore} -> ${result.trace.tokenAfter} tokens with driftCoverage.measured=${claimedMeasured}`,
    ).toBe(false);
  });

  it('refuses it outright, because nothing witnesses it', () => {
    // Both halves of Phase A in one assertion: seam 2 removed the forged markers, so the
    // measurement gate can see there is no witness, so the caller gets their bytes back.
    expect(result.validation.driftCoverage?.measured).toBe(false);
    expect(result.validation.issues.map((issue) => issue.code)).toContain(
      'SEMANTIC_DRIFT_UNMEASURABLE',
    );
    expect(result.fallbackUsed).toBe(true);
    expect(result.trace.tokenAfter).toBe(result.trace.tokenBefore);
  });
});
