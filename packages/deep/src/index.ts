import { Language, Parser } from 'web-tree-sitter';

import { issuesFromTree, type DeepIssue } from './check';
import { DEEP_LANGUAGES, grammarWasmPath, type DeepLanguage } from './grammars';
import { symbolsFromTree } from './symbols';

export { DEEP_LANGUAGES, type DeepLanguage } from './grammars';

/**
 * `tokendamper-deep` — the Deep-mode backends, backed by tree-sitter compiled to WASM.
 *
 * **Unpublished in R3.** Its job this release is to be *measured against* the shipped Fast
 * path on the four languages Fast already covers, which is the only ground where a
 * disagreement can still be hand-checked. R4 publishes it and adds languages.
 *
 * ## The async boundary
 *
 * `Parser.init()` and `Language.load()` are async; `ParserAdapter` is not, and neither is
 * `AstValidator.validate` or any caller below it — the engine, the fallback resolver and
 * three adapters. So **all async work happens here, at construction**, and every adapter
 * method is synchronous thereafter. That constraint is §3.4's and it is what keeps the seam
 * from rippling an `await` through the pipeline to buy nothing.
 *
 * `Parser.init()` is per-process and its cost lands in the harness's `fixed` bucket rather
 * than in engine time (DECISIONS §76). It is measured rather than assumed — §75 lists it as a
 * plausible reason Deep could be unusable at the CLI while fine at the Gateway.
 */

/** What a backend answers. Structurally compatible with core's `ParserAdapter`. */
export interface DeepCheckResult {
  readonly valid: boolean;
  readonly issues: ReadonlyArray<DeepIssue>;
  readonly durationMs: number;
}

/** Minimal structural view of what a backend must answer. Kept local to the package. */
export interface DeepBackend {
  readonly name: string;
  readonly language: DeepLanguage;
  symbols(content: string): Set<string>;
  check(content: string): DeepCheckResult;
  regions(content: string): never;
}

let initialised: Promise<void> | undefined;

/**
 * Initialises the WASM runtime exactly once per process.
 *
 * Memoised on the promise rather than a boolean: two concurrent `createDeepBackends()` calls
 * would otherwise both see `false` and both call `Parser.init()`.
 */
function initRuntime(): Promise<void> {
  initialised ??= Parser.init();
  return initialised;
}

function notImplemented(step: string, language: DeepLanguage): never {
  // Throwing rather than returning an empty or passing result, deliberately. `check()`
  // returning `valid: true` and `regions()` returning `[]` are both indistinguishable from a
  // backend that examined the content and found nothing — invariant 10's exact failure, and
  // the one §60 names: 0 findings is also what a validator that examines nothing reports.
  throw new Error(
    `tokendamper-deep: ${step} is not implemented for ${language} yet (R3 ships symbols, then the ` +
      `validator, then regions — in that order, for the reason DECISIONS §56 measured).`,
  );
}

async function createBackend(language: DeepLanguage): Promise<DeepBackend> {
  await initRuntime();
  const grammar = await Language.load(grammarWasmPath(language));
  const parser = new Parser();
  parser.setLanguage(grammar);

  return {
    name: `tree-sitter-${language}`,
    language,
    symbols(content: string): Set<string> {
      const tree = parser.parse(content);
      if (tree === null) return new Set();
      try {
        return symbolsFromTree(tree, language);
      } finally {
        // web-tree-sitter trees hold WASM memory that GC does not reclaim.
        tree.delete();
      }
    },
    check(content: string): DeepCheckResult {
      const started = performance.now();
      const tree = parser.parse(content);
      if (tree === null) {
        // The parser declining to produce a tree at all is not a pass. Returning
        // `valid: true` here would be the §60 failure in its purest form.
        return {
          valid: false,
          issues: [{ line: 1, column: 0, message: 'Parser returned no tree', code: 'DEEP_NO_TREE' }],
          durationMs: performance.now() - started,
        };
      }
      try {
        const issues = issuesFromTree(tree);
        return { valid: issues.length === 0, issues, durationMs: performance.now() - started };
      } finally {
        tree.delete();
      }
    },
    regions: (): never => notImplemented('regions()', language),
  };
}

/** Every backend this package covers, ready to register. */
export async function createDeepBackends(): Promise<DeepBackend[]> {
  return Promise.all(DEEP_LANGUAGES.map((language) => createBackend(language)));
}
