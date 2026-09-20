import { describe, expect, it } from 'vitest';
// Source, not `dist` — this is what `deep-backend-symbols.test.ts` does, and vitest transpiles
// it. Importing the build would silently test a stale artifact.
import { createDeepBackends } from '../../packages/deep/src/index';

describe('deep regions() — typescript', () => {
  it('returns the brace interior of a function body, matching Fast convention', async () => {
    const backends = await createDeepBackends();
    const ts = backends.find((b) => b.language === 'typescript')!;
    const src = 'function add(a: number, b: number) {\n  return a + b;\n}\n';
    const regions = ts.regions(src);

    expect(regions).toHaveLength(1);
    // `start` just after `{`, `end` at the `}` — exactly scanBraceSpans's convention.
    expect(src.slice(regions[0]!.start, regions[0]!.end)).toBe('\n  return a + b;\n');
  });

  it('does not emit control-flow blocks', async () => {
    const backends = await createDeepBackends();
    const ts = backends.find((b) => b.language === 'typescript')!;
    const src = 'function f(x: number) {\n  if (x) {\n    return 1;\n  }\n  return 0;\n}\n';
    const regions = ts.regions(src);

    // The `if` block is a statement_block too; only the function body is a candidate.
    expect(regions).toHaveLength(1);
    expect(src.slice(regions[0]!.start, regions[0]!.end)).toContain('if (x)');
  });

  it('skips an expression-bodied arrow, which has no brace interior to take', async () => {
    const backends = await createDeepBackends();
    const ts = backends.find((b) => b.language === 'typescript')!;
    expect(ts.regions('const f = (x: number) => x + 1;\n')).toHaveLength(0);
  });
});

describe('deep regions() — python', () => {
  it('spans first-body-char to end of last body line', async () => {
    const backends = await createDeepBackends();
    const py = backends.find((b) => b.language === 'python')!;
    const src = 'def add(a, b):\n    return a + b\n';
    const regions = py.regions(src);

    expect(regions).toHaveLength(1);
    // Starts at `return`, not at the indent — scanPythonDefBodies uses
    // `firstBody.start + bodyIndent`. Ends at the end of the line, excluding `\n`.
    expect(src.slice(regions[0]!.start, regions[0]!.end)).toBe('return a + b');
  });

  it('keeps the docstring outside the region when asked', async () => {
    const backends = await createDeepBackends();
    const py = backends.find((b) => b.language === 'python')!;
    const src = 'def f():\n    """Doc."""\n    return 1\n';
    const kept = py.regions(src, { keepDocstrings: true });

    expect(kept).toHaveLength(1);
    expect(src.slice(kept[0]!.start, kept[0]!.end)).toBe('return 1');
  });

  it('emits no region for a body that is only a docstring when docstrings are kept', async () => {
    const backends = await createDeepBackends();
    const py = backends.find((b) => b.language === 'python')!;
    // Keeping the docstring leaves nothing to elide. An empty span here would be a region
    // that removes zero bytes and still writes a marker — strictly worse than the original.
    expect(py.regions('def f():\n    """Only a doc."""\n', { keepDocstrings: true })).toHaveLength(0);
  });
});
