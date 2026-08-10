import type { ContextBundle, ContextItem } from '../model/types';

/**
 * The delimiter introducing each item in a multi-item render.
 *
 * `==> name <==` is `head`/`tail`'s multi-file header, chosen because it is an existing
 * convention a reader already recognizes rather than a format invented here.
 *
 * It is **not** collision-proof: a source file may contain a line of this shape, and nothing
 * escapes it. That is a deliberate trade. The consumer of this output is a language model being
 * given context, so legibility is worth more than round-trip parseability, and the alternative —
 * a delimiter improbable enough to be safe — is unreadable in a prompt. Anything that needs to
 * machine-parse the result should read `finalBundle` from the trace, which carries the items
 * structurally and needs no delimiter at all.
 */
export const ITEM_DELIMITER_PREFIX = '==> ';
export const ITEM_DELIMITER_SUFFIX = ' <==';

function itemLabel(item: ContextItem, index: number): string {
  return item.path ?? item.origin ?? `item-${index + 1}`;
}

/**
 * Renders a bundle as the bytes a caller receives.
 *
 * **One item renders as its content and nothing else**, which is what keeps every pre-existing
 * route byte-identical: CLI, MCP and bench all build single-item bundles through
 * `createContextBundle`, and adding a header to those would change output nobody asked to change.
 *
 * More than one item renders with a per-item header. Before this existed the success path was
 * `items.map(i => i.content).join('\n')` — correct for one item and structurally lossy for more,
 * because the boundaries between files disappeared and the render was not injective: two
 * different bundles could produce identical bytes. `test/unit/fallback-render.test.ts` pinned
 * that as a latent defect and said, in as many words, that whoever made an `emittedOutput`
 * consumer multi-item should stop and read it. Multi-file CLI ingestion is that change, so the
 * defect is fixed here rather than inherited (audit H5, DECISIONS §43).
 */
export function renderBundleOutput(bundle: ContextBundle): string {
  if (bundle.items.length === 1) {
    return bundle.items[0]?.content ?? '';
  }

  return bundle.items
    .map((item, index) => `${ITEM_DELIMITER_PREFIX}${itemLabel(item, index)}${ITEM_DELIMITER_SUFFIX}\n${item.content}`)
    .join('\n');
}

/**
 * Renders items in the same envelope, for callers holding items rather than a bundle.
 *
 * Used to build a multi-item request's `rawInput`, which is what fail-open echoes. Byte identity
 * on that path is therefore **per item**, not over the whole stream: the headers are added by
 * TokenDamper and were never in any input file. For a single file the two coincide, which is why
 * the existing guarantee is unchanged.
 */
export function renderItemsOutput(items: ReadonlyArray<ContextItem>): string {
  if (items.length === 1) {
    return items[0]?.content ?? '';
  }

  return items
    .map((item, index) => `${ITEM_DELIMITER_PREFIX}${itemLabel(item, index)}${ITEM_DELIMITER_SUFFIX}\n${item.content}`)
    .join('\n');
}
