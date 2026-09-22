import { afterEach, describe, expect, it } from 'vitest';
import { optimize } from '../../src/core/engine';
import { clearParserBackends, registerParserBackend } from '../../src/core/parser/registry';
import { createContextBundle, createOptimizationBudget } from '../../src/core/model/constructors';
import { loadConfig } from '../../src/config/load';
import { TOKENDAMPER_VERSION } from '../../src/version';
import type { OptimizationRequest } from '../../src/core/model';
import type { ParserAdapter } from '../../src/core/parser/types';

// Over MIN_REGION_BYTES (104), so Fast genuinely elides it — the third assertion below
// depends on fast mode changing the output.
const SRC =
  'export function f(a: number) {\n' +
  '  const doubled = a * 2;\n' +
  '  const shifted = doubled + 1;\n' +
  '  const scaled = shifted * 3;\n' +
  '  const clamped = Math.min(scaled, 1000);\n' +
  '  return clamped;\n' +
  '}\n';

/** Finds nothing to elide. Distinguishable from Fast, which finds the body. */
const stub: ParserAdapter = {
  name: 'stub',
  language: 'typescript',
  symbols: () => new Set<string>(),
  check: () => ({ valid: true, issues: [], durationMs: 0 }),
  regions: () => [],
};

// The object-literal `OptimizationRequest` shape, copied from
// `test/unit/block-hash-false-positive.test.ts:25-34`, which is this repo's working pattern for
// driving `optimize()` directly. `createOptimizationRequest` takes
// (rawInput, config, options, tokenizer?) and is the adapter-facing constructor — it does not
// accept `{ bundle, budget, rawInput }`.
const request = (): OptimizationRequest => ({
  requestId: 'engine-mode-test',
  rawInput: SRC,
  bundle: createContextBundle(SRC, 'file', 'sample.ts'),
  budget: createOptimizationBudget({ targetReductionRatio: 0.3 }),
  config: loadConfig({ env: {} }),
  adapterName: 'test',
  adapterVersion: TOKENDAMPER_VERSION,
});

afterEach(() => clearParserBackends());

describe('engineMode', () => {
  it('defaults to fast and reports it on the trace', () => {
    const result = optimize(request());
    expect(result.trace.parserCoverage?.mode).toBe('fast');
    expect(result.trace.parserCoverage?.backendAnswered).toBe(0);
  });

  it('reports a registered backend as having answered in deep mode', () => {
    registerParserBackend(stub);
    const result = optimize(request(), { engineMode: 'deep' });
    expect(result.trace.parserCoverage?.mode).toBe('deep');
    expect(result.trace.parserCoverage?.backendAnswered).toBe(1);
  });

  it('uses the backend spans rather than silently falling back to Fast spans', () => {
    registerParserBackend(stub);
    expect(optimize(request(), { engineMode: 'deep' }).emittedOutput).toBe(SRC);
    expect(optimize(request()).emittedOutput).not.toBe(SRC);
  });
});
