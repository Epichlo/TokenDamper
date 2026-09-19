import { afterEach, describe, expect, it } from 'vitest';

import { createContextItem } from '../../src/core/model/constructors';
import {
  clearParserBackends,
  registerParserBackend,
  registeredParserLanguages,
  resolveParserBackend,
} from '../../src/core/parser/registry';
import type { ParserAdapter } from '../../src/core/parser/types';
import { selectValidator } from '../../src/core/validation/ast';

/**
 * R3 step 0 — the `ParserAdapter` seam itself, before any backend exists.
 *
 * The property under test is the one the design (§3.4) calls non-negotiable and states
 * twice in apparently opposite directions: *"`selectValidator` becomes a registry lookup
 * with the hardcoded chain as its fallback"* and *"the existing if-chain stays and stays
 * first"*. Both hold, because the switch is the **mode**:
 *
 *  - `fast` (the default) never reads the registry at all. Fast must not change behaviour
 *    because Deep exists, and the shipped path must not depend on a registry being
 *    populated.
 *  - `deep` reads the registry, and falls back to the same hardcoded chain when nothing is
 *    registered for the language.
 *
 * That is invariant 1 restated per configuration: same input, same *mode*, same bytes out.
 */

/** A minimal synchronous backend. Nothing here parses — the seam is what is under test. */
function stubBackend(language: string, marker: string): ParserAdapter {
  return {
    name: `stub-${marker}`,
    language,
    symbols: () => new Set([`fn:${marker}`]),
    check: () => ({ valid: false, issues: [{ message: marker, code: `STUB_${marker}` }], durationMs: 0 }),
    regions: () => [],
  };
}

const tsItem = () =>
  createContextItem({ id: 'ts', kind: 'file', content: 'const a = 1;\n', language: 'typescript' });

afterEach(() => {
  clearParserBackends();
});

describe('parser backend registry', () => {
  it('resolves nothing when no backend has been registered', () => {
    expect(resolveParserBackend('typescript')).toBeUndefined();
    expect(registeredParserLanguages()).toEqual([]);
  });

  it('resolves a registered backend by its language', () => {
    const backend = stubBackend('typescript', 'TS');
    registerParserBackend(backend);

    expect(resolveParserBackend('typescript')).toBe(backend);
    expect(registeredParserLanguages()).toEqual(['typescript']);
  });

  it('resolves a language case-insensitively, as selectValidator already does', () => {
    registerParserBackend(stubBackend('typescript', 'TS'));

    expect(resolveParserBackend('TypeScript')?.name).toBe('stub-TS');
  });
});

describe('selectValidator in fast mode ignores the registry entirely', () => {
  it('returns the shipped validator when nothing is registered', () => {
    expect(selectValidator(tsItem())?.language).toBe('typescript');
  });

  it('still returns the shipped validator when a backend IS registered', () => {
    registerParserBackend(stubBackend('typescript', 'TS'));

    // The shipped lexer, not the stub. A registered backend is invisible to the default
    // path — this is the assertion that lets Deep land without re-measuring Fast.
    const validator = selectValidator(tsItem());
    expect(validator?.language).toBe('typescript');
    expect(validator?.validate('const a = 1;\n').valid).toBe(true);
  });

  it('is identical whether the mode is omitted or named explicitly', () => {
    registerParserBackend(stubBackend('typescript', 'TS'));

    expect(selectValidator(tsItem())).toBe(selectValidator(tsItem(), 'fast'));
  });
});

describe('selectValidator in deep mode falls back to the hardcoded chain', () => {
  it('returns the shipped validator when the registry is empty', () => {
    const validator = selectValidator(tsItem(), 'deep');

    expect(validator?.language).toBe('typescript');
    expect(validator?.validate('const a = 1;\n').valid).toBe(true);
  });

  it('returns the shipped validator when a backend is registered for another language', () => {
    registerParserBackend(stubBackend('python', 'PY'));

    expect(selectValidator(tsItem(), 'deep')?.validate('const a = 1;\n').valid).toBe(true);
  });

  it('returns the registered backend when one covers the language', () => {
    registerParserBackend(stubBackend('typescript', 'TS'));

    const validator = selectValidator(tsItem(), 'deep');
    expect(validator?.language).toBe('typescript');

    // The stub refuses everything, which is how we know it ran rather than the lexer.
    const result = validator?.validate('const a = 1;\n');
    expect(result?.valid).toBe(false);
    expect(result?.issues[0]?.code).toBe('STUB_TS');
  });

  it('returns null for an item no language can be resolved for, registry or not', () => {
    registerParserBackend(stubBackend('typescript', 'TS'));
    const prose = createContextItem({
      id: 'prose',
      kind: 'note',
      content: 'Just a sentence about nothing.\n',
    });

    // Deep adds no language in R3. An item the chain cannot identify has no key to look
    // the registry up by, so it stays uncovered and reports `validated: false` — the §23
    // distinction, unchanged.
    expect(selectValidator(prose, 'deep')).toBeNull();
  });
});

describe('the adapter surface is synchronous', () => {
  it('returns a check result rather than a promise', () => {
    registerParserBackend(stubBackend('typescript', 'TS'));

    // §3.4: `AstValidator.validate` is sync and so is every caller down the chain. A
    // backend needing async setup does it at registration. Awaiting a non-promise silently
    // succeeds, so this asserts the shape rather than the value.
    const result = selectValidator(tsItem(), 'deep')?.validate('const a = 1;\n');
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof result?.durationMs).toBe('number');
  });
});
