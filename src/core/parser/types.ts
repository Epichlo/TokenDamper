import type { ElisionRegion } from '../elision/regions';
import type { AstCheckResult, AstValidatorOptions, TargetLanguage } from '../validation/ast/types';

// `fast` is the shipped, zero-dependency lexer path and the default. `deep` consults the
// parser registry, falling back to the same lexer chain when nothing is registered. Defined in
// `./mode` (not here) to break an import cycle — see that module's doc comment — and re-exported
// so every existing importer of `EngineMode` / `DEFAULT_ENGINE_MODE` from this module is unaffected.
export { DEFAULT_ENGINE_MODE, type EngineMode } from './mode';

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

/**
 * A parser backend, answering exactly the three questions a language needs.
 *
 * Modelled on `TokenizerAdapter` / `createTiktokenAdapter` (`src/core/hashing/tokenizer.ts`),
 * which is this codebase's established answer to "capability without a dependency": core
 * ships the interface and bundles no implementation. The same reasoning applies here and is
 * load-bearing for the package size — core went 508 -> 223 entries and 3.08 -> 1.65 MB in
 * v1.7.2, and a companion package exists so that stays true.
 *
 * **The surface is synchronous, and that is not negotiable.**
 * `AstValidator.validate(content, options): AstCheckResult` is sync and so is every caller
 * down the chain — the engine, the fallback resolver and three adapters. `web-tree-sitter`
 * needs `await Parser.init()` and `await Language.load(wasm)`, so **all async work happens
 * at registration**, before the pipeline runs, and parsing is sync thereafter. Making the
 * validator interface async would ripple through all of the above to buy nothing.
 */
export interface ParserAdapter {
  /** Identifies the backend in traces and disagreement reports. Not used for dispatch. */
  readonly name: string;
  /**
   * The language this backend covers, matched against the language the shipped chain
   * resolves for an item.
   *
   * Deep adds no *new* language in R3 — it re-answers the four the chain already
   * identifies. Keying off the chain's answer rather than a second item-to-language rule is
   * deliberate: two rules can disagree about what a file is, and that disagreement would
   * show up as a parser difference.
   */
  readonly language: TargetLanguage;

  /** Feeds `DriftTracker.extractSymbols`. */
  symbols(content: string): Set<string>;

  /** Satisfies the existing `AstValidator` shape. */
  check(content: string, options?: AstValidatorOptions): AstCheckResult;

  /** Feeds `selectElisionRegions`. */
  regions(content: string, options?: ParserRegionOptions): ReadonlyArray<ElisionRegion>;
}
