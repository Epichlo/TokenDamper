/**
 * Which grammar answers for which language, and where its WASM lives.
 *
 * The four here are exactly the four the shipped Fast path already identifies. R3 adds **no
 * new language** — its deliverable is that a second backend reproduces the first on ground
 * where the answer can still be hand-checked. A fifth entry belongs to R4 and needs §3.7's
 * two-corpus ceiling measurement before it is written.
 */
export type DeepLanguage = 'typescript' | 'javascript' | 'python' | 'go';

export const DEEP_LANGUAGES: ReadonlyArray<DeepLanguage> = Object.freeze([
  'typescript',
  'javascript',
  'python',
  'go',
]);

/**
 * `require.resolve` rather than a path built from `__dirname`.
 *
 * Every one of these packages lists `*.wasm` in its `files`, so the artifact is resolvable by
 * specifier wherever the package is installed — hoisted to a workspace root, nested, or
 * pnpm-linked. Computing `../../node_modules/...` from here would work in this repository and
 * break in any other layout, and would do so at *load* time rather than visibly.
 */
const WASM_SPECIFIERS: Readonly<Record<DeepLanguage, string>> = Object.freeze({
  typescript: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  javascript: 'tree-sitter-javascript/tree-sitter-javascript.wasm',
  python: 'tree-sitter-python/tree-sitter-python.wasm',
  go: 'tree-sitter-go/tree-sitter-go.wasm',
});

export function grammarWasmPath(language: DeepLanguage): string {
  return require.resolve(WASM_SPECIFIERS[language]);
}
