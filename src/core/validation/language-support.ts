import type { ContextBundle, ContextItem, LanguageSupportReport } from '../model';
import { supportsRegionElision } from '../elision/regions';

/**
 * Answers, before any stage runs, whether elision can reduce these items at all.
 *
 * Audit H2: twelve of the nineteen extensions `isCodeExtension` recognises cannot produce a
 * non-zero reduction under any flag combination, and neither gate is threshold-controlled, so
 * `--max-drift 0.99` does not move them.
 */

/**
 * Whether **elision** has any route to reducing this item.
 *
 * The answer is exactly `supportsRegionElision`, and the derivation matters because a looser
 * predicate is tempting and wrong:
 *
 *  - **Sub-item region elision** exists only for TypeScript/JavaScript, Python and Go
 *    (`selectElisionRegions` returns `[]` for everything else). Go joined in DECISIONS §61,
 *    which is the third and last step of the sequence §56 fixed.
 *  - **Whole-item elision of a symbol-bearing item** is refused outright by
 *    `compression:token-hashing` — since §40 a code item scores `S_k = 1 - R_AST`, and
 *    destroying every symbol makes that 1.0 against a gate that fires above 0.40. There is no
 *    threshold under which it survives (§43).
 *  - **Whole-item elision of a symbol-free item** is attempted, and then fails the same way one
 *    layer along: with no symbols, `R_AST` does not vote (§40), so `R_struct` decides — and
 *    eliding the whole item destroys every content marker, giving `R_struct = 0`. An item with
 *    neither symbols nor markers is refused by the measurement gate instead (§33).
 *
 * So for anything outside the region-selectable languages, every elision route terminates in a
 * refusal. That prediction matches the measured corpus exactly: python, typescript and (since
 * §61) go reduce; shell, perl, tcl, c, rust, css and prose are 0.00% on both routes.
 *
 * **A first attempt at this used "does the item yield symbols or markers?" and was wrong.**
 * A trivial Go file yielded exactly one symbol — `import:fmt`, an incidental match by the
 * TypeScript import regex — which made Go read as supported while it still could not reduce.
 * The gate to ask about is the one that actually decides. **Go reduces now (§61), so the
 * example has moved on; the reasoning has not.** Rust is the same shape today: a `struct`
 * yields `type:Point` by the same incidental match, and Rust has no region scanner.
 *
 * Note this is scoped to elision. `pruning:topology-pruner` drops whole items and is
 * language-agnostic, but it is selection rather than elision and needs a multi-item bundle;
 * `noneSupported` is worded accordingly.
 */
export function isElisionReducible(item: ContextItem): boolean {
  return supportsRegionElision(item);
}

/**
 * Builds the bundle-level report. Pure and cheap — a validator lookup per item, no content scan.
 */
export function describeLanguageSupport(bundle: ContextBundle): LanguageSupportReport {
  const unsupportedLanguages = new Set<string>();
  let supported = 0;
  let unsupported = 0;

  for (const item of bundle.items) {
    if (isElisionReducible(item)) {
      supported += 1;
      continue;
    }
    unsupported += 1;
    // The declared language is the useful name when there is one — it is what the caller typed.
    // Falling back to the content type keeps the message concrete for an undeclared item rather
    // than printing `undefined`.
    unsupportedLanguages.add(item.language ?? item.contentType);
  }

  const languages = [...unsupportedLanguages].sort();
  const noneSupported = bundle.items.length > 0 && supported === 0;

  return {
    supported,
    unsupported,
    unsupportedLanguages: Object.freeze(languages),
    noneSupported,
    ...(unsupported === 0
      ? {}
      : {
          reason: noneSupported
            ? `Elision cannot reduce ${languages.join(', ')} in this build: there is no sub-item region selector for it, and whole-item elision cannot survive the drift gate. Elision reduces TypeScript/JavaScript, Python and Go only, so 0% here is structural rather than a property of this input. Whole-item pruning is language-agnostic but needs a multi-item bundle.`
            : `${unsupported} of ${bundle.items.length} item(s) are in a language elision cannot reduce (${languages.join(', ')}); only whole-item pruning can affect them.`,
        }),
  };
}
