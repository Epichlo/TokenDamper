import { describe, expect, it } from 'vitest';
import { optimize } from '../../src/core/engine';
import { DriftTracker } from '../../src/core/ledger/drift-tracker';
import { createBundleFromItems, createContextItem } from '../../src/core/model/constructors';
import { loadConfig } from '../../src/config/load';
import { parse } from '../../src/adapters/cli';

/**
 * Regression guard for the empty-before-set class of bug — invariant 10 applied to `S_k`.
 *
 * `R_AST` and `R_struct` each default to `1.0` when their pre-optimization set is empty, so
 * an item the extractors found nothing in scored as *perfectly retained*. Combined with
 * whole-item elision that is an approval to delete content outright: `src/index.ts` is
 * fourteen `export * from './x';` lines, yields no symbols, and went 420 bytes to a 67-byte
 * marker — 86.15% of its tokens — at `S_k = 0.0000` with no fallback and no complaint.
 *
 * The rule: an item that changed and produced neither symbols nor content-derived markers
 * cannot be certified.
 *
 * **Phase A widened this from validator-covered items to every item.** §28 scoped it to
 * covered items to protect prose, and measurement showed the scope was protecting the wrong
 * thing: real documents all carry content markers and were never in reach of the rule, while
 * the population the scope excluded was uncovered *code* — a 57,037-token Perl file elided
 * whole on the file-argument route at `S_k = 0`, `measured: false`, no fallback, because
 * nothing covers `.pl`. The Gateway keeps within-payload deduplication either way, because
 * `resolveRecoverableElisions` substitutes recoverable elisions back before the rule runs.
 * See `docs/phase-0-measurement-baseline.md` §5 and DECISIONS §33.
 */
describe('drift refuses to certify an elision it has no evidence for', () => {
  const tracker = new DriftTracker();
  const BARREL =
    "export * from './core/model';\nexport * from './config';\nexport * from './core/engine';\n";
  const MARKER = '[TokenDamper: 3 code lines elided, 84 bytes, sha256:10a4b0eb949b]';

  const bundleOf = (...items: ReturnType<typeof createContextItem>[]) =>
    createBundleFromItems(items, 'text');

  describe('the reproduction', () => {
    const before = bundleOf(
      createContextItem({
        id: 'i1',
        kind: 'file',
        content: BARREL,
        path: 'src/index.ts',
        language: 'typescript',
      }),
    );
    const after = bundleOf(
      createContextItem({
        id: 'i1',
        kind: 'file',
        content: MARKER,
        path: 'src/index.ts',
        language: 'typescript',
      }),
    );

    it('scores 0.0000 — the number itself was never the problem', () => {
      const report = tracker.calculateDrift(before, after);

      // Both ratios are at their empty-set defaults, so retention "looks" perfect.
      expect(report.driftScore).toBe(0);
      expect(report.astSymbolRetentionRatio).toBe(1);
      expect(report.symbolsBeforeCount).toBe(0);
    });

    it('reports that nothing was measured, rather than reporting a clean measurement', () => {
      const report = tracker.calculateDrift(before, after);

      expect(report.astMeasured).toBe(false);
      expect(report.contentMarkersBeforeCount).toBe(0);
      expect(report.contentChanged).toBe(true);
    });

    it('falls back despite the passing score', () => {
      const report = tracker.calculateDrift(before, after);

      expect(report.shouldFallback).toBe(true);
      expect(report.unwitnessedItemIds).toEqual(['i1']);
      expect(report.reason).toContain('unmeasurable');
    });
  });

  describe('what it deliberately does not touch', () => {
    it('leaves a real document alone — its markers are the evidence', () => {
      // This is the case §28's scoping was meant to protect, and it never needed the
      // scoping: a document carries headings, lists and links, `extractContentMarkers`
      // harvests them, and the item is witnessed. All 25 markdown files in the frozen
      // corpus behave this way, which is why widening the rule moved none of them.
      // `contentType: 'markdown'` explicitly: `MARKDOWN_MARKER_TYPES` is `markdown` alone
      // since 4b.3, so a document tagged `text` harvests nothing and would be unwitnessed.
      // That coupling is the point — it is what makes classification load-bearing for this
      // gate, and why seam 2 and this change compose.
      const before = bundleOf(
        createContextItem({
          id: 'd1',
          kind: 'file',
          contentType: 'markdown',
          content: '# Title\n\nSome prose.\n\n- a bullet\n- another\n\nSee [docs](./x.md).\n',
        }),
      );
      const after = bundleOf(
        createContextItem({
          id: 'd1',
          kind: 'file',
          contentType: 'markdown',
          content: '# Title\n\n[TokenDamper: 2 text lines elided]\n\n- a bullet\n- another\n\nSee [docs](./x.md).\n',
        }),
      );

      const report = tracker.calculateDrift(before, after);

      expect(report.contentChanged).toBe(true);
      expect(report.structMeasured).toBe(true);
      expect(report.unwitnessedItemIds).toEqual([]);
      expect(report.measurementGate).toBe('pass');
    });

    it('leaves an untouched item alone, even with no evidence available', () => {
      // Retention needs no witness when nothing was removed. This clause is what keeps the
      // rule off every pass-through, and off turn 1 of a Gateway session where
      // `cleanup:session-dedup` has no previous hashes and cannot elide.
      const before = bundleOf(
        createContextItem({ id: 'i1', kind: 'file', content: BARREL, path: 'src/index.ts' }),
      );
      const after = bundleOf(
        createContextItem({ id: 'i1', kind: 'file', content: BARREL, path: 'src/index.ts' }),
      );

      const report = tracker.calculateDrift(before, after);

      expect(report.contentChanged).toBe(false);
      expect(report.unwitnessedItemIds).toEqual([]);
      expect(report.shouldFallback).toBe(false);
    });

    it('leaves a pruned-away item alone — selection is not elision', () => {
      // The planner exists to drop items under a budget the caller set. `R_AST` already
      // scores that loss wherever the item carried symbols; refusing here would stop the
      // knapsack pruning any symbol-free file.
      const before = bundleOf(
        createContextItem({
          id: 'keep',
          kind: 'file',
          content: 'export function alpha(): void {}\n',
          path: 'src/a.ts',
        }),
        createContextItem({ id: 'drop', kind: 'file', content: BARREL, path: 'src/index.ts' }),
      );
      const after = bundleOf(
        createContextItem({
          id: 'keep',
          kind: 'file',
          content: 'export function alpha(): void {}\n',
          path: 'src/a.ts',
        }),
      );

      const report = tracker.calculateDrift(before, after);

      expect(report.unwitnessedItemIds).toEqual([]);
    });

    it('leaves an item alone when its symbols are the evidence', () => {
      const code = 'export function alpha(value: number): number {\n  return value + 1;\n}\n';
      const before = bundleOf(
        createContextItem({ id: 'i1', kind: 'file', content: code, path: 'src/a.ts' }),
      );
      const after = bundleOf(
        createContextItem({
          id: 'i1',
          kind: 'file',
          content:
            'export function alpha(value: number): number {\n  [TokenDamper: 1 function-body lines elided]\n}\n',
          path: 'src/a.ts',
        }),
      );

      const report = tracker.calculateDrift(before, after);

      expect(report.astMeasured).toBe(true);
      expect(report.unwitnessedItemIds).toEqual([]);
      expect(report.shouldFallback).toBe(false);
    });
  });

  describe('the rule does not depend on validator coverage', () => {
    it('refuses an uncovered-language item, which is the case the old scope excluded', () => {
      // The Perl finding in miniature. Until Phase A this passed at `S_k = 0` with no
      // fallback: nothing covers a language outside `isCodeExtension`, so the rule was
      // scoped away from precisely the items being deleted whole. Measured at full size,
      // `Unicode_Collate_Locale_ja.pl` went 57,037 -> 19 tokens on the *file* route.
      //
      // No `path` and no `language` here on purpose — that is what "uncovered" means, and
      // it is also the Gateway/MCP shape.
      const SHELL = 'PREFIX=/usr/local\nexec_prefix=${PREFIX}\nLIBS="-lm -lpthread"\n';
      const before = bundleOf(createContextItem({ id: 's1', kind: 'file', content: SHELL }));
      const after = bundleOf(
        createContextItem({ id: 's1', kind: 'file', content: '[TokenDamper: 3 text lines elided]' }),
      );

      const report = tracker.calculateDrift(before, after);

      // The score still says "perfect" — it always did. The gate no longer believes it.
      expect(report.driftScore).toBe(0);
      expect(report.measured).toBe(false);
      expect(report.contentChanged).toBe(true);
      expect(report.unwitnessedItemIds).toEqual(['s1']);
      expect(report.measurementGate).toBe('refuse');
      expect(report.shouldFallback).toBe(true);
    });
  });

  describe('the two gates are decided separately', () => {
    it('separates "nothing measured it" from "too much was lost"', () => {
      // Why the split exists: `S_k` reaches 0.400 from two opposite configurations, and a
      // single comparison arbitrates both. Here the measurement gate refuses while the
      // retention gate passes — a distinction `shouldFallback` alone cannot carry, and the
      // reason `SEMANTIC_DRIFT_UNMEASURABLE` and `SEMANTIC_DRIFT_EXCEEDED` are two codes.
      const before = bundleOf(createContextItem({ id: 'i1', kind: 'file', content: BARREL }));
      const after = bundleOf(createContextItem({ id: 'i1', kind: 'file', content: MARKER }));

      const report = tracker.calculateDrift(before, after);

      expect(report.measurementGate).toBe('refuse');
      expect(report.retentionGate).toBe('pass');
      expect(report.driftScore).toBeLessThanOrEqual(0.4);
      expect(report.reason).toContain('unmeasurable');
    });

    it('refuses on retention while measurement passes', () => {
      // The mirror case: symbols existed, so measurement is satisfied; most of them died,
      // so retention is not.
      //
      // Four symbols retaining one, not three retaining one. Three-retaining-one is
      // `R_AST = 1/3` and lands on `S_k = 0.400` exactly — the attractor-B boundary the
      // disposition names, which `>` lets through. Using it here would have tested the
      // inequality rather than the gate.
      const code =
        'export function alpha(): void {}\nexport function beta(): void {}\nexport function gamma(): void {}\nexport function delta(): void {}\n';
      const before = bundleOf(createContextItem({ id: 'i1', kind: 'file', content: code }));
      const after = bundleOf(
        createContextItem({ id: 'i1', kind: 'file', content: 'export function alpha(): void {}\n' }),
      );

      const report = tracker.calculateDrift(before, after);

      expect(report.measurementGate).toBe('pass');
      expect(report.retentionGate).toBe('refuse');
      expect(report.reason).toContain('exceeds maximum threshold');
    });
  });

  describe('end to end through the engine', () => {
    it('refuses the whole-file elision and hands back the input verbatim', () => {
      // Assembled exactly the way `src/cli/main.ts` assembles it, because two shortcuts each
      // silently stop the scenario reproducing while every assertion still passes:
      //
      //   - Hand-rolling the item with `createContextItem` leaves `contentType` at `text`
      //     instead of the `code` that `classifyContent` derives from the `.ts` extension,
      //     and `compression:token-hashing` then declines to elide at all.
      //   - Injecting a `TokenHasher` makes the elision *recoverable*, so
      //     `resolveRecoverableElisions` substitutes the original content back before
      //     scoring and `contentChanged` is false. The CLI injects no hasher, which is
      //     precisely why its markers resolve to nothing (see CHANGELOG, `reversible`).
      const config = loadConfig();
      const content =
        Array.from({ length: 14 }, (_, i) => `export * from './module-number-${i}';`).join('\n') +
        '\n';
      const request = parse(content, config, { sourceKind: 'file', sourcePath: 'src/index.ts' });

      expect(request.bundle.items[0]?.contentType).toBe('code');

      const result = optimize({
        ...request,
        budget: { ...request.budget, targetReductionRatio: 0.3 },
      });

      expect(result.validation.issues.map((i) => i.code)).toContain('SEMANTIC_DRIFT_UNMEASURABLE');
      expect(result.fallbackUsed).toBe(true);
      expect(result.validation.driftCoverage?.unwitnessedItems.length).toBe(1);

      // Fail-open is not negotiable: refusing to certify must still return usable output.
      expect(result.emittedOutput).toBe(content);

      // Invariant 10, twice over. This only means anything if a stage actually tried to
      // elide — with no budget the planner returns `pass_through` and every assertion above
      // holds vacuously over a pipeline that never ran — and only if drift was asked about
      // an item a validator covers.
      expect(result.trace.stageCount).toBeGreaterThan(0);
      expect(result.validation.driftCoverage?.contentChanged).toBe(true);
      expect(result.validation.driftCoverage?.symbolBearingItems).toBe(1);
    });
  });
});
