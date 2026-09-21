import { afterEach, describe, expect, it } from 'vitest';
import { clearParserBackends, registerParserBackend } from '../../src/core/parser/registry';
import { selectElisionRegions } from '../../src/core/elision/regions';
import { createContextItem } from '../../src/core/model/constructors';
import type { ParserAdapter } from '../../src/core/parser/types';

// The body must exceed MIN_REGION_BYTES (80 + 24 = 104), because core applies that filter
// AFTER the backend returns. A shorter body is dropped by the filter and the deep-mode
// assertions below fail for a reason that has nothing to do with the registry.
const SRC =
  'export function f(a: number) {\n' +
  '  const doubled = a * 2;\n' +
  '  const shifted = doubled + 1;\n' +
  '  const scaled = shifted * 3;\n' +
  '  const clamped = Math.min(scaled, 1000);\n' +
  '  return clamped;\n' +
  '}\n';

function item() {
  return createContextItem({ id: 'i1', kind: 'file', content: SRC, path: '/tmp/a.ts', language: 'typescript' });
}

/** A backend returning one deliberately distinctive span, so it cannot be confused with Fast's. */
const stub: ParserAdapter = {
  name: 'stub',
  language: 'typescript',
  symbols: () => new Set<string>(),
  check: () => ({ valid: true, issues: [], durationMs: 0 }),
  regions: () => [{ start: SRC.indexOf('{') + 1, end: SRC.lastIndexOf('}') }],
};

afterEach(() => clearParserBackends());

describe('selectElisionRegions mode switch', () => {
  it('ignores the registry in fast mode', () => {
    const withoutRegistry = selectElisionRegions(item());
    registerParserBackend(stub);
    expect(selectElisionRegions(item())).toEqual(withoutRegistry);
  });

  it('uses the registered backend in deep mode', () => {
    registerParserBackend(stub);
    const deep = selectElisionRegions(item(), { mode: 'deep' });
    expect(deep).toHaveLength(1);
    expect(deep[0]!.start).toBe(SRC.indexOf('{') + 1);
  });

  it('falls back to Fast in deep mode when nothing is registered', () => {
    expect(selectElisionRegions(item(), { mode: 'deep' })).toEqual(selectElisionRegions(item()));
  });

  it('still applies core filters to backend spans', () => {
    // A span under MIN_REGION_BYTES must be dropped by core, not by the backend.
    registerParserBackend({ ...stub, regions: () => [{ start: 31, end: 33 }] });
    expect(selectElisionRegions(item(), { mode: 'deep' })).toHaveLength(0);
  });
});
