import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyContent,
  createBundleFromItems,
  createContextItem,
  createOptimizationBudget,
} from '../../src/core/model/constructors';
import { runTokenHashingStage } from '../../src/stages/compression/token-hashing';
import { TokenHasher } from '../../src/core/hashing/token-hasher';

const budget = createOptimizationBudget({ riskTolerance: 'low', preserveKinds: [] });
const SOURCE = readFileSync(resolve(process.cwd(), 'src/core/hashing/token-hasher.ts'), 'utf8');

function bundleOf(content: string, path?: string) {
  return createBundleFromItems([
    createContextItem({
      id: 'a',
      kind: 'file',
      contentType: classifyContent(content, path ? 'file' : 'text', path),
      content,
      ...(path ? { path } : {}),
    }),
  ]);
}

function markersIn(text: string): string[] {
  return [...text.matchAll(/sha256:([a-f0-9]{12})\]/g)].map((m) => m[1]!);
}

describe('the stage does not fabricate a store it is about to discard', () => {
  it('marks its elisions irreversible when no hasher is supplied', () => {
    const before = bundleOf(SOURCE, 'src/core/hashing/token-hasher.ts');
    const result = runTokenHashingStage(before, budget, {});

    expect(result.changed).toBe(true);
    expect(result.bundle.items[0]!.metadata.reversible).toBe(false);
    expect(result.metrics.irreversibleElisions).toBe(1);
    expect(result.notes).toContain('irreversible');
  });

  it('marks them reversible and registers the content when a hasher is supplied', () => {
    const hasher = new TokenHasher();
    const before = bundleOf(SOURCE, 'src/core/hashing/token-hasher.ts');
    const result = runTokenHashingStage(before, budget, { tokenHasher: hasher });

    expect(result.bundle.items[0]!.metadata.reversible).toBe(true);
    expect(result.metrics.irreversibleElisions).toBe(0);

    const hashes = markersIn(result.bundle.items[0]!.content);
    expect(hashes.length).toBeGreaterThan(0);
    expect(hashes.every((h) => hasher.hasHash(h))).toBe(true);
  });

  it('registers nothing anywhere when no hasher is supplied', () => {
    // A guard, not a defect pin: this passed before the change too, because the fabricated
    // store was a different instance from this one. It is here to stop the obvious future
    // shortcut — registering into a module-level singleton — which would resolve the
    // markers within one process and still leave the CLI reader with nothing.
    const before = bundleOf(SOURCE, 'src/core/hashing/token-hasher.ts');
    const result = runTokenHashingStage(before, budget, {});

    const hashes = markersIn(result.bundle.items[0]!.content);
    expect(hashes.length).toBeGreaterThan(0);
    expect(hashes.some((h) => new TokenHasher().hasHash(h))).toBe(false);
  });

  it('elides identically with and without a hasher', () => {
    // Reversibility is a property of who is holding the content, not of the transform. The
    // emitted bytes must not depend on it, or the CLI and MCP would diverge silently.
    const withHasher = runTokenHashingStage(bundleOf(SOURCE, 'a.ts'), budget, {
      tokenHasher: new TokenHasher(),
    });
    const without = runTokenHashingStage(bundleOf(SOURCE, 'a.ts'), budget, {});

    expect(without.bundle.items[0]!.content).toBe(withHasher.bundle.items[0]!.content);
    expect(without.metrics.bytesSaved).toBe(withHasher.metrics.bytesSaved);
  });

  it('reports irreversibility on the whole-item path too', () => {
    // Prose has no selectable regions, so this exercises `elideItem` rather than
    // `elideRegions`.
    const prose = [
      'The deployment window opens on Tuesday and closes on Thursday.',
      'Historically the read replica lags by about four seconds under load.',
      'Capacity planning for the quarter assumes a twenty percent traffic increase.',
    ].join('\n');

    const result = runTokenHashingStage(bundleOf(prose), budget, {});

    expect(result.changed).toBe(true);
    expect(result.bundle.items[0]!.metadata.reversible).toBe(false);
    expect(result.metrics.irreversibleElisions).toBe(1);
  });
});
