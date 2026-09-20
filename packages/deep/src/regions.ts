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
