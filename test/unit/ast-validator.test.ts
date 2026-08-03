import { describe, expect, it } from 'vitest';
import { classifyContent, createContextItem, freeze } from '../../src/core/model/constructors';
import type { ContextBundle } from '../../src/core/model/types';
import {
  JsonValidator,
  PythonValidator,
  TypeScriptValidator,
  selectValidator,
  validateBundleAst,
  validateItemAst,
} from '../../src/core/validation/ast';

describe('TypeScriptValidator', () => {
  const validator = new TypeScriptValidator();

  it('passes for valid TypeScript/JavaScript code', () => {
    const code = `
      function calculateTotal(items: number[]): number {
        const title = "Order Total";
        // Calculate sum
        /* Block comment */
        return items.reduce((acc, curr) => acc + curr, 0);
      }
    `;
    const result = validator.validate(code);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('handles template literals with embedded expressions', () => {
    const code = "const msg = `Hello ${name.toUpperCase() + '!'}, count is ${1 + 2}`;";
    const result = validator.validate(code);
    expect(result.valid).toBe(true);
  });

  it('detects unbalanced brackets with precise line/column reporting', () => {
    const code = 'function broken() {\n  const x = (1 + 2;';
    const result = validator.validate(code);
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    const issue = result.issues.find((i) => i.code === 'AST_UNBALANCED_BRACKET');
    expect(issue).toBeDefined();
    expect(issue?.line).toBe(2);
    expect(issue?.column).toBe(13);
  });

  it('detects bracket mismatch', () => {
    const code = 'const arr = [1, 2, 3);';
    const result = validator.validate(code);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.code).toBe('AST_UNBALANCED_BRACKET');
    expect(result.issues[0]?.message).toContain("Mismatched closing bracket ')'");
  });

  it('detects unterminated string literals', () => {
    const code = "const s = 'unterminated string;\nconst y = 10;";
    const result = validator.validate(code);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'AST_UNTERMINATED_STRING')).toBe(true);
  });

  it('detects unterminated block comments', () => {
    const code = '/* Unclosed comment';
    const result = validator.validate(code);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.code).toBe('AST_UNTERMINATED_COMMENT');
  });
});

describe('JsonValidator', () => {
  const validator = new JsonValidator();

  it('passes for valid JSON', () => {
    const json = JSON.stringify({ name: 'TokenDamper', version: 1, active: true }, null, 2);
    const result = validator.validate(json);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('detects JSON syntax error with line/column position mapping', () => {
    const invalidJson = '{\n  "name": "TokenDamper",\n  "version": \n}';
    const result = validator.validate(invalidJson);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.code).toBe('JSON_SYNTAX_ERROR');
    expect(result.issues[0]?.line).toBe(4);
    expect(result.issues[0]?.column).toBeGreaterThan(0);
  });

  it('handles empty input gracefully', () => {
    const result = validator.validate('');
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.code).toBe('JSON_SYNTAX_ERROR');
  });
});

describe('PythonValidator', () => {
  const validator = new PythonValidator();

  it('passes for valid Python code with proper indentation and colons', () => {
    const py = `
def process_data(items):
    # Process items
    results = []
    for item in items:
        if item > 0:
            results.append(item * 2)
    return results
`;
    const result = validator.validate(py);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('detects missing indentation after colon', () => {
    const py = 'def add(a, b):\nreturn a + b';
    const result = validator.validate(py);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'AST_INDENTATION_ERROR')).toBe(true);
  });

  it('detects unexpected indent', () => {
    const py = 'x = 10\n    y = 20';
    const result = validator.validate(py);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'AST_INDENTATION_ERROR')).toBe(true);
  });

  it('detects unclosed triple quotes', () => {
    const py = '"""Unclosed docstring';
    const result = validator.validate(py);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'AST_UNTERMINATED_STRING')).toBe(true);
  });

  it('detects unbalanced brackets in Python code', () => {
    const py = 'data = [1, 2, (3, 4]';
    const result = validator.validate(py);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'AST_UNBALANCED_BRACKET')).toBe(true);
  });
});

describe('Orchestrator: validateItemAst & validateBundleAst', () => {
  it('validates individual items based on language and path', () => {
    const itemJs = createContextItem({
      id: 'item-js',
      kind: 'file',
      contentType: 'code',
      content: 'const a = (1 + 2);',
      origin: 'app.js',
      contentHash: 'h1',
      language: 'js',
      metadata: {},
    });

    const itemPyBroken = createContextItem({
      id: 'item-py',
      kind: 'file',
      contentType: 'code',
      content: 'def foo():\npass',
      origin: 'main.py',
      contentHash: 'h2',
      language: 'python',
      metadata: {},
    });

    expect(validateItemAst(itemJs).valid).toBe(true);
    expect(validateItemAst(itemPyBroken).valid).toBe(false);
  });

  it('validates bundles and aggregates item results', () => {
    const item1 = createContextItem({
      id: 'item-1',
      kind: 'file',
      contentType: 'json',
      content: '{"ok": true}',
      origin: 'config.json',
      contentHash: 'h1',
      path: 'config.json',
      metadata: {},
    });

    const item2 = createContextItem({
      id: 'item-2',
      kind: 'file',
      contentType: 'code',
      content: 'function broken() {',
      origin: 'test.ts',
      contentHash: 'h2',
      language: 'ts',
      metadata: {},
    });

    const bundle: ContextBundle = freeze({
      id: 'b1',
      bundleId: 'b1',
      source: 'file',
      items: freeze([item1, item2]),
      summary: freeze({ itemCount: 2, tokenEstimate: 20, preview: 'test' }),
      statistics: freeze({
        itemCount: 2,
        contentTypeCounts: freeze({ text: 0, markdown: 0, code: 1, html: 0, json: 1, yaml: 0, logs: 0, unknown: 0 }),
        kindCounts: freeze({ prompt: 0, file: 2, diff: 0, conversation: 0, note: 0 }),
        totalCharacters: 50,
      }),
      contentHash: 'b1',
    });

    const bundleResult = validateBundleAst(bundle);
    expect(bundleResult.valid).toBe(false);
    expect(bundleResult.itemResults['item-1']?.valid).toBe(true);
    expect(bundleResult.itemResults['item-2']?.valid).toBe(false);
    expect(bundleResult.issues.length).toBeGreaterThan(0);
    expect(bundleResult.issues[0]?.itemId).toBe('item-2');
  });

  it('does not judge a fenced prose message as TypeScript', () => {
    // The defect this pins: `looksLikeCode` treated a ``` fence as evidence of code, so an
    // ordinary assistant message quoting a snippet classified as `code`, and
    // `selectValidator` maps `code` to the TypeScript validator. The verdict then hung on
    // apostrophe parity in the prose — three contractions leave a quote open and the whole
    // message is rejected as an unterminated string literal.
    //
    // Both messages below are the same shape; only the number of contractions differs. If a
    // future change reintroduces a content signal for `code`, the first assertion fails
    // while the second still passes, which is the signature of a parity coin-flip rather
    // than a check. DECISIONS.md §17.
    const oddApostrophes = "Here's the fix. It's the guard that's missing:\n\n```ts\nconst a = 1;\n```";
    const evenApostrophes = "Here's the fix, it's ready:\n\n```ts\nconst a = 1;\n```";

    for (const content of [oddApostrophes, evenApostrophes]) {
      const item = createContextItem({
        id: 'msg-fenced',
        kind: 'conversation',
        contentType: classifyContent(content, 'text'),
        content,
        origin: 'anthropic:messages[0]',
        contentHash: 'hm',
        role: 'assistant',
        metadata: {},
      });

      expect(item.contentType).toBe('markdown');
      expect(selectValidator(item)).toBeNull();
      expect(validateItemAst(item).valid).toBe(true);
    }
  });

  it('reports a maxTimeMs breach without changing the syntax verdict', () => {
    // This test previously asserted `valid: false` and an `AST_SLA_EXCEEDED` issue on a
    // budget breach. That behaviour was removed deliberately, not relaxed to accommodate a
    // failure: it let a timing measurement decide a syntax question, which made the verdict
    // depend on machine load (measured: identical bytes, six fresh processes, verdicts split
    // valid/INVALID) and fell the engine back on large but perfectly valid files. The budget
    // is now carried on `slaExceeded`. See `test/unit/ast-sla-determinism.test.ts`.
    const item = createContextItem({
      id: 'item-fast',
      kind: 'file',
      contentType: 'code',
      content: 'const x = 10;',
      origin: 'fast.ts',
      contentHash: 'hf',
      language: 'ts',
      metadata: {},
    });

    // Setting maxTimeMs to 0ms forces the budget to be exceeded.
    const result = validateItemAst(item, { maxTimeMs: 0 });
    expect(result.slaExceeded).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.issues.some((i) => i.code === 'AST_SLA_EXCEEDED')).toBe(false);
  });
});
