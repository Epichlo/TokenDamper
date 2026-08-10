import type { ContentType } from '../model/types';

/**
 * How many leading hex characters of the content hash appear in a marker.
 *
 * Twelve, matching `cleanup:session-dedup`'s existing `ref=${hash.slice(0, 12)}`. The hash in
 * a marker is there for provenance and cross-turn identity, and 48 bits is ample for both. A
 * full 64-character digest would be 53% of the marker's length and would defeat the one
 * property the marker exists to have — that a person can read it.
 */
export const ELISION_HASH_PREFIX_LENGTH = 12;

/**
 * The nouns a marker uses for what it replaced.
 *
 * `Record<ContentType, string>` for the same reason `CONTENT_TYPE_VALIDATORS` is one: adding
 * a member to `ContentType` without deciding how to describe it should not compile.
 */
const CONTENT_TYPE_NOUNS: Readonly<Record<ContentType, string>> = {
  code: 'code',
  json: 'json',
  yaml: 'yaml',
  html: 'html',
  logs: 'log',
  markdown: 'markdown',
  text: 'text',
  unknown: 'content',
};

/** The noun a whole-item elision should use for an item of this content type. */
export function describeContentType(contentType: ContentType): string {
  return CONTENT_TYPE_NOUNS[contentType] ?? 'content';
}

/** The noun the sub-item path uses. `selectElisionRegions` selects function bodies only. */
export const FUNCTION_BODY_NOUN = 'function-body';

/**
 * Matches a rendered elision marker and captures its hash. Used by the reverse path and by
 * anything that needs to find markers in emitted text.
 *
 * Deliberately specific rather than a loose `\[TokenDamper[^\]]*\]`: `cleanup:session-dedup`
 * and `compression:delta-compression` emit their own `[TokenDamper Elided: …]` and
 * `[TokenDamper Delta: …]` markers with different fields and different reverse paths, and a
 * pattern that swallowed those would hand them to the wrong resolver.
 */
export const ELISION_MARKER_PATTERN =
  /\[TokenDamper: \d+ [a-z-]+ lines? elided, \d+ bytes, sha256:([a-f0-9]{12,64})\]/g;

/**
 * The length to budget for a marker when deciding whether a region is worth eliding.
 *
 * Derived, not guessed. For a region in the 100–999 byte range — the only range where the
 * question is close — the marker is:
 *
 *   `[TokenDamper: ` 14 + lines ≤3 + ` ` 1 + `function-body` 13 + ` lines elided, ` 15
 *   + bytes 3 + ` bytes, sha256:` 15 + hash 12 + `]` 1  =  77
 *
 * which is exactly what the fixed-width `<BLOCK_HASH:` + 64 hex + `>` placeholder cost. Above
 * that range each extra digit costs one byte against a region ten times larger, so the ratio
 * only improves. 80 leaves slack for a longer noun.
 */
export const ELISION_MARKER_BYTES = 80;

/**
 * Renders the marker that replaces `elidedText`.
 *
 * The rule this satisfies: **on a one-shot path, an elision must carry in-band enough for a
 * reader with no external state to know what was removed.** An opaque hash does not. The CLI
 * has no session on either end, so `<BLOCK_HASH:4af59ca4…>` told its reader only that
 * *something* was there — not what, not how much, not whether it mattered.
 *
 * The hash stays *inside* the marker rather than being the whole of it: it is still what
 * identifies the block across turns and what a caller holding the content can verify against.
 */
export function renderElisionMarker(elidedText: string, describes: string, contentHash: string): string {
  const lines = elidedText.split('\n').length;
  const unit = lines === 1 ? 'line' : 'lines';
  const hash = contentHash.slice(0, ELISION_HASH_PREFIX_LENGTH);
  return `[TokenDamper: ${lines} ${describes} ${unit} elided, ${elidedText.length} bytes, sha256:${hash}]`;
}

/** Whether text contains at least one marker this module renders. */
export function containsElisionMarker(text: string): boolean {
  return text.includes('[TokenDamper: ') && new RegExp(ELISION_MARKER_PATTERN.source).test(text);
}

/**
 * Renders the marker `cleanup:session-dedup` leaves where a block from an earlier turn was.
 *
 * Distinct from `renderElisionMarker` above because it names a *reference* rather than a
 * quantity: the reverse path for this one is a session-store lookup by `ref`, not a hash the
 * reader can verify against content they already hold.
 *
 * It lives here, rather than inline in the stage, because two places have to agree on it —
 * the stage that writes it and the MCP `rehydrate_context` tool that reads it. They did not.
 * The stage emitted this, and the tool looked for `<ELIDED: ref=… >`: square brackets against
 * angle brackets, different prefix, no overlap. Session rehydration through MCP could never
 * have matched a marker the product actually produces (audit M5b). One renderer and one
 * pattern, derived from each other, is the only arrangement in which that cannot recur.
 */
export function renderSessionElisionMarker(params: {
  readonly refId: string;
  readonly originalBytes: number;
  readonly kind: string;
}): string {
  return `[TokenDamper Elided: ref=${params.refId} bytes=${params.originalBytes} kind=${params.kind}]`;
}

/**
 * Matches a marker `renderSessionElisionMarker` produced, capturing its `ref`.
 *
 * Carries `g` for the replace-all call sites. Construct a fresh `RegExp` from `.source` before
 * calling `.test()` on it — a global regex carries `lastIndex` between calls.
 */
export const SESSION_ELISION_MARKER_PATTERN =
  /\[TokenDamper Elided: ref=([A-Za-z0-9_-]+) bytes=\d+ kind=[A-Za-z0-9_-]+\]/g;
