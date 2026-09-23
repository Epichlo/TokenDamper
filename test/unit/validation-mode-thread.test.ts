import { afterEach, describe, expect, it } from 'vitest';
import { clearParserBackends, registerParserBackend } from '../../src/core/parser/registry';
import { validateBundleAst } from '../../src/core/validation/ast';
import { createBundleFromItems, createContextItem } from '../../src/core/model/constructors';
import type { ParserAdapter } from '../../src/core/parser/types';

const rejecting: ParserAdapter = {
  name: 'always-rejects',
  language: 'typescript',
  symbols: () => new Set<string>(),
  check: () => ({
    valid: false,
    issues: [{ line: 1, column: 0, message: 'stub rejection', code: 'STUB' }],
    durationMs: 0,
  }),
  regions: () => [],
};

afterEach(() => clearParserBackends());

describe('mode reaches validateBundleAst', () => {
  const bundle = () =>
    createBundleFromItems([
      createContextItem({
        id: 'i1',
        kind: 'file',
        content: 'const a = 1;\n',
        path: '/tmp/a.ts',
        language: 'typescript',
      }),
    ]);

  it('fast mode ignores a registered backend', () => {
    registerParserBackend(rejecting);
    expect(validateBundleAst(bundle()).valid).toBe(true);
  });

  it('deep mode consults it', () => {
    registerParserBackend(rejecting);
    expect(validateBundleAst(bundle(), { mode: 'deep' }).valid).toBe(false);
  });
});
