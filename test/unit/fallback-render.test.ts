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

  it('KNOWN LIMITATION: flattens a multi-item bundle into a blob on success', () => {
    // No consumer reaches this today. The assertion states what would happen if one did:
    // roles, boundaries and any enclosing structure are gone, and what comes back is text.
    //
    // This is not asserting the behaviour is *correct*. It is asserting it is *this*, so that
    // making an `emittedOutput` consumer multi-item changes a test rather than a payload.
    // The middle item contains a newline of its own. That is what makes the loss provable
    // rather than merely aesthetic: the separator and the content are the same character, so
    // the boundaries are not recoverable from the output even in principle.
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

    expect(outcome.output).toBe('system prompt\nfirst line\nsecond line\nuser question');

    // Three items in, four lines out, and nothing in the string says which boundary was which.
    // The render is not injective: a different bundle produces byte-identical output.
    expect(outcome.output.split('\n')).toHaveLength(4);
    expect(bundle.items).toHaveLength(3);

    const differentBundle = createBundleFromItems(
      [
        createContextItem({ id: 'x', kind: 'prompt', content: 'system prompt\nfirst line' }),
        createContextItem({ id: 'y', kind: 'prompt', content: 'second line\nuser question' }),
      ],
      'text',
    );
    expect(resolveFallback(request, pass, differentBundle).output).toBe(outcome.output);

    // And role is not carried at all — it lives on the item, never in the rendered string.
    expect(bundle.items[0]?.role).toBe('system');
    expect(outcome.output).not.toContain('role');
  });
});
