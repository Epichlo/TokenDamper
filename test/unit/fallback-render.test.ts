import { describe, expect, it } from 'vitest';
import { resolveFallback } from '../../src/core/fallback';
import { createOptimizationRequest } from '../../src/core/model/constructors';
import { createBundleFromItems, createContextItem } from '../../src/core/model/constructors';
import { loadConfig } from '../../src/config/load';
import type { ValidationReport } from '../../src/core/model';

/**
 * Phase B — the two fallback branches are not symmetric, and one of them is lossy.
 *
 * The fallback branch echoes `request.rawInput` and never enters the bundle render model.
 * The success branch joins item contents with `\n`, which is correct for one item and
 * destroys structure for more than one.
 *
 * That second branch is a **latent** defect, not a live one, and this file exists so it stays
 * checked rather than assumed. Every route that reads `emittedOutput` — CLI, MCP, bench —
 * builds its bundle through `createOptimizationRequest` -> `createContextBundle`, which
 * produces exactly one item. The Gateway is the only multi-item producer and deliberately maps
 * `finalBundle` positionally instead (invariant 9).
 *
 * If someone makes an `emittedOutput` consumer multi-item, the third test here is what should
 * make them stop and read.
 */
describe('fallback render', () => {
  const config = loadConfig();

  const pass: ValidationReport = {
    passed: true,
    confidence: 1,
    issues: [],
    shouldFallback: false,
  } as ValidationReport;

  const fail: ValidationReport = {
    passed: false,
    confidence: 0,
    issues: [],
    shouldFallback: true,
    reason: 'drift',
  } as ValidationReport;

  it('echoes raw input on fallback, without consulting the bundle at all', () => {
    const raw = 'line one\nline two\n';
    const request = createOptimizationRequest(raw, config, {
      requestId: 'r1',
      adapterName: 'test',
      adapterVersion: '0',
      source: 'text',
    });

    // A deliberately unrelated bundle: if the fallback branch rendered it, the assertion below
    // would pick that up rather than the raw input.
    const unrelated = createBundleFromItems(
      [createContextItem({ id: 'x', kind: 'file', content: 'SOMETHING ELSE ENTIRELY' })],
      'text',
    );

    const outcome = resolveFallback(request, fail, unrelated);

    expect(outcome.used).toBe(true);
    expect(outcome.output).toBe(raw);
    expect(outcome.output).not.toContain('SOMETHING ELSE');
  });

  it('round-trips a single-item bundle on success, which is every real consumer', () => {
    const raw = 'the only item\n';
    const request = createOptimizationRequest(raw, config, {
      requestId: 'r2',
      adapterName: 'test',
      adapterVersion: '0',
      source: 'text',
    });

    expect(request.bundle.items).toHaveLength(1);

    const outcome = resolveFallback(request, pass, request.bundle);

    expect(outcome.used).toBe(false);
    expect(outcome.output).toBe(raw);
  });

  // **The limitation this test was written to pin is now fixed** — audit H5, DECISIONS §43.
  //
  // It used to assert that a multi-item bundle flattened to `items.join('\n')`, and said so
  // deliberately: "This is not asserting the behaviour is *correct*. It is asserting it is
  // *this*, so that making an `emittedOutput` consumer multi-item changes a test rather than a
  // payload." Multi-file CLI ingestion is that consumer, so the test changed and the payload did
  // not — which is exactly what it was for.
  //
  // The proof it used is preserved below and inverted. The middle item contains a newline of its
  // own, so under the old join the separator and the content were the same character and the
  // boundaries were unrecoverable *in principle*; the old render was not injective, and two
  // different bundles produced byte-identical output. Both properties are now asserted the other
  // way round.
  it('renders a multi-item bundle with recoverable boundaries', () => {
    const bundle = createBundleFromItems(
      [
        createContextItem({ id: 'a', kind: 'prompt', content: 'system prompt', role: 'system' }),
        createContextItem({ id: 'b', kind: 'file', content: 'first line\nsecond line' }),
        createContextItem({ id: 'c', kind: 'prompt', content: 'user question', role: 'user' }),
      ],
      'text',
    );

    const request = createOptimizationRequest('irrelevant', config, {
      requestId: 'r3',
      adapterName: 'test',
      adapterVersion: '0',
      source: 'text',
    });

    const outcome = resolveFallback(request, pass, bundle);

    // Every item is introduced by a header naming it, so three items produce three boundaries.
    expect(bundle.items).toHaveLength(3);
    expect(outcome.output.split('==> ').length - 1).toBe(3);
    expect(outcome.output).toContain('first line\nsecond line');

    // The render is injective again: the two bundles that used to collide no longer do.
    const differentBundle = createBundleFromItems(
      [
        createContextItem({ id: 'x', kind: 'prompt', content: 'system prompt\nfirst line' }),
        createContextItem({ id: 'y', kind: 'prompt', content: 'second line\nuser question' }),
      ],
      'text',
    );
    expect(resolveFallback(request, pass, differentBundle).output).not.toBe(outcome.output);

    // Role is still not carried — it lives on the item, and the header names the item, not its
    // role. That half of the original finding is unchanged and still worth knowing.
    expect(bundle.items[0]?.role).toBe('system');
    expect(outcome.output).not.toContain('role');
  });

  it('leaves a single-item bundle exactly as it was', () => {
    // The compatibility guarantee that makes the change safe: CLI, MCP and bench all build
    // one-item bundles, and none of them may acquire a header.
    const only = createBundleFromItems(
      [createContextItem({ id: 'solo', kind: 'file', content: 'export const a = 1;\n' })],
      'text',
    );
    const request = createOptimizationRequest('irrelevant', config, {
      requestId: 'r4',
      adapterName: 'test',
      adapterVersion: '0',
      source: 'text',
    });

    const outcome = resolveFallback(request, pass, only);

    expect(outcome.output).toBe('export const a = 1;\n');
    expect(outcome.output).not.toContain('==>');
  });
});
