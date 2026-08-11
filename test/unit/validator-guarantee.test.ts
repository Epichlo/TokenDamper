import { describe, expect, it } from 'vitest';
import { validateItemAst } from '../../src/core/validation/ast';
import type { ContextItem } from '../../src/core/model/types';

/**
 * Audit M1 — what the "AST-lite validators" actually guarantee, pinned as executable fact.
 *
 * The TypeScript validator builds no AST. It is a lexer that tracks strings, template
 * interpolation, comments and regex literals, and detects exactly two error classes: unbalanced
 * brackets and unterminated strings/comments. The product's headline property therefore means
 * **bracket and quote integrity**, not syntax validity — which is now what `README.md` says.
 *
 * This file exists so that sentence cannot quietly stop being true. Every row below is also a
 * row in the README table, and each was reproduced against the shipped validator rather than
 * copied from the audit — three other audit claims in this project turned out to be wrong when
 * measured (DECISIONS §40, §42, §45).
 *
 * **These are characterization tests, not aspirations.** A `PASS` on nonsense is the documented
 * behaviour. If someone wires the real compiler API, these will fail — that is the signal to
 * update the README table in the same change, not to weaken the test.
 */

const item = (content: string, language: string, path: string): ContextItem =>
  ({
    id: 'i',
    itemId: 'i',
    kind: 'file',
    contentType: 'code',
    content,
    origin: 'test',
    contentHash: 'h',
    language,
    path,
    metadata: {},
  }) as ContextItem;

describe('the TypeScript validator checks balance, not syntax (M1)', () => {
  const accepted: ReadonlyArray<readonly [string, string]> = [
    ['an assignment with no right-hand side', 'const x = ;'],
    ['a parameter with no type after its colon', 'function f(a: , b) { return 1; }'],
    ['an import with no binding', 'import from "x";'],
    ['an identifier that starts with a digit', 'let 123abc = 5;'],
    ['an operator pile-up', 'const a = 1 +++++ 2;'],
    ['plain English prose', 'ceci nest pas du code'],
  ];

  for (const [label, source] of accepted) {
    it(`accepts ${label} — balanced, and that is all it asks`, () => {
      const result = validateItemAst(item(source, 'typescript', 'a.ts'));
      expect(result.valid).toBe(true);
      // `validated: true` matters as much as `valid: true`: this is a real check returning a
      // pass, not the absence of a check reading as one (DECISIONS §23).
      expect(result.validated).toBe(true);
    });
  }

  it('rejects unbalanced brackets, which is the guarantee it does make', () => {
    const result = validateItemAst(item('super(; }', 'typescript', 'a.ts'));
    expect(result.valid).toBe(false);
  });
});

describe('the Python validator is meaningfully stronger, but not a parser (M1)', () => {
  it('catches a missing colon after a def', () => {
    expect(validateItemAst(item('def f()\n    return 1', 'python', 'a.py')).valid).toBe(false);
  });

  it('catches stray leading indentation', () => {
    expect(validateItemAst(item('  leading indent', 'python', 'a.py')).valid).toBe(false);
  });

  it('accepts well-formed Python', () => {
    expect(validateItemAst(item('def f():\n    return 1', 'python', 'a.py')).valid).toBe(true);
  });

  it('still accepts plain English prose', () => {
    expect(validateItemAst(item('ceci nest pas du code', 'python', 'a.py')).valid).toBe(true);
  });
});

describe('the JSON validator is a real parser (M1)', () => {
  it('accepts valid JSON', () => {
    expect(validateItemAst(item('{"a":1}', 'json', 'a.json')).valid).toBe(true);
  });

  it('rejects malformed JSON', () => {
    expect(validateItemAst(item('{"a":}', 'json', 'a.json')).valid).toBe(false);
  });

  it('rejects prose', () => {
    expect(validateItemAst(item('not json at all', 'json', 'a.json')).valid).toBe(false);
  });
});
