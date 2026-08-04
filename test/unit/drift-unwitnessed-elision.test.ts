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
 * The rule: an item that changed, that an AST validator covers (so symbols were the expected
 * witness), and that produced neither symbols nor content-derived markers, cannot be
 * certified. Scoped to validator-covered items on purpose — see the prose test below.
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
      const report = tracker.calculateDrift(before, after, {
        symbolBearingItemIds: new Set(['i1']),
      });

      // Both ratios are at their empty-set defaults, so retention "looks" perfect.
      expect(report.driftScore).toBe(0);
      expect(report.astSymbolRetentionRatio).toBe(1);
      expect(report.symbolsBeforeCount).toBe(0);
    });

    it('reports that nothing was measured, rather than reporting a clean measurement', () => {
      const report = tracker.calculateDrift(before, after, {
        symbolBearingItemIds: new Set(['i1']),
      });

      expect(report.astMeasured).toBe(false);
      expect(report.contentMarkersBeforeCount).toBe(0);
      expect(report.contentChanged).toBe(true);
    });

    it('falls back despite the passing score', () => {
      const report = tracker.calculateDrift(before, after, {
        symbolBearingItemIds: new Set(['i1']),
      });

      expect(report.shouldFallback).toBe(true);
      expect(report.unwitnessedItemIds).toEqual(['i1']);
      expect(report.reason).toContain('unmeasurable');
    });
  });

  describe('what it deliberately does not touch', () => {
    it('leaves prose alone — an inapplicable metric is not a failed one', () => {
      // No validator covers prose, so `symbolBearingItemIds` excludes it. `R_AST = 1.0` here
      // is not the extractor failing; there was never a symbol to lose. Enforcing on this
      // would make every prose bundle incompressible and end `cleanup:session-dedup` on the
      // conversational traffic the Gateway exists to carry.
      const before = bundleOf(
        createContextItem({
          id: 'p1',
          kind: 'file',
          content: 'Some ordinary prose with no structure at all.',
        }),
      );
      const after = bundleOf(
        createContextItem({
          id: 'p1',
          kind: 'file',
          content: '[TokenDamper: 1 text lines elided]',
        }),
      );

      const report = tracker.calculateDrift(before, after, { symbolBearingItemIds: new Set() });

      expect(report.contentChanged).toBe(true);
      expect(report.astMeasured).toBe(false);
      expect(report.unwitnessedItemIds).toEqual([]);
      expect(report.shouldFallback).toBe(false);
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

      const report = tracker.calculateDrift(before, after, {
        symbolBearingItemIds: new Set(['i1']),
      });

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

      const report = tracker.calculateDrift(before, after, {
        symbolBearingItemIds: new Set(['keep', 'drop']),
      });

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

      const report = tracker.calculateDrift(before, after, {
        symbolBearingItemIds: new Set(['i1']),
      });

      expect(report.astMeasured).toBe(true);
      expect(report.unwitnessedItemIds).toEqual([]);
      expect(report.shouldFallback).toBe(false);
    });
  });

  describe('the rule cannot fire silently', () => {
    it('is disabled, visibly, when the caller supplies no coverage', () => {
      // Invariant 10 turned on this fix itself. `calculateDrift` cannot re-derive validator
      // selection without duplicating the `language` -> path -> `contentType` precedence
      // that Issue 2 came from, so it depends on `validate()` passing coverage in. A caller
      // that forgets must produce a visible zero, not a quiet pass.
      const before = bundleOf(
        createContextItem({ id: 'i1', kind: 'file', content: BARREL, path: 'src/index.ts' }),
      );
      const after = bundleOf(
        createContextItem({ id: 'i1', kind: 'file', content: MARKER, path: 'src/index.ts' }),
      );

      const report = tracker.calculateDrift(before, after);

      expect(report.unwitnessedItemIds).toEqual([]);
      expect(report.shouldFallback).toBe(false);
      // The tell: content changed and nothing measured it.
      expect(report.contentChanged).toBe(true);
      expect(report.measured).toBe(false);
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
