import type { Node, Tree } from 'web-tree-sitter';

/** Mirrors `AstIssue` in core, which this package deliberately does not import from. */
export interface DeepIssue {
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly code: string;
}

/**
 * The most issues one file reports.
 *
 * A badly broken file can produce hundreds of `ERROR` nodes, and every one of them is the same
 * finding seen from a different offset. The cap keeps a disagreement report readable over a
 * five-thousand-file run; it never changes the **verdict**, which is decided by whether any
 * error node exists at all.
 */
const MAX_ISSUES = 32;

/**
 * Whether the subtree rooted here contains an error.
 *
 * Used to prune the walk: `hasError` is maintained by tree-sitter on every node, so a valid file
 * costs one check at the root rather than a full traversal. That matters — step 2 runs this over
 * thousands of files per language, nearly all of them valid.
 */
function subtreeHasError(node: Node): boolean {
  return node.hasError || node.isMissing;
}

/**
 * Collects the grammar's own complaints about `tree`.
 *
 * tree-sitter is **error-tolerant**: it always returns a tree, and records what it could not
 * parse as `ERROR` nodes and what it expected but did not find as `MISSING` nodes. So "did this
 * parse" is a question about the tree's contents rather than about whether parsing threw.
 *
 * **This is a genuinely stronger check than the Fast path's and that is the point of measuring
 * the two against each other — it is not a claim the Fast path ever made.** DECISIONS §46 and
 * §75 both stand: the shipped guarantee is bracket/quote integrity, and
 * `test/unit/validator-guarantee.test.ts`, which asserts that English prose *passes* the
 * TypeScript lexer, stays exactly as written. If Deep's guarantee is ever advertised, that test,
 * the README table and CLAUDE.md's opening paragraph change in one commit.
 */
export function issuesFromTree(tree: Tree): DeepIssue[] {
  const root = tree.rootNode;
  if (!subtreeHasError(root)) {
    return [];
  }

  const issues: DeepIssue[] = [];
  const stack: Node[] = [root];

  while (stack.length > 0 && issues.length < MAX_ISSUES) {
    const node = stack.pop()!;

    if (node.isMissing) {
      issues.push({
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
        message: `Missing ${node.type} at line ${node.startPosition.row + 1}, column ${node.startPosition.column}`,
        code: 'DEEP_MISSING_TOKEN',
      });
      continue;
    }

    if (node.type === 'ERROR') {
      issues.push({
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
        message: `Parse error at line ${node.startPosition.row + 1}, column ${node.startPosition.column}`,
        code: 'DEEP_PARSE_ERROR',
      });
      // No `continue`: an ERROR node can contain a MISSING one, and the inner node is usually
      // the more specific finding.
    }

    // Children in reverse so the walk reports in source order.
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child && subtreeHasError(child)) stack.push(child);
    }
  }

  // `hasError` was true at the root, so the grammar rejected something. If the walk found no
  // node to blame — which the child-pruning above makes possible in principle — report the root
  // rather than returning an empty list. An empty list with `valid: false` would be a verdict
  // nobody can act on, and an empty list with `valid: true` would be the failure §60 names.
  if (issues.length === 0) {
    issues.push({
      line: 1,
      column: 0,
      message: 'Parse error: the grammar rejected this content but no error node was located',
      code: 'DEEP_PARSE_ERROR',
    });
  }

  return issues;
}
