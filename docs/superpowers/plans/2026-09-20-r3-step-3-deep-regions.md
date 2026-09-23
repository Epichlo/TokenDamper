# R3 Step 3 — Deep `regions()` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `regions()` real for TypeScript, Python and Go in `packages/deep`, reach it from the CLI via `--engine-mode fast|deep`, and measure every per-row output difference against the shipped Fast path.

**Architecture:** Deep's `regions()` replaces **candidate span discovery only**. Everything downstream — `dropOverlapping`, `MIN_REGION_BYTES`, `isSubstantiveRegion`, `trimRegionsToCeiling`, `splitRegionIntoStatements`, `elideRegions` — stays in core and is untouched, so every differing corpus row differs because span discovery differs and nothing else. `EngineMode` threads CLI → engine → token-hashing stage → `selectElisionRegions` → parser registry, and in parallel into `validate()` so step 2's `check()` finally runs live. `DriftTracker` keeps the shipped regex extractor; Deep's `symbols()` stays harness-only.

**Tech Stack:** TypeScript (CommonJS, Node >=20.19), vitest, `web-tree-sitter` 0.27 + tree-sitter grammars (confined to `packages/deep`, never core).

**Spec:** `docs/superpowers/specs/2026-09-09-tokendamper-v2-roadmap-design.md` §3.4 (the seam) and §3.5 (the staged negative control). Decided in `DECISIONS.md` §75. Steps 1 and 2 are §79 and §80. This plan's decisions land as **§81**; no new spec file.

## Global Constraints

- **No new dependency in core.** `web-tree-sitter` and the four grammars belong to `packages/deep` only. Core's `dependencies` and `devDependencies` must not change. Verify with `npm pack --dry-run` before claiming the tarball is unaffected.
- **Invariant 1 is per-configuration.** Same input, same *mode*, same bytes out. `fast` output must stay byte-identical whether or not a backend is registered.
- **Fast must not change because Deep exists.** `selectFastValidator` and every Fast scanner (`scanBraceSpans`, `scanGoBraceSpans`, `scanPythonDefBodies`) are read-only in this work.
- **The adapter surface is synchronous.** All async work happens at registration, before the pipeline runs.
- **Zero registered backends under `--engine-mode deep` is a hard error**, never a silent fall-through to Fast. Precedent: DECISIONS §54.
- **Span convention is Fast's:** brace languages emit the brace *interior* (`start` just after `{`, `end` at the `}`); Python emits first-non-whitespace-of-body to end-of-last-body-line (excluding the `\n`, including a CRLF `\r`).
- **A check that did not run is worse than a red one** (invariant 10). Every new measurement asserts its own denominator is non-zero.
- **The corpus must be frozen before measuring.** This repo is its own corpus. Use `tools/corpus-harness/collect.js`; never point the CLI at the live tree.

---

## File Structure

| file | responsibility |
|---|---|
| `packages/deep/src/regions.ts` | **Create.** Tree-to-span conversion for ts/js/python/go. Pure; takes a `Tree`, returns spans. |
| `packages/deep/src/index.ts` | **Modify.** `regions()` stops throwing; wires `regionsFromTree`. |
| `src/core/parser/types.ts` | **Modify.** `regions(content, options?)` gains `ParserRegionOptions`. |
| `src/core/parser/coverage.ts` | **Create.** `parserCoverage(bundle, mode)` — the invariant-10 evidence block. |
| `src/core/elision/regions.ts` | **Modify.** `SelectRegionsOptions.mode`; candidate discovery consults the registry. |
| `src/core/validation/ast/types.ts` | **Modify.** `AstValidatorOptions.mode`. |
| `src/core/validation/ast/index.ts` | **Modify.** `validateItemAst` forwards `mode` to `selectValidator`. |
| `src/core/validation/index.ts` | **Modify.** `ValidationOptions.mode`; forward to `validateBundleAst`. |
| `src/core/engine/index.ts` | **Modify.** `EngineOptimizationOptions.engineMode`; forward to stage options, validation, trace. |
| `src/core/model/types.ts` | **Modify.** `ParserCoverage` + `trace.parserCoverage`. |
| `src/cli/deep-backends.ts` | **Create.** Loads and registers `tokendamper-deep`. CLI-owned so core never imports it. |
| `src/cli/main.ts` | **Modify.** `--engine-mode`, `dispatch()` extraction, async registration. |
| `tools/corpus-harness/measure.js` | **Modify.** `--engine-mode` passthrough. |
| `tools/corpus-harness/deep-regions.js` | **Create.** Per-row classifier over two `measure.js` runs. |

---

### Task 1: `regions()` for TypeScript

**Files:**
- Create: `packages/deep/src/regions.ts`
- Modify: `packages/deep/src/index.ts`
- Modify: `src/core/parser/types.ts`
- Test: `test/unit/deep-backend-regions.test.ts`

**Interfaces:**
- Consumes: `createDeepBackends()` from `packages/deep/src/index.ts` (exists).
- Produces: `regionsFromTree(tree: Tree, language: DeepLanguage, options?: DeepRegionOptions): DeepRegion[]`; `DeepRegion = { start: number; end: number }`; `DeepRegionOptions = { keepDocstrings?: boolean }`. `ParserRegionOptions` exported from `src/core/parser/types.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/deep-backend-regions.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/deep-backend-regions.test.ts`
Expected: FAIL — `regions()` throws `tokendamper-deep: regions() is not implemented for typescript yet`.

- [ ] **Step 3: Create `packages/deep/src/regions.ts`**

```ts
import type { Node, Tree } from 'web-tree-sitter';

import type { DeepLanguage } from './grammars';

/** A candidate span, in the byte-offset convention the Fast scanners use. */
export interface DeepRegion {
  readonly start: number;
  readonly end: number;
}

export interface DeepRegionOptions {
  /** Keep a Python function's leading docstring outside the region (DECISIONS §58). */
  readonly keepDocstrings?: boolean;
}

/**
 * The node types whose `body` field is a candidate for elision.
 *
 * Function-like only, and that is Fast's rule expressed structurally rather than by regex:
 * `scanBraceSpans` filters on `FUNCTION_HEADER && !CONTROL_FLOW_HEADER`, so an `if`/`for`/
 * `while` block is never a candidate. The grammar already distinguishes them, which is the
 * whole reason a parser can be expected to do better here — but *better at discovery*, not at
 * policy. Widening this set to control flow would be sub-statement elision (held item G4),
 * not step 3.
 */
const TS_FUNCTION_NODES: ReadonlySet<string> = new Set([
  'function_declaration',
  'function_expression',
  'generator_function',
  'generator_function_declaration',
  'method_definition',
  'arrow_function',
]);

const GO_FUNCTION_NODES: ReadonlySet<string> = new Set(['function_declaration', 'method_declaration']);

function walk(root: Node, visit: (node: Node) => void): void {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    visit(node);
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
}

/**
 * The brace interior of a `{ … }` body node.
 *
 * `startIndex` sits on the `{` and `endIndex` one past the `}`, so the interior is
 * `[start + 1, end - 1)` — byte-for-byte what `scanBraceSpans` pushes
 * (`{ start: open + 1, end: i }`). Matching the *convention* is what lets the measurement
 * isolate discovery: if Deep emitted a different slice of the same body, every row would
 * differ for a reason that has nothing to do with which bodies were found.
 */
function braceInterior(body: Node): DeepRegion | null {
  const start = body.startIndex + 1;
  const end = body.endIndex - 1;
  return end > start ? { start, end } : null;
}

function typescriptRegions(root: Node): DeepRegion[] {
  const regions: DeepRegion[] = [];
  walk(root, (node) => {
    if (!TS_FUNCTION_NODES.has(node.type)) return;
    const body = node.childForFieldName('body');
    // An arrow function's body may be an expression (`x => x + 1`). There is no brace
    // interior to take, and Fast cannot see one either — no `{` means no span.
    if (!body || body.type !== 'statement_block') return;
    const region = braceInterior(body);
    if (region) regions.push(region);
  });
  return regions;
}

function goRegions(root: Node): DeepRegion[] {
  const regions: DeepRegion[] = [];
  walk(root, (node) => {
    if (!GO_FUNCTION_NODES.has(node.type)) return;
    const body = node.childForFieldName('body');
    if (!body || body.type !== 'block') return;
    const region = braceInterior(body);
    if (region) regions.push(region);
  });
  return regions;
}

function pythonRegions(_root: Node, _tree: Tree, _options: DeepRegionOptions): DeepRegion[] {
  // Implemented in Task 2. Returning [] here would be indistinguishable from "found nothing",
  // which is the §60 failure — so it throws until it is real.
  throw new Error('tokendamper-deep: python regions() lands in Task 2');
}

/** Converts a parse tree into candidate elision spans. Pure. */
export function regionsFromTree(
  tree: Tree,
  language: DeepLanguage,
  options: DeepRegionOptions = {},
): DeepRegion[] {
  const root = tree.rootNode;
  switch (language) {
    case 'typescript':
    case 'javascript':
      return typescriptRegions(root);
    case 'go':
      return goRegions(root);
    case 'python':
      return pythonRegions(root, tree, options);
    default:
      return [];
  }
}
```

- [ ] **Step 4: Wire it in `packages/deep/src/index.ts`**

Add the import and re-export at the top:

```ts
import { regionsFromTree, type DeepRegion, type DeepRegionOptions } from './regions';
export { type DeepRegion, type DeepRegionOptions } from './regions';
```

Change the `DeepBackend` interface member from `regions(content: string): never;` to:

```ts
  regions(content: string, options?: DeepRegionOptions): DeepRegion[];
```

Replace the `regions` property in `createBackend`'s returned object:

```ts
    regions(content: string, options?: DeepRegionOptions): DeepRegion[] {
      const tree = parser.parse(content);
      // A parse failure is not "no regions". Returning [] would elide nothing and look
      // identical to a clean file with no function bodies — §60's shape.
      if (tree === null) {
        throw new Error(`tokendamper-deep: parser returned no tree for ${language}`);
      }
      try {
        return regionsFromTree(tree, language, options ?? {});
      } finally {
        tree.delete();
      }
    },
```

`notImplemented` now has no caller. Delete it rather than leaving it — a helper that names an unimplemented step, kept past the step, is a stale claim about the build.

- [ ] **Step 5: Extend the core adapter surface**

In `src/core/parser/types.ts`, add above `ParserAdapter`:

```ts
/**
 * Options a region scan honours.
 *
 * Exists because `--keep-docstrings` (DECISIONS §58) is a caller-opted retention/size trade
 * that Fast implements *inside* `scanPythonDefBodies`. A one-argument `regions(content)` would
 * make deep mode silently ignore a flag the user passed, which is the same class of defect as
 * a check that never ran.
 */
export interface ParserRegionOptions {
  readonly keepDocstrings?: boolean;
}
```

and change the member to:

```ts
  /** Feeds `selectElisionRegions`. */
  regions(content: string, options?: ParserRegionOptions): ReadonlyArray<ElisionRegion>;
```

- [ ] **Step 6: Run the test**

Run: `npx vitest run test/unit/deep-backend-regions.test.ts`
Expected: PASS (3 tests). No `tsc` build is needed — the test imports the package source.

- [ ] **Step 7: Commit**

```bash
git add packages/deep/src/regions.ts packages/deep/src/index.ts src/core/parser/types.ts test/unit/deep-backend-regions.test.ts
git commit -m "feat(deep): regions() for TypeScript, in Fast's span convention"
```

---

### Task 2: `regions()` for Python, including `keepDocstrings`

**Files:**
- Modify: `packages/deep/src/regions.ts`
- Test: `test/unit/deep-backend-regions.test.ts`

**Interfaces:**
- Consumes: `DeepRegion`, `DeepRegionOptions`, `walk` from Task 1.
- Produces: `pythonRegions` (module-private), reached through `regionsFromTree(tree, 'python', options)`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/deep-backend-regions.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/deep-backend-regions.test.ts -t python`
Expected: FAIL — `python regions() lands in Task 2`.

- [ ] **Step 3: Replace the stub with the implementation**

In `packages/deep/src/regions.ts`, delete the throwing stub and add in its place:

```ts
/**
 * Extends `index` to the end of the line containing it, excluding the `\n`.
 *
 * Reproduces `scanPythonDefBodies`'s `lineAt(last).end`, which is `nextLineStart - 1`. On a
 * CRLF file that position is the `\r`, so the region includes it — matching Fast exactly,
 * because a region that stopped one byte earlier would differ on every CRLF row for a reason
 * unrelated to discovery. This repository's own corpus is CRLF (DECISIONS §45).
 */
function endOfLineContaining(content: string, index: number): number {
  const newline = content.indexOf('\n', index);
  return newline === -1 ? content.length : newline;
}

/** Whether a block's first statement is a bare string expression — i.e. a docstring. */
function firstStatementIsDocstring(block: Node): boolean {
  const first = block.namedChild(0);
  if (!first || first.type !== 'expression_statement') return false;
  const inner = first.namedChild(0);
  return inner !== null && inner.type === 'string';
}

function pythonRegions(root: Node, tree: Tree, options: DeepRegionOptions): DeepRegion[] {
  const content = tree.rootNode.text;
  const regions: DeepRegion[] = [];

  walk(root, (node) => {
    if (node.type !== 'function_definition') return;
    const block = node.childForFieldName('body');
    if (!block || block.type !== 'block') return;

    // The block's first token is already the first non-whitespace character of the body,
    // which is what `firstBody.start + bodyIndent` computes lexically.
    let first = block.namedChild(0);
    if (options.keepDocstrings && firstStatementIsDocstring(block)) {
      first = block.namedChild(1);
    }
    if (!first) return;

    const start = first.startIndex;
    const end = endOfLineContaining(content, block.endIndex - 1);
    if (end > start) regions.push({ start, end });
  });

  return regions;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/deep-backend-regions.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/deep/src/regions.ts test/unit/deep-backend-regions.test.ts
git commit -m "feat(deep): regions() for Python, honouring keepDocstrings"
```

---

### Task 3: Go coverage, and pinning the span convention against Fast

**Files:**
- Modify: `packages/deep/src/regions.ts` (only if the agreement test reveals a convention gap)
- Test: `test/unit/deep-backend-regions.test.ts`

**Interfaces:**
- Consumes: `goRegions` from Task 1; `selectElisionRegions` from `src/core/elision/regions.ts`.
- Produces: nothing new. This task asserts Task 1's Go arm and fixes any off-by-one in how a span is expressed.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/deep-backend-regions.test.ts`, with these imports added at the top of the file:

```ts
import { selectElisionRegions } from '../../src/core/elision/regions';
import { createContextItem } from '../../src/core/model/constructors';
```

```ts
describe('deep regions() — go', () => {
  it('takes a func body and a method body', async () => {
    const backends = await createDeepBackends();
    const go = backends.find((b) => b.language === 'go')!;
    const src =
      'package main\n\nfunc add(a, b int) int {\n\treturn a + b\n}\n\nfunc (p *Point) X() int {\n\treturn p.x\n}\n';
    const regions = go.regions(src);

    expect(regions).toHaveLength(2);
    expect(src.slice(regions[0]!.start, regions[0]!.end)).toBe('\n\treturn a + b\n');
    expect(src.slice(regions[1]!.start, regions[1]!.end)).toBe('\n\treturn p.x\n');
  });

  it('does not take a struct body, which is not a function', async () => {
    const backends = await createDeepBackends();
    const go = backends.find((b) => b.language === 'go')!;
    expect(go.regions('package main\n\ntype Point struct {\n\tx int\n}\n')).toHaveLength(0);
  });
});

describe('deep regions() agree with Fast on straightforward source', () => {
  // Not a demand that they always agree — step 3's assertion is explicitly not identity.
  // This pins the *convention*: on source containing no construct either scanner finds
  // ambiguous, the two produce the same spans, so a later difference is a real discovery
  // difference rather than an off-by-one in how a span is expressed.
  const cases = [
    {
      language: 'typescript',
      path: '/tmp/a.ts',
      content: 'export function f(a: number) {\n  const b = a * 2;\n  return b;\n}\n',
    },
    {
      language: 'go',
      path: '/tmp/a.go',
      content: 'package main\n\nfunc f(a int) int {\n\tb := a * 2\n\treturn b\n}\n',
    },
    {
      language: 'python',
      path: '/tmp/a.py',
      content: 'def f(a):\n    b = a * 2\n    return b\n',
    },
  ];

  it.each(cases)('$language', async ({ language, path, content }) => {
    const backends = await createDeepBackends();
    const backend = backends.find((b) => b.language === language)!;
    const item = createContextItem({ id: 'i1', kind: 'file', content, path, language });

    const fast = selectElisionRegions(item).map((r) => ({ start: r.start, end: r.end }));
    const deep = backend.regions(content).map((r) => ({ start: r.start, end: r.end }));

    expect(deep).toEqual(fast);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/unit/deep-backend-regions.test.ts`
Expected: the two Go cases PASS from Task 1's implementation. The agreement test may FAIL — if it does, that failure is the point of this task.

- [ ] **Step 3: Reconcile the convention if the agreement test failed**

Only `packages/deep/src/regions.ts` may change; the Fast side is read-only. Read the actual vs expected offsets before editing. The two likely causes, in order: a Python block whose last line carries a trailing comment (tree-sitter may end the block before it — `endOfLineContaining` is what absorbs it), and a TypeScript body whose `}` is not the last character on its line. If the difference turns out to be semantic rather than an expression mismatch, leave it and record it in the commit message — that is measurement evidence, not a bug.

- [ ] **Step 4: Run the related suites**

Run: `npx vitest run test/unit/deep-backend-regions.test.ts test/unit/parser-adapter-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/deep/src/regions.ts test/unit/deep-backend-regions.test.ts
git commit -m "feat(deep): regions() for Go, and pin the span convention against Fast"
```

---

### Task 4: Core consults the registry for candidate spans

**Files:**
- Modify: `src/core/elision/regions.ts:1013-1108`
- Test: `test/unit/elision-regions-mode.test.ts`

**Interfaces:**
- Consumes: `resolveParserBackend(language)` from `src/core/parser/registry.ts`; `EngineMode`, `DEFAULT_ENGINE_MODE` from `src/core/parser/types.ts`.
- Produces: `SelectRegionsOptions.mode?: EngineMode`; `regionElisionLanguage(item, mode?)`; `supportsRegionElision(item, mode?)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/elision-regions-mode.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/elision-regions-mode.test.ts`
Expected: FAIL — `mode` is not a recognised option, so the deep-mode cases return Fast's spans.

- [ ] **Step 3: Implement**

Add to the imports in `src/core/elision/regions.ts`:

```ts
import { resolveParserBackend } from '../parser/registry';
import { DEFAULT_ENGINE_MODE, type EngineMode } from '../parser/types';
```

Extend `SelectRegionsOptions`:

```ts
  /**
   * Which backend answers the candidate scan. `fast` (the default) never reads the registry.
   *
   * Deep replaces **discovery only**: every filter below — `dropOverlapping`, `minBytes`,
   * `isSubstantiveRegion` — and everything downstream in `token-hashing`
   * (`trimRegionsToCeiling`, `splitRegionIntoStatements`) still runs unchanged. That is what
   * makes a differing corpus row attributable: one thing moved.
   */
  readonly mode?: EngineMode;
```

Change the two exported predicates:

```ts
export function regionElisionLanguage(
  item: ContextItem,
  mode: EngineMode = DEFAULT_ENGINE_MODE,
): RegionElisionLanguage | undefined {
  const language = selectValidator(item, mode)?.language;
  return language !== undefined && (REGION_ELISION_LANGUAGES as ReadonlyArray<string>).includes(language)
    ? (language as RegionElisionLanguage)
    : undefined;
}

export function supportsRegionElision(item: ContextItem, mode: EngineMode = DEFAULT_ENGINE_MODE): boolean {
  return regionElisionLanguage(item, mode) !== undefined;
}
```

Replace the head of `selectElisionRegions` down to and including the `candidates` assignment:

```ts
  const mode = options?.mode ?? DEFAULT_ENGINE_MODE;
  const language = regionElisionLanguage(item, mode);
  if (language === undefined) {
    return [];
  }

  const minBytes = options?.minRegionBytes ?? MIN_REGION_BYTES;
  const content = item.content;
  const keepDocstrings = options?.keepDocstrings ?? false;

  const backend = mode === 'deep' ? resolveParserBackend(language) : undefined;
  const candidates: ElisionRegion[] = backend
    ? [...backend.regions(content, { keepDocstrings })]
    : language === 'python'
      ? [...scanPythonDefBodies(content, keepDocstrings)]
      : language === 'go'
        ? scanGoBraceSpans(content)
            .filter((span) => GO_FUNCTION_HEADER.test(span.header))
            .map((span) => ({ start: span.start, end: span.end }))
        : scanBraceSpans(content)
            .filter((span) => FUNCTION_HEADER.test(span.header) && !CONTROL_FLOW_HEADER.test(span.header))
            .map((span) => ({ start: span.start, end: span.end }));
```

The `return Object.freeze(dropOverlapping(candidates).filter(...))` tail is unchanged.

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/unit/elision-regions-mode.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Check Fast did not move**

Run: `npx vitest run test/unit/target-reduction-ratio.test.ts test/unit/validator-guarantee.test.ts`
Expected: PASS — these pin the Fast elision path's measured behaviour.

- [ ] **Step 6: Commit**

```bash
git add src/core/elision/regions.ts test/unit/elision-regions-mode.test.ts
git commit -m "feat(core): selectElisionRegions consults the parser registry in deep mode"
```

---

### Task 5: Thread the mode into validation

**Files:**
- Modify: `src/core/validation/ast/types.ts` (`AstValidatorOptions`)
- Modify: `src/core/validation/ast/index.ts:214-260`
- Modify: `src/core/validation/index.ts:23-43`
- Test: `test/unit/validation-mode-thread.test.ts`

**Interfaces:**
- Consumes: `selectValidator(item, mode)` (exists since §80).
- Produces: `AstValidatorOptions.mode?: EngineMode`; `ValidationOptions.mode?: EngineMode`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/validation-mode-thread.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { clearParserBackends, registerParserBackend } from '../../src/core/parser/registry';
import { validateBundleAst } from '../../src/core/validation/ast';
import { createContextBundle, createContextItem } from '../../src/core/model/constructors';
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
    createContextBundle({
      items: [
        createContextItem({
          id: 'i1',
          kind: 'file',
          content: 'const a = 1;\n',
          path: '/tmp/a.ts',
          language: 'typescript',
        }),
      ],
    });

  it('fast mode ignores a registered backend', () => {
    registerParserBackend(rejecting);
    expect(validateBundleAst(bundle()).valid).toBe(true);
  });

  it('deep mode consults it', () => {
    registerParserBackend(rejecting);
    expect(validateBundleAst(bundle(), { mode: 'deep' }).valid).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/validation-mode-thread.test.ts`
Expected: FAIL on the second case — `validateBundleAst` never passes a mode, so the stub is not consulted.

- [ ] **Step 3: Break the import cycle first**

`src/core/parser/types.ts` already imports `AstCheckResult`/`AstValidatorOptions`/`TargetLanguage` from `../validation/ast/types`. Having `ast/types.ts` import `EngineMode` back from `parser/types` closes a cycle. Type-only cycles are legal TypeScript, but they are fragile under `isolatedModules` and the repo's import lint, so extract instead.

Create `src/core/parser/mode.ts` — it imports nothing:

```ts
/**
 * Which engine backend answers the three language questions.
 *
 * Lives in its own module rather than in `types.ts` because `AstValidatorOptions` needs it and
 * `parser/types.ts` already imports from `validation/ast/types.ts` — putting it there closes an
 * import cycle. `types.ts` re-exports both names, so every existing import keeps working.
 *
 * **Invariant 1 is per-configuration, and this type is why.** "Same input, same bytes out"
 * reads as absolute in `ARCHITECTURE.md`; with a second backend it becomes *same input, same
 * mode, same bytes out*. Fast and Deep differing on one file is the feature rather than a
 * violation — what would be a violation is either of them being non-deterministic within itself.
 */
export type EngineMode = 'fast' | 'deep';

/** The default, and the only value any shipped entry mode passes today. */
export const DEFAULT_ENGINE_MODE: EngineMode = 'fast';
```

In `src/core/parser/types.ts`, delete the local `EngineMode` and `DEFAULT_ENGINE_MODE` declarations (keeping the doc comment with the type in its new home) and re-export:

```ts
export { DEFAULT_ENGINE_MODE, type EngineMode } from './mode';
```

Run `npx tsc -p tsconfig.json --noEmit` before continuing. Every existing importer of `EngineMode` from `parser/types` must still compile untouched.

- [ ] **Step 4: Implement**

In `src/core/validation/ast/types.ts`, add `import type { EngineMode } from '../../parser/mode';` and extend:

```ts
export interface AstValidatorOptions {
  /**
   * Maximum allowed execution duration in milliseconds. Defaults to 5ms SLA per item.
   */
  readonly maxTimeMs?: number;
  /**
   * Which backend answers. `fast` (the default) never reads the parser registry.
   *
   * Threaded rather than read from a module global so two bundles validated in one process
   * cannot silently share a mode.
   */
  readonly mode?: EngineMode;
}
```

In `src/core/validation/ast/index.ts` line 218:

```ts
  const validator = selectValidator(item, options?.mode);
```

In the same file, confirm `validateBundleAst` forwards its `options` to each `validateItemAst(item, options)` call rather than dropping it; if it calls `validateItemAst(item)`, add the argument.

In `src/core/validation/index.ts`:

```ts
export interface ValidationOptions {
  readonly maxDriftThreshold?: number | undefined;
  /** Which backend answers AST validation. Drift keeps the shipped extractor regardless. */
  readonly mode?: EngineMode | undefined;
}
```

and at line 41:

```ts
  const astResult = validateBundleAst(after, options?.mode ? { mode: options.mode } : undefined);
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run test/unit/validation-mode-thread.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/core/parser/mode.ts src/core/parser/types.ts src/core/validation test/unit/validation-mode-thread.test.ts
git commit -m "feat(core): thread EngineMode through validation so deep check() runs live"
```

---

### Task 6: `ParserCoverage` — the evidence that Deep actually ran

**Files:**
- Create: `src/core/parser/coverage.ts`
- Modify: `src/core/model/types.ts` (add `ParserCoverage`; add the field to both trace shapes at ~375 and ~428)
- Modify: `src/core/model/constructors.ts` (the two `astCoverage` pass-through sites, 439 and 466)
- Modify: `src/core/trace/index.ts:93`
- Test: `test/unit/parser-coverage.test.ts`

**Interfaces:**
- Consumes: `registeredParserLanguages()`, `resolveParserBackend()`, `selectValidator(item, 'fast')`.
- Produces: `parserCoverage(bundle: ContextBundle, mode: EngineMode): ParserCoverage`, where `ParserCoverage = { mode, registeredLanguages, backendAnswered, fastAnswered }`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/parser-coverage.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/parser-coverage.test.ts`
Expected: FAIL — `src/core/parser/coverage.ts` does not exist.

- [ ] **Step 3: Add `ParserCoverage` to the model**

In `src/core/model/types.ts`, beside `AstCoverage`, with `import type { EngineMode } from '../parser/mode';` (the cycle-free module Task 5 created — **not** `parser/types`, which imports `validation/ast/types`):

```ts
/**
 * Whether a Deep backend actually answered for the items in this bundle.
 *
 * **This block exists because `--engine-mode deep` producing byte-identical output and
 * `--engine-mode deep` never having run are otherwise the same observation.** That confusion
 * is invariant 10, which this project has recorded ten instances of; `astCoverage` (§23) and
 * `driftCoverage` (§33) are the two earlier answers to the same question, and this is the
 * third.
 */
export interface ParserCoverage {
  readonly mode: EngineMode;
  readonly registeredLanguages: ReadonlyArray<string>;
  readonly backendAnswered: number;
  readonly fastAnswered: number;
}
```

Add to **both** trace interfaces, beside `astCoverage?: AstCoverage | undefined;`:

```ts
  readonly parserCoverage?: ParserCoverage | undefined;
```

Mirror the pass-through at both `constructors.ts` sites and at `trace/index.ts:93`:

```ts
    ...(trace.parserCoverage === undefined ? {} : { parserCoverage: trace.parserCoverage }),
```

- [ ] **Step 4: Create `src/core/parser/coverage.ts`**

```ts
import type { ContextBundle, ParserCoverage } from '../model/types';
import { selectValidator } from '../validation/ast';
import { registeredParserLanguages, resolveParserBackend } from './registry';
import type { EngineMode } from './types';

/**
 * Computed from the *Fast-resolved* language, which is the same key `selectValidator` uses to
 * find a backend — so a language with no registered backend is reported as answered by Fast
 * rather than silently counted as covered.
 */
export function parserCoverage(bundle: ContextBundle, mode: EngineMode): ParserCoverage {
  let backendAnswered = 0;
  let fastAnswered = 0;

  for (const item of bundle.items) {
    const language = selectValidator(item, 'fast')?.language;
    const covered = mode === 'deep' && language !== undefined && resolveParserBackend(language) !== undefined;
    if (covered) backendAnswered += 1;
    else fastAnswered += 1;
  }

  return Object.freeze({
    mode,
    registeredLanguages: registeredParserLanguages(),
    backendAnswered,
    fastAnswered,
  });
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/unit/parser-coverage.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS (3 tests), no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/parser/coverage.ts src/core/model/types.ts src/core/model/constructors.ts src/core/trace/index.ts test/unit/parser-coverage.test.ts
git commit -m "feat(core): ParserCoverage, so a deep run says whether Deep answered"
```

---

### Task 7: Engine accepts and forwards `engineMode`

**Files:**
- Modify: `src/core/engine/index.ts` — options (~56), stage options (~88-95), every `validate(` call, the three trace-assembly sites (~311, ~333, ~358)
- Modify: `src/stages/compression/token-hashing.ts:43`, `:190`
- Test: `test/unit/engine-mode.test.ts`

**Interfaces:**
- Consumes: `parserCoverage(bundle, mode)` from Task 6; `SelectRegionsOptions.mode` from Task 4; `ValidationOptions.mode` from Task 5.
- Produces: `EngineOptimizationOptions.engineMode?: EngineMode`; `TokenHashingStageOptions.mode?: EngineMode`; `trace.parserCoverage` populated on every run.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/engine-mode.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/engine-mode.test.ts`
Expected: FAIL — `engineMode` is not an option and `trace.parserCoverage` is undefined.

- [ ] **Step 3: Implement the stage option**

In `src/stages/compression/token-hashing.ts`, add beside `keepDocstrings` (line 43), importing `EngineMode` from `../../core/parser/types`:

```ts
  /** Which backend discovers candidate regions. Defaults to `fast`. */
  readonly mode?: EngineMode;
```

and at line 190:

```ts
    const allRegions = selectElisionRegions(item, {
      keepDocstrings: options?.keepDocstrings ?? false,
      ...(options?.mode ? { mode: options.mode } : {}),
    });
```

- [ ] **Step 4: Implement the engine option**

In `src/core/engine/index.ts`, add to `EngineOptimizationOptions`:

```ts
  /**
   * Which backend answers the three language questions. `fast` is the default and the only
   * value any shipped entry mode passed before R3.
   *
   * Invariant 1 is per-*configuration*: fast and deep may legitimately differ on one file.
   * What would be a violation is either of them being non-deterministic within itself.
   */
  readonly engineMode?: EngineMode;
```

Change the `tokenHashingOptions` construction so the mode alone is enough to build it:

```ts
    const tokenHashingOptions: TokenHashingStageOptions | undefined =
      options?.tokenHasher || options?.keepDocstrings || options?.engineMode
        ? {
            ...(options?.tokenHasher ? { tokenHasher: options.tokenHasher } : {}),
            ...(options?.keepDocstrings ? { keepDocstrings: true } : {}),
            ...(options?.engineMode ? { mode: options.engineMode } : {}),
          }
        : undefined;
```

Add the mode to the options argument of every `validate(` call in the file:

```ts
      ...(options?.engineMode ? { mode: options.engineMode } : {}),
```

At each of the three trace-assembly sites, add beside the `astCoverage` spread:

```ts
        parserCoverage: parserCoverage(currentBundle, options?.engineMode ?? DEFAULT_ENGINE_MODE),
```

**Check each site individually** rather than pasting `currentBundle` three times — the fallback site reports the pre-optimization bundle, and naming the wrong one there would report coverage for a bundle the run did not emit.

- [ ] **Step 5: Run the test**

Run: `npx vitest run test/unit/engine-mode.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. Any failure here is Fast behaviour moving — investigate before continuing.

- [ ] **Step 7: Commit**

```bash
git add src/core/engine/index.ts src/stages/compression/token-hashing.ts test/unit/engine-mode.test.ts
git commit -m "feat(core): engine accepts engineMode and reports parser coverage"
```

---

### Task 8: `--engine-mode` on the CLI, refusing a deep run with no backends

**Files:**
- Create: `src/cli/deep-backends.ts`
- Modify: `src/cli/main.ts` — `ParsedArguments` (~534), `SUPPORTED_FLAGS` (~599), parse loop (~822), `parsed` assembly (~949), request options (~256, ~353), `runCli`/`dispatch` split (32-40)
- Test: `test/unit/cli/engine-mode-flag.test.ts`

**Interfaces:**
- Consumes: `createDeepBackends()` from `packages/deep`; `registerParserBackend` from the core registry.
- Produces: `ParsedArguments.engineMode?: 'fast' | 'deep'`; `registerDeepBackends(): Promise<number>` returning the count registered.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/cli/engine-mode-flag.test.ts
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { runCli } from '../../../src/cli/main';

function io() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (c) => (out += String(c)));
  stderr.on('data', (c) => (err += String(c)));
  return {
    stdout,
    stderr,
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

describe('--engine-mode', () => {
  it('rejects a value that is neither fast nor deep', () => {
    const streams = io();
    const code = runCli(['optimize', 'README.md', '--engine-mode', 'turbo'], streams);
    expect(code).toBe(1);
    expect(streams.err).toContain('Accepted values: fast, deep');
  });

  it('is refused on a command that does not consume it', () => {
    const streams = io();
    const code = runCli(['mcp', '--engine-mode', 'deep'], streams);
    expect(code).toBe(1);
    expect(streams.err).toContain('--engine-mode');
  });

  it('accepts fast explicitly and behaves as the default', () => {
    const streams = io();
    expect(runCli(['optimize', 'README.md', '--engine-mode', 'fast'], streams)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/cli/engine-mode-flag.test.ts`
Expected: FAIL — `--engine-mode` is unrecognised, so the first case's message does not match.

- [ ] **Step 3: Create `src/cli/deep-backends.ts`**

```ts
import { registerParserBackend } from '../core/parser/registry';
import type { ParserAdapter } from '../core/parser/types';

interface DeepModule {
  createDeepBackends(): Promise<ReadonlyArray<ParserAdapter>>;
}

/**
 * Loads `tokendamper-deep` and registers every backend it carries.
 *
 * **Two resolution paths, and the order is the migration.** The bare specifier is the R4
 * shape, once the package is published or linked. The repo-relative path is the R3 shape: the
 * package is `private: true` and the workspace is not linked into `node_modules`, and linking
 * it means an `npm install` that reaches the main checkout. `deep-parity.js` resolves it
 * exactly this way and prints the same build instruction.
 *
 * **An empty registry is an error, not a fall-through.** `--engine-mode deep` that silently
 * ran Fast is invariant 10 in its purest form — a green result from a path that never
 * executed. DECISIONS §54 set the precedent when an unrecognised `TOKENDAMPER_*` enum value
 * became a hard error rather than a silent default.
 */
export async function registerDeepBackends(): Promise<number> {
  const mod = await loadDeepModule();
  const backends = await mod.createDeepBackends();

  let registered = 0;
  for (const backend of backends) {
    // JavaScript is deliberately not registered: no Fast validator ever returns the language
    // `javascript` — `.js` resolves to the TypeScript validator, whose `language` is
    // `typescript` — so a backend registered under that key could never be resolved. Putting
    // it in the registry anyway would make `registeredLanguages` claim coverage that nothing
    // can reach. DECISIONS §81.
    if (backend.language === 'javascript') continue;
    registerParserBackend(backend);
    registered += 1;
  }

  if (registered === 0) {
    throw new Error(
      'tokendamper: --engine-mode deep registered no parser backends. Refusing to run, because ' +
        'falling back to the fast path here would report a deep run that never happened.',
    );
  }
  return registered;
}

async function loadDeepModule(): Promise<DeepModule> {
  const candidates = ['tokendamper-deep', '../../packages/deep/dist/index.js'];
  const failures: string[] = [];

  for (const specifier of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require(specifier) as DeepModule;
    } catch (err) {
      failures.push(`${specifier}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(
    'tokendamper: --engine-mode deep could not load tokendamper-deep. It is unpublished in R3, ' +
      'so build it first:\n  npx tsc -p packages/deep/tsconfig.json\nTried:\n  ' +
      failures.join('\n  '),
  );
}
```

- [ ] **Step 4: Add the flag to `src/cli/main.ts`**

Add to `ParsedArguments` beside `keepDocstrings`:

```ts
  /** `--engine-mode`: which parser backend answers. `fast` (default) or `deep`. */
  readonly engineMode?: 'fast' | 'deep';
```

`SUPPORTED_FLAGS` is `Readonly<Record<'optimize' | 'bench' | 'mcp', ReadonlySet<string>>>`, where each command's set spreads `COMMON_FLAGS` and adds its own. Add `'--engine-mode'` to the **`optimize` and `bench` sets individually** — **not** to `COMMON_FLAGS`, because `mcp: new Set(COMMON_FLAGS)` would then accept a flag its branch does not consume. DECISIONS §30: a flag is listed where `runCli` actually reads it.

In the parse loop, beside the `--keep-docstrings` case, with `let engineMode: 'fast' | 'deep' = 'fast';` declared beside `let keepDocstrings = false;`. The value idiom is `args.shift()`, matching `--mode` and `--language` — there is no `nextValue` helper in this file:

```ts
    if (flag === '--engine-mode') {
      const value = args.shift();
      if (value !== 'fast' && value !== 'deep') {
        throw new Error('Invalid value for --engine-mode. Accepted values: fast, deep.');
      }
      engineMode = value;
      continue;
    }
```

Note this rejects a missing value with the same message as a bad one, which is what `--mode` does (`main.ts:709-720`). `--language` instead throws a separate "Missing value" first; either is consistent with some precedent in this file, and matching `--mode` is the closer analogue since both are closed enums.

In the `parsed` assembly, beside the `keepDocstrings` spread:

```ts
    ...(engineMode === 'deep' ? { engineMode } : {}),
```

At the two request-option sites (~256, ~353), beside the `keepDocstrings` spread:

```ts
      ...(parsed.engineMode ? { engineMode: parsed.engineMode } : {}),
```

- [ ] **Step 5: Split `runCli` so registration can await**

`runCli` already returns `number | Promise<number>` (the `exec` path) and `main()` already handles both, so nothing above this changes. Extract everything after `const parsed = parseArguments(argv, cwd);` into a new function, leaving the body byte-identical:

```ts
function dispatch(
  parsed: ParsedArguments,
  io: { readonly stdout: NodeJS.WritableStream; readonly stderr: NodeJS.WritableStream },
  cwd: string,
): number | Promise<number> {
  // ... the existing body, moved verbatim
}
```

and make `runCli`'s `try` block:

```ts
    const parsed = parseArguments(argv, cwd);

    if (parsed.engineMode === 'deep') {
      // Registration is the one place async work is allowed (`ParserAdapter` is otherwise
      // sync), so it happens here, before the pipeline runs.
      return registerDeepBackends()
        .then(() => dispatch(parsed, io, cwd))
        .catch((err: unknown) => {
          io.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
          return 1;
        });
    }

    return dispatch(parsed, io, cwd);
```

The existing `catch` is unchanged.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/unit/cli/engine-mode-flag.test.ts && npm test`
Expected: PASS. The full suite matters here — the `dispatch` extraction touches every CLI path.

- [ ] **Step 7: Verify the tarball is unaffected**

Run: `npm pack --dry-run`
Expected: entry count and size unchanged from the pre-task baseline (`223` entries at v1.7.2's narrowing). `packages/` must not appear.

- [ ] **Step 8: Commit**

```bash
git add src/cli/deep-backends.ts src/cli/main.ts test/unit/cli/engine-mode-flag.test.ts
git commit -m "feat(cli): --engine-mode fast|deep, refusing a deep run with no backends"
```

---

### Task 9: Harness — two runs over one frozen corpus, and a classifier

**Files:**
- Modify: `tools/corpus-harness/measure.js` (arg parsing ~204-210, CLI arg construction ~76-77)
- Create: `tools/corpus-harness/deep-regions.js`

**Interfaces:**
- Consumes: `measure.js`'s existing per-row JSON output.
- Produces: `node tools/corpus-harness/deep-regions.js <fast-run-dir> <deep-run-dir> --out <file.json>`.

- [ ] **Step 1: Add the passthrough to `measure.js`**

Accept `--engine-mode <fast|deep>` in the arg parser, defaulting to undefined, and append it to the CLI args built at lines 76-77:

```js
  if (engineMode) args.push('--engine-mode', engineMode);
```

Refuse an unrecognised value in the harness rather than passing it through — a typo the CLI then rejects fails every row identically and reads like a corpus problem. Name the flag in the usage line.

**Also add three fields to the row writer** (the object returned around lines 115-151), beside the existing `astChecked` / `driftMeasured` lines. The classifier needs all three and none exists today:

```js
    parserMode: t?.parserCoverage?.mode ?? null,
    parserBackendAnswered: t?.parserCoverage?.backendAnswered ?? null,
    // The only per-row evidence of *why* a fallback happened. Written at trace/index.ts:85.
    fallbackReason: t?.fallbackReason ?? null,
```

- [ ] **Step 2: Verify the passthrough**

Run: `node tools/corpus-harness/measure.js`
Expected: the usage line now names `--engine-mode`.

- [ ] **Step 3: Create `tools/corpus-harness/deep-regions.js`**

```js
#!/usr/bin/env node
'use strict';

/**
 * R3 step 3 — classifies every row where deep-mode output differs from fast-mode output.
 *
 * Usage:
 *   node tools/corpus-harness/deep-regions.js <fast-run-dir> <deep-run-dir> --out <file.json>
 *
 * ## Why two fallback numbers and not one
 *
 * §3.5 says "fallbacks must not rise". Taken as one number that assertion is unusable here,
 * because step 3 also makes Deep's `check()` live, and §80 measured a 9.28% TypeScript
 * disagreement rate — much of it Deep being *wrong* where the grammar lags the language.
 * Those fallbacks have nothing to do with region discovery. So each new fallback is
 * attributed:
 *
 *   - **validator-attributable** — the deep row's trace carries an AST issue. Reported,
 *     predicted by §80, and not gated.
 *   - **region-attributable** — everything else. **This is the number §3.5 gates.**
 *
 * Collapsing them would let a region regression hide behind a known validator disagreement.
 *
 * ## What it refuses
 *
 *  - an empty comparison set — the shape a bad glob produces, and it reads as agreement
 *  - a row present in one run and missing from the other
 *  - a deep run whose `parserCoverage.backendAnswered` is 0 on every row: that is a deep run
 *    that never ran deep, and it would report perfect agreement
 */

const fs = require('fs');
const path = require('path');

/**
 * Reads one measure.js run.
 *
 * The file is `results-<variant>.jsonl` — **JSONL, one object per line**, not a JSON array —
 * and a row's identity is `corpusPath` **and** `route`, because measure.js runs every file
 * through both routes and asserts `rows.length === files × routes`. Keying on the path alone
 * silently collapses each pair, halving the comparison while still reporting agreement.
 */
function readRows(dir) {
  const matches = fs.readdirSync(dir).filter((f) => f.startsWith('results-') && f.endsWith('.jsonl'));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one results-*.jsonl in ${dir}, found ${matches.length}`);
  }
  const text = fs.readFileSync(path.join(dir, matches[0]), 'utf8');
  const byKey = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    byKey.set(`${row.corpusPath} ${row.route}`, row);
  }
  return byKey;
}

/**
 * AST validation issues are formatted `AST Error in item [<id>] at line …` by
 * `validation/index.ts`, so a fallback reason carrying that prefix is the deep validator
 * refusing the file — §80's predicted disagreement, not a region defect.
 */
function isValidatorFallback(row) {
  return typeof row.fallbackReason === 'string' && row.fallbackReason.includes('AST Error');
}

function classify(fastRow, deepRow) {
  if (fastRow.outputSha === deepRow.outputSha) return 'identical';
  if (!fastRow.fallbackUsed && deepRow.fallbackUsed) {
    return isValidatorFallback(deepRow) ? 'new-fallback-validator' : 'new-fallback-region';
  }
  if (fastRow.fallbackUsed && !deepRow.fallbackUsed) return 'recovered';
  if (deepRow.outputBytes < fastRow.outputBytes) return 'differs-deep-smaller';
  if (deepRow.outputBytes > fastRow.outputBytes) return 'differs-deep-larger';
  return 'differs-same-size';
}

function main() {
  const [fastDir, deepDir, ...rest] = process.argv.slice(2);
  const outIndex = rest.indexOf('--out');
  if (!fastDir || !deepDir || outIndex === -1) {
    console.error('usage: deep-regions.js <fast-run-dir> <deep-run-dir> --out <file.json>');
    process.exit(2);
  }
  const outFile = rest[outIndex + 1];

  const fast = readRows(fastDir);
  const deep = readRows(deepDir);

  if (fast.size === 0) throw new Error('refusing: the fast run has 0 rows');
  if (fast.size !== deep.size) {
    throw new Error(`refusing: ${fast.size} fast rows vs ${deep.size} deep rows — not the same corpus`);
  }

  let backendAnswered = 0;
  const buckets = {};
  const differing = [];

  for (const [key, fastRow] of fast) {
    const deepRow = deep.get(key);
    if (!deepRow) {
      throw new Error(`refusing: ${fastRow.corpusPath} (${fastRow.route}) is missing from the deep run`);
    }
    backendAnswered += deepRow.parserBackendAnswered ?? 0;

    const verdict = classify(fastRow, deepRow);
    buckets[verdict] = (buckets[verdict] ?? 0) + 1;
    if (verdict !== 'identical') {
      differing.push({
        path: fastRow.corpusPath,
        route: fastRow.route,
        verdict,
        fastBytes: fastRow.outputBytes,
        deepBytes: deepRow.outputBytes,
        fastFallback: fastRow.fallbackUsed,
        deepFallback: deepRow.fallbackUsed,
        // Left empty on purpose: §3.5 requires every differing row be read by a person.
        classification: '',
      });
    }
  }

  if (backendAnswered === 0) {
    throw new Error(
      'refusing: no row in the deep run reports parserCoverage.backendAnswered > 0. ' +
        'That is a deep run in which Deep never answered, and it would report perfect agreement.',
    );
  }

  const report = { rows: fast.size, backendAnswered, buckets, differing };
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`${fast.size} rows, ${differing.length} differing, ${backendAnswered} backend answers`);
  console.log(JSON.stringify(buckets, null, 2));
}

main();
```

`outputSha`, `outputBytes`, `fallbackUsed`, `corpusPath` and `route` already exist on a measure.js row; `parserMode`, `parserBackendAnswered` and `fallbackReason` are the three Step 1 adds. **A diff keyed on a field the harness does not emit collapses the comparison and reports no differences** — that exact no-op has happened in this project, and measure.js's own `outputSha` comment records it (`undefined === undefined` across 578 rows, reported as "0 changed"). After the first run, spot-check one row of each results file and confirm all three new fields are non-null on the deep side.

- [ ] **Step 4: Commit**

```bash
git add tools/corpus-harness/measure.js tools/corpus-harness/deep-regions.js
git commit -m "feat(harness): --engine-mode passthrough and a per-row deep/fast classifier"
```

---

### Task 10: Run the measurement, classify every row, and record §81

**Files:**
- Modify: `DECISIONS.md` (append §81)
- Modify: `ROADMAP.md` (R3 row and the R3 section's exit line)
- Modify: `CLAUDE.md` (the R3 bullet — it currently says R3 is "NEXT, and not started — `src/core/parser/` does not exist", which has been false since `99a7608`)
- Modify: `CHANGELOG.md`
- Delete: `docs/r3-start-here.md` (its own instruction, once R3 lands)

**Interfaces:**
- Consumes: everything above.
- Produces: the measurement that *is* R3's deliverable.

- [ ] **Step 1: Freeze the corpus**

Run: `node tools/corpus-harness/collect.js`
Expected: a frozen corpus directory with a `sha256` manifest and a pinned commit. If `recipe.json`'s `expect` refuses because this repo gained files, update `expect` **and** name the file that moved it in `recipe.json`'s `$comment` — that refusal is the harness working. Note that deleting `docs/r3-start-here.md` in Step 9 moves the prose count back by one.

- [ ] **Step 2: Re-baseline timing on this machine**

Run: `node tools/corpus-harness/timing-run.js`
Expected: cold/warm p50 and a parity count. §76's 159.1ms/3.8ms are machine-specific and did not reproduce on this machine (114.0ms/3.3ms on 2026-09-19). Record what this run says; do not compare to §76's numbers.

- [ ] **Step 3: Build both sides**

Run: `npm run build && npx tsc -p packages/deep/tsconfig.json`
Expected: both succeed. **A failed build leaves the previous `dist/`, which silently compares an engine against itself** — confirm both emitted.

- [ ] **Step 4: Run the corpus twice**

```bash
node tools/corpus-harness/measure.js <out>/fast --ratio 0.3 --engine-mode fast
node tools/corpus-harness/measure.js <out>/deep --ratio 0.3 --engine-mode deep
```

Expected: equal row counts; the deep run reports non-zero `backendAnswered`.

- [ ] **Step 5: Run the Go corpus separately**

The main `recipe.json` has no Go bucket, so a main-corpus result says nothing about Go — §61's precedent, where 574/574 were identical *because the corpus contained no Go*. Use the frozen 80-file Go corpus (its filenames are already flattened, so generate a manifest in place rather than re-freezing with `collect.js`). Run both modes over it.

- [ ] **Step 6: Classify**

```bash
node tools/corpus-harness/deep-regions.js <out>/fast <out>/deep --out <out>/classification.json
```

Then **read every differing row** and fill its `classification` field with `improvement` or `regression` and a one-line reason. §3.5 requires a person to have read each one; an unfilled field is an unmet exit criterion, not a formatting gap.

- [ ] **Step 7: Check the gate**

`new-fallback-region` must be **0**. `new-fallback-validator` is reported with §80's disagreement rates as its explanation and is not gated. If `new-fallback-region` is non-zero, the region work regressed — do not proceed to §81; fix it and re-run from Step 3.

- [ ] **Step 8: Measure `Parser.init()`**

Time `createDeepBackends()` on its own and report it separately. It is per-process and lands in the harness's `fixed` bucket, not engine time. §75 names it as a plausible reason Deep is unusable at the CLI while fine at the Gateway, and it is the figure R4's packaging decision turns on. Say which of cold/warm any latency claim means.

- [ ] **Step 9: Write §81 and correct the status rows**

Append `DECISIONS.md` §81 in the shape §79 and §80 use, covering: the three decisions taken here (Deep answers regions + check but **not** symbols; candidate spans only, core keeps the filters; `--engine-mode` rather than a third `--mode` value); the measured classification table; the two fallback numbers and why they are separate; the `Parser.init()` figure; and a **What this does not establish** section carrying at minimum — JavaScript is unregistered and therefore unmeasured through the live path; step 2's ≥5,000-file shortfall for TS and JS is unclosed; the Fast statement splitter still subdivides in deep mode; drift still uses the shipped extractor, so §79's open question is deferred rather than answered.

Correct `ROADMAP.md`'s R3 row and exit line, and `CLAUDE.md`'s R3 bullet. Change "all four existing languages" to name three, with javascript's exclusion and its reason.

- [ ] **Step 10: Delete the handoff doc**

```bash
git rm docs/r3-start-here.md
```

Its own header says to. Anything in it still live belongs in §81.

- [ ] **Step 11: Final verification**

Run: `npm run typecheck && npm run lint && npm run build && npm test`
Expected: all pass.

- [ ] **Step 12: Commit**

```bash
git add DECISIONS.md ROADMAP.md CLAUDE.md CHANGELOG.md
git commit -m "docs: record R3 step 3 (DECISIONS §81) and close R3"
```

---

## Self-Review

**Spec coverage.** §3.4's three constraints: the sync surface is preserved (Task 8 does all async work at registration); invariant 1 per-configuration is already stated in `ARCHITECTURE.md` from step 1; `selectValidator` as a registry lookup with the chain first is unchanged from §80 and extended to regions in Task 4. §3.5's step-3 row: output may differ (Task 9's classifier), every differing row classified (Task 10 Step 6), fallbacks must not rise (Task 10 Step 7, split into two numbers with the region one gated), latency against R2's baseline (Task 10 Steps 2 and 8). R3's exit — "Deep reachable via `--mode deep`" — is met by `--engine-mode deep`, a deliberate deviation recorded in §81.

**Known gaps, carried deliberately rather than silently.** JavaScript is not registered, so R3 exits covering three languages through the live path, not four; §80's ≥5,000-file shortfall stays open; the Fast statement splitter still handles subdivision under deep mode. All three are written into §81's "does not establish".

**Type consistency.** `DeepRegion`/`ElisionRegion` are structurally identical (`{start, end}`) and cross the boundary by structure, which is how `DeepCheckResult` already crosses it. `ParserRegionOptions` (core) and `DeepRegionOptions` (package) are likewise structural twins — deliberate, so core never imports from `packages/deep`. `parserCoverage` returns the model's `ParserCoverage` in Task 6 Step 4 after the type exists in Step 3.
