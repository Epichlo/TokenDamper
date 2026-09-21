import { afterEach, describe, expect, it } from 'vitest';
import { clearParserBackends, registerParserBackend } from '../../src/core/parser/registry';
import { parserCoverage } from '../../src/core/parser/coverage';
// `createContextBundle` takes (rawInput, source, sourcePath?, ...) and builds a SINGLE-item
// bundle from a string — it does not accept `{ items }`. A multi-item bundle comes from
// `createBundleFromItems`, which is what this test needs to count coverage across languages.
import { createBundleFromItems, createContextItem } from '../../src/core/model/constructors';
import type { ParserAdapter } from '../../src/core/parser/types';

const stub: ParserAdapter = {
  name: 'stub',
  language: 'typescript',
  symbols: () => new Set<string>(),
  check: () => ({ valid: true, issues: [], durationMs: 0 }),
  regions: () => [],
};

const bundle = () =>
  createBundleFromItems([
    createContextItem({ id: 'a', kind: 'file', content: 'const a = 1;\n', path: '/tmp/a.ts', language: 'typescript' }),
    createContextItem({ id: 'b', kind: 'file', content: 'x = 1\n', path: '/tmp/b.py', language: 'python' }),
  ]);

afterEach(() => clearParserBackends());

describe('parserCoverage', () => {
  it('reports zero backend answers in fast mode even with a backend registered', () => {
    registerParserBackend(stub);
    const coverage = parserCoverage(bundle(), 'fast');
    expect(coverage.backendAnswered).toBe(0);
    expect(coverage.fastAnswered).toBe(2);
  });

  it('counts only items whose language has a backend', () => {
    registerParserBackend(stub);
    const coverage = parserCoverage(bundle(), 'deep');
    expect(coverage.backendAnswered).toBe(1);
    expect(coverage.fastAnswered).toBe(1);
    expect(coverage.registeredLanguages).toEqual(['typescript']);
  });

  it('reports deep mode with an empty registry as answering nothing', () => {
    const coverage = parserCoverage(bundle(), 'deep');
    expect(coverage.backendAnswered).toBe(0);
    expect(coverage.registeredLanguages).toEqual([]);
  });
});
