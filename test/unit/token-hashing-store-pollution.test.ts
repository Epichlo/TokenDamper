import { describe, expect, it } from 'vitest';
import { runTokenHashingStage } from '../../src/stages/compression/token-hashing';
import { TokenHasher } from '../../src/core/hashing/token-hasher';
import {
  createBundleFromItems,
  createContextItem,
  createOptimizationBudget,
} from '../../src/core/model/constructors';
import { containsElisionMarker } from '../../src/core/elision';

/**
 * Pricing a candidate region must not register it — audit OX-M5.
 *
 * `trimRegionsToCeiling` renders a marker for **every** candidate span in order to price it: the
 * marker is variable-length and self-describing, so a saving estimated without rendering it would
 * overstate every region. That is correct. What was not correct is that the renderer it was handed,
 * `markerFor`, also called `hasher.registerBlock(...)` — so every span the ceiling *considered* and
 * then discarded was written into the store anyway.
 *
 * On the CLI nothing notices, because no hasher is supplied. On MCP the server instance is
 * long-lived and the hasher is the reversibility store, so it accumulates blocks for content that
 * was never elided into any output: memory grows with candidate counts rather than with elisions,
 * and `hasHash`/`expandBlockHash` answer for placeholders that appear nowhere.
 *
 * The binding constraint on the fix is that **marker bytes must be identical between pricing and
 * emission**, or the ceiling is computed against a different string than the one that gets written
 * and adherence shifts. That is satisfiable by construction — `renderElisionMarker` is a pure
 * function of the text, its noun and its hash, and `hashContent` is pure — but it is asserted below
 * rather than assumed.
 */
describe('token hashing store pollution', () => {
  // Many small, distinct function bodies, so the region scanner finds far more candidates than a
  // tight ceiling will keep.
  const SOURCE = Array.from(
    { length: 12 },
    (_, i) =>
      [
        `export function widget${i}(input: number): number {`,
        `  const scaled = input * ${i + 2};`,
        `  const shifted = scaled + ${i};`,
        `  const squared = shifted * shifted;`,
        `  return squared - ${i};`,
        '}',
      ].join('\n'),
  ).join('\n\n');

  const run = (hasher: TokenHasher, ratio: number) => {
    const bundle = createBundleFromItems([
      createContextItem({ id: 'item-1', kind: 'file', content: SOURCE, path: 'widgets.ts' }),
    ]);
    const budget = createOptimizationBudget({
      riskTolerance: 'low',
      preserveKinds: [],
      targetReductionRatio: ratio,
    });
    return runTokenHashingStage(bundle, budget, { tokenHasher: hasher });
  };

  it('registers only the blocks it actually elided', () => {
    const hasher = new TokenHasher();
    // A gentle ratio, so the ceiling is met after a few regions and most candidates are priced,
    // rejected, and — before the fix — registered anyway.
    const result = run(hasher, 0.1);

    const emitted = result.bundle.items[0]?.content as string;

    // Control: something was elided at all. Without this the store could be empty for the boring
    // reason that the stage did nothing.
    expect(containsElisionMarker(emitted)).toBe(true);
    expect(hasher.size).toBeGreaterThan(0);

    // Every stored block must correspond to a marker that is actually in the output. The store is
    // the reversibility record; a block nobody can reach from the emitted text is not a record of
    // anything.
    const markersInOutput = emitted.match(/sha256:[0-9a-f]+/g) ?? [];
    expect(markersInOutput.length).toBeGreaterThan(0);
    expect(hasher.size).toBe(markersInOutput.length);
  });

  it('does not grow the store when the ceiling rejects nearly everything', () => {
    // The shape that makes the leak visible: a tiny target means one region is enough, so the
    // other eleven are priced and discarded.
    const hasher = new TokenHasher();
    const result = run(hasher, 0.05);
    const emitted = result.bundle.items[0]?.content as string;
    const markersInOutput = (emitted.match(/sha256:[0-9a-f]+/g) ?? []).length;

    expect(markersInOutput).toBeGreaterThan(0);
    expect(hasher.size).toBe(markersInOutput);
  });

  it('emits byte-identical output whether or not a hasher is supplied', () => {
    // The constraint the fix must not break. Registration is a side effect; it must have no
    // bearing on the bytes. If pricing and emission ever rendered different markers, the ceiling
    // would be computed against a string other than the one written, and adherence would shift.
    const withHasher = run(new TokenHasher(), 0.3);

    const bundle = createBundleFromItems([
      createContextItem({ id: 'item-1', kind: 'file', content: SOURCE, path: 'widgets.ts' }),
    ]);
    const budget = createOptimizationBudget({
      riskTolerance: 'low',
      preserveKinds: [],
      targetReductionRatio: 0.3,
    });
    const withoutHasher = runTokenHashingStage(bundle, budget);

    expect(withHasher.bundle.items[0]?.content).toBe(withoutHasher.bundle.items[0]?.content);
  });
});
