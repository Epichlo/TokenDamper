import { afterEach, describe, expect, it } from 'vitest';
// Source, not `dist` — this is what `deep-backend-regions.test.ts` does, and vitest transpiles
// it. Importing the build would silently test a stale artifact.
import { createDeepBackends } from '../../packages/deep/src/index';
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

// The `stub` backend above always returns exactly one region, so none of the tests up to this
// point ever hand `dropOverlapping` more than one candidate — the mode switch was covered, but
// the reconciliation `selectElisionRegions` is supposed to perform on a multi-candidate backend
// result was not. `test/unit/deep-backend-regions.test.ts`'s nested-function cases are the
// closest existing coverage and still do not close this: they call the raw backend
// (`ts.regions(src)` / `py.regions(src)`) and compare it against Fast's own output, never
// `selectElisionRegions(item, { mode: 'deep' })` with a backend registered. So nothing committed
// exercised a *real* backend's multi-candidate result flowing through core's own
// `dropOverlapping` and filters via the mode switch this file is about.
//
// **What a failure here means.** If either test below starts reporting 2 regions instead of 1,
// or its one region is no longer byte-identical to the backend's own outer candidate, a
// backend's candidates have stopped flowing through core's `dropOverlapping` on the way out of
// `selectElisionRegions` — for example a restructure that returned the backend arm early
// (`if (backend) return Object.freeze([...backend.regions(...)]);`), bypassing both
// `dropOverlapping` and the size/substantive filters. The nested outer+inner pair is the
// evidence: it is the one shape in this file where Deep's raw discovery and Fast's post-filter
// discovery are known to disagree (Deep finds both; Fast's own scanners find both too, but
// `dropOverlapping` then subsumes the inner one into the outer one), so it is the one shape that
// can tell "reconciled" apart from "not reconciled" instead of passing either way.
//
// Fixtures are copied verbatim from `test/unit/deep-backend-regions.test.ts`'s `'nested-ts'` and
// `'nested-py'` cases, not reinvented, so both files pin the same shape from both sides of the
// seam: raw discovery there, discovery-through-core here. Both outer bodies are well past
// `MIN_REGION_BYTES` (104) — 193 bytes for the TypeScript outer body, 150 for the Python one, per
// that file's own comments, reconfirmed by the byte-length assertions below.
describe('selectElisionRegions mode switch — a real Deep backend still reconciles through dropOverlapping', () => {
  it('typescript: a nested function body is discovered twice by Deep but selected once, matching fast mode', async () => {
    const src =
      'export function outer(a: number) {\n' +
      '  function inner(b: number) {\n' +
      '    return b + 1;\n' +
      '  }\n' +
      '  const x0 = a + 0;\n' +
      '  const x1 = a + 1;\n' +
      '  const x2 = a + 2;\n' +
      '  const x3 = a + 3;\n' +
      '  const x4 = a + 4;\n' +
      '  return inner(x0) + x1 + x2 + x3 + x4;\n' +
      '}\n';
    const nested = createContextItem({
      id: 'nested-ts',
      kind: 'file',
      content: src,
      path: '/tmp/nested.ts',
      language: 'typescript',
    });

    const backends = await createDeepBackends();
    const ts = backends.find((b) => b.language === 'typescript')!;
    registerParserBackend(ts);

    // 1. The raw backend genuinely offers two candidates — outer and inner — so "one region
    // survives" below is dropOverlapping doing work, not an input that only ever had one.
    const rawCandidates = ts.regions(src);
    expect(rawCandidates).toHaveLength(2);
    expect(src.slice(rawCandidates[0]!.start, rawCandidates[0]!.end).length).toBe(193);
    expect(src.slice(rawCandidates[1]!.start, rawCandidates[1]!.end).length).toBe(21);

    // 2. Through selectElisionRegions in deep mode, only the outer region survives, and it is
    // byte-identical to the backend's own outer candidate — not merely the same length.
    const deepResult = selectElisionRegions(nested, { mode: 'deep' });
    expect(deepResult).toHaveLength(1);
    expect(deepResult[0]).toEqual(rawCandidates[0]);
    expect(src.slice(deepResult[0]!.start, deepResult[0]!.end)).toBe(
      '\n  function inner(b: number) {\n    return b + 1;\n  }\n  const x0 = a + 0;\n' +
        '  const x1 = a + 1;\n  const x2 = a + 2;\n  const x3 = a + 3;\n  const x4 = a + 4;\n' +
        '  return inner(x0) + x1 + x2 + x3 + x4;\n',
    );

    // 3. Deep mode's reconciled result matches fast mode's exactly — the registered real
    // backend changed nothing about what the caller receives for this file.
    expect(deepResult).toEqual(selectElisionRegions(nested));
  });

  it('python: a nested function body is discovered twice by Deep but selected once, matching fast mode', async () => {
    const src =
      'def outer(a):\n' +
      '    def inner(b):\n' +
      '        return b + 1\n' +
      '    x0 = a + 0\n' +
      '    x1 = a + 1\n' +
      '    x2 = a + 2\n' +
      '    x3 = a + 3\n' +
      '    x4 = a + 4\n' +
      '    return inner(x0) + x1 + x2 + x3 + x4\n';
    const nested = createContextItem({
      id: 'nested-py',
      kind: 'file',
      content: src,
      path: '/tmp/nested.py',
      language: 'python',
    });

    const backends = await createDeepBackends();
    const py = backends.find((b) => b.language === 'python')!;
    registerParserBackend(py);

    // 1. Same non-vacuousness check as the TypeScript case above, for Python's own scanner.
    const rawCandidates = py.regions(src);
    expect(rawCandidates).toHaveLength(2);
    expect(src.slice(rawCandidates[0]!.start, rawCandidates[0]!.end).length).toBe(150);
    expect(src.slice(rawCandidates[1]!.start, rawCandidates[1]!.end).length).toBe(12);

    // 2. Only the outer region survives selectElisionRegions, byte-identical to Deep's own
    // outer candidate.
    const deepResult = selectElisionRegions(nested, { mode: 'deep' });
    expect(deepResult).toHaveLength(1);
    expect(deepResult[0]).toEqual(rawCandidates[0]);
    expect(src.slice(deepResult[0]!.start, deepResult[0]!.end)).toBe(
      'def inner(b):\n        return b + 1\n    x0 = a + 0\n    x1 = a + 1\n' +
        '    x2 = a + 2\n    x3 = a + 3\n    x4 = a + 4\n    return inner(x0) + x1 + x2 + x3 + x4',
    );

    // 3. Deep and fast mode agree exactly.
    expect(deepResult).toEqual(selectElisionRegions(nested));
  });
});
