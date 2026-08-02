import type { ContextItem } from '../model/types';
import { classifyContent, createContextItem, freeze } from '../model/constructors';
import { selectValidator, validateItemAst } from '../validation/ast';

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
  /** The stage's semantic marker, e.g. `<BLOCK_HASH:...>` or `[TokenDamper Elided: ...]`. */
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
 * bare `<BLOCK_HASH:...>`; the TypeScript and Python AST-lite validators both *accept* it.
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
