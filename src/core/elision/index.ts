import type { ContextItem } from '../model/types';
import { classifyContent, createContextItem, freeze } from '../model/constructors';
import { selectValidator, validateItemAst } from '../validation/ast';
import type { ElisionRegion } from './regions';

export * from './regions';
export * from './marker';

/**
 * Reserved key identifying a TokenDamper elision inside JSON-shaped content.
 * Chosen to be unambiguous on the reverse path: a bare quoted placeholder would be
 * indistinguishable from a legitimate user string containing the same text.
 */
export const JSON_BLOCK_KEY = '__td_block__';

/**
 * The syntax an elision marker must be rendered in to remain valid for the item
 * that carries it.
 */
export type ElisionSyntax = 'json' | 'raw';

export type ElisionSkipReason = 'no_savings' | 'post_condition_rejected';

export type ElisionOutcome =
  | { readonly status: 'elided'; readonly item: ContextItem; readonly bytesSaved: number }
  | { readonly status: 'skipped'; readonly reason: ElisionSkipReason; readonly item: ContextItem };

export interface ElideItemParams {
  readonly item: ContextItem;
  /** The stage's semantic marker, e.g. `[TokenDamper: 5 code lines elided, ...]`. */
  readonly marker: string;
  readonly contentHash: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * Resolves the syntax an elision must be rendered in for this item.
 *
 * **The tag wins unconditionally.** `selectValidator` is the same function that will later
 * judge the emitted item, so deferring to it means the producer and the checker cannot
 * disagree by construction. If the encoder followed a content probe while the checker
 * followed the tag, that would recreate the producer/checker split at a different
 * granularity — the mismatch that produced Issue 2 in the first place.
 *
 * The classifier is consulted **only to fill a vacuum**, when `selectValidator` returns
 * `null` and the item therefore has no governing authority at all. It can only tighten
 * `raw -> json`; it can never override a validator that exists. Without that ordering a
 * TypeScript file whose content happens to parse as JSON (an object literal) or a Python
 * file that is a dict literal would be JSON-wrapped while being validated as TypeScript.
 *
 * Note this calls `classifyContent`, the canonical ingestion classifier, rather than a
 * bespoke probe. `classifyContent` already decides JSON by structural opener plus
 * `JSON.parse` (`looksLikeJson`), which is exactly the check a local probe would perform —
 * so a second implementation would be two copies of one algorithm that happen to agree
 * today, not a second opinion worth having.
 */
export function resolveElisionSyntax(item: ContextItem): ElisionSyntax {
  const validator = selectValidator(item);
  if (validator) {
    return validator.language === 'json' ? 'json' : 'raw';
  }

  const classified = classifyContent(item.content, 'text', item.path);
  return classified === 'json' ? 'json' : 'raw';
}

/**
 * Renders a stage marker into a form valid for the given syntax.
 */
export function renderElisionContent(marker: string, syntax: ElisionSyntax): string {
  return syntax === 'json' ? JSON.stringify({ [JSON_BLOCK_KEY]: marker }) : marker;
}

/**
 * Recovers the stage marker from rendered elision content, or `undefined` when the
 * content is not a JSON-wrapped elision. Used by the reverse (rehydration) path.
 */
export function unwrapElisionContent(content: string): string | undefined {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{') || !trimmed.includes(JSON_BLOCK_KEY)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const marker = (parsed as Record<string, unknown>)[JSON_BLOCK_KEY];
    return typeof marker === 'string' ? marker : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The single chokepoint through which every eliding stage must replace item content.
 *
 * Two mechanisms, and it matters which one is load-bearing:
 *
 *  1. **Correct-by-construction rendering (the real guarantee).** `renderElisionContent`
 *     emits the marker in a syntax valid for the resolved content type. For JSON it wraps,
 *     so even a malformed marker handed in by a careless caller comes out parseable. A
 *     stage cannot express the invalid case because it does not choose the encoding.
 *
 *  2. **Post-condition backstop (defense in depth, currently non-firing).** The candidate
 *     is validated with the very validator `selectValidator` picks for it, between
 *     construction and return.
 *
 * Be precise about (2): as of this commit it is unreachable. Only `JsonValidator` rejects a
 * bare marker; the TypeScript and Python AST-lite validators both *accept* one.
 * Since JSON is exactly the case (1) renders safely, nothing currently trips the check. It
 * is retained because it is the guard that catches a future renderer bug or a stricter
 * validator, but it must not be described as what makes this safe today.
 *
 * The corollary is a real gap worth knowing: placeholder injection into TypeScript or
 * Python content would NOT be caught by AST validation, because those validators are too
 * lenient to notice. Only drift would flag it.
 *
 * TypeScript cannot statically prove a `string` is valid JSON, so none of this is a
 * compile-time guarantee while `content` remains a string.
 *
 * Refusal semantics: a rejected item is **skipped, and the stage continues**. It never
 * aborts the stage. Per-stage checkpointing does not exist yet, so aborting would convert
 * a placeholder defect into a whole-pipeline fallback — the exact failure mode this phase
 * exists to remove. The caller keeps the original item and reports the skip in its metrics.
 */
export function elideItem(params: ElideItemParams): ElisionOutcome {
  const { item, marker, contentHash, metadata } = params;

  const syntax = resolveElisionSyntax(item);
  const content = renderElisionContent(marker, syntax);

  // Measured against the *rendered* content, not the bare marker: the JSON wrapper adds
  // bytes, and a check against the marker alone could approve an elision that grows the item.
  if (content.length >= item.content.length) {
    return { status: 'skipped', reason: 'no_savings', item };
  }

  const candidate = createContextItem({
    id: item.id,
    kind: item.kind,
    contentType: item.contentType,
    content,
    origin: item.origin,
    contentHash,
    ...(item.role ? { role: item.role } : {}),
    ...(item.path ? { path: item.path } : {}),
    ...(item.language ? { language: item.language } : {}),
    metadata: freeze({ ...metadata, elisionSyntax: syntax }),
  });

  if (!validateItemAst(candidate).valid) {
    return { status: 'skipped', reason: 'post_condition_rejected', item };
  }

  return {
    status: 'elided',
    item: candidate,
    bytesSaved: item.content.length - content.length,
  };
}

export interface ElideRegionsParams {
  readonly item: ContextItem;
  /** Disjoint, ascending ranges within `item.content`. Typically from `selectElisionRegions`. */
  readonly regions: ReadonlyArray<ElisionRegion>;
  /** Produces the stage's marker for one region's text. See `renderElisionMarker`. */
  readonly markerFor: (regionText: string) => string;
  /** Optional; defaults to `createContextItem`'s hash of the spliced content. */
  readonly contentHash?: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * The chokepoint for **sub-item** elision: replaces regions within an item's content and
 * leaves the rest intact.
 *
 * Why this exists at all. `compression:token-hashing` replaces an item's *entire* content,
 * and `createContextBundle` builds a single-item bundle for CLI and bench input, so every
 * symbol in the bundle dies at once. `DriftTracker`'s `R_AST` is then a boolean and `S_k`
 * is pinned at the formula constant `0.60` — above the `0.40` gate, every time, structurally.
 * Whole-item hashing can never succeed on a single-item code bundle
 * (`docs/phase-1d-drift-investigation.md` §6). Regions give the metric something fractional
 * to grade, and measured, it grades correctly.
 *
 * Two rules govern where a region may start and end, and both were found by measurement
 * rather than reasoning. They are documented on `selectElisionRegions` and
 * `scanPythonDefBodies`; the short version:
 *
 *  1. **The elided region must be exactly the bytes replaced.** `rehydrateText` substitutes
 *     the marker in place, so anything the caller adds around it survives rehydration and
 *     the round trip is no longer byte-identical. A prototype that emitted
 *     `indent + marker` scored 0/7 on round-trip; removing the added indent scored 7/7.
 *  2. **The marker must land in a syntactically valid position.** Rule 1 alone puts a Python
 *     marker at column 0, which `PythonValidator` rejects. Applying rule 1 without rule 2
 *     took AST validity from 8/8 to 0/8.
 *
 * ### The post-condition is *relative*, unlike `elideItem`'s
 *
 * `elideItem` requires the result to be valid outright. This requires only that the elision
 * **introduce no new AST issues**. The difference is not laxity; an absolute check is
 * unusable here for two independent reasons, both measured:
 *
 *  - Real inputs are already invalid. Three of the ten bundled bench fixtures are truncated
 *    CodeXGLUE completion prompts that end at an open brace, and a completion prompt is a
 *    first-class input for this product.
 *  - `TypeScriptValidator` has no regex-literal mode, so it reports valid TypeScript
 *    containing e.g. `/\([^)]+/` as `AST_UNBALANCED_BRACKET`. `src/core/model/constructors.ts`
 *    fails its own validator today for exactly this reason.
 *
 * Under an absolute check both classes yield 0% forever. The relative check still refuses
 * any elision that *breaks* something, which is the property that matters. It follows the
 * precedent already in `BenchmarkEvaluator.syntaxPreserved`
 * (`!rawAstResult.valid || optAstResult.valid`).
 *
 * Refusal semantics match `elideItem`: a rejected item is skipped and the stage continues.
 */
export function elideRegions(params: ElideRegionsParams): ElisionOutcome {
  const { item, regions, markerFor, contentHash, metadata } = params;

  if (regions.length === 0) {
    return { status: 'skipped', reason: 'no_savings', item };
  }

  // JSON is excluded structurally, not by convention. The `{"__td_block__":…}` wrapper is
  // not composable at sub-item granularity: `rehydrateText` unwraps only when the whole item
  // is a wrapped marker, so a nested wrapper gets the stored content substituted *inside* it,
  // yielding text that is neither byte-identical nor valid JSON.
  if (resolveElisionSyntax(item) === 'json') {
    return { status: 'skipped', reason: 'post_condition_rejected', item };
  }

  let content = '';
  let cursor = 0;
  for (const region of regions) {
    if (region.start < cursor || region.end <= region.start || region.end > item.content.length) {
      // Overlapping, inverted or out-of-bounds ranges would make the splice ambiguous and
      // the result non-deterministic. Refuse rather than guess.
      return { status: 'skipped', reason: 'post_condition_rejected', item };
    }
    content += item.content.slice(cursor, region.start);
    content += markerFor(item.content.slice(region.start, region.end));
    cursor = region.end;
  }
  content += item.content.slice(cursor);

  if (content.length >= item.content.length) {
    return { status: 'skipped', reason: 'no_savings', item };
  }

  const candidate = createContextItem({
    id: item.id,
    kind: item.kind,
    contentType: item.contentType,
    content,
    origin: item.origin,
    ...(contentHash ? { contentHash } : {}),
    ...(item.role ? { role: item.role } : {}),
    ...(item.path ? { path: item.path } : {}),
    ...(item.language ? { language: item.language } : {}),
    metadata: freeze({ ...metadata, elisionSyntax: 'raw', elidedRegions: regions.length }),
  });

  if (validateItemAst(candidate).issues.length > validateItemAst(item).issues.length) {
    return { status: 'skipped', reason: 'post_condition_rejected', item };
  }

  return {
    status: 'elided',
    item: candidate,
    bytesSaved: item.content.length - content.length,
  };
}
