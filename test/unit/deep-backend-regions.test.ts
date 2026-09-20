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
