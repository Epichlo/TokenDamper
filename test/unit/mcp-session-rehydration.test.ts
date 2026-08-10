import { describe, expect, it } from 'vitest';
import { handleToolCall } from '../../src/adapters/mcp/tools';
import { SESSION_ELISION_MARKER_PATTERN } from '../../src/core/elision';
import { TokenHasher } from '../../src/core/hashing/token-hasher';
import { createContextItem, createOptimizationBudget, freeze, hashContent } from '../../src/core/model/constructors';
import type { ContextBundle } from '../../src/core/model/types';
import { GatewaySessionStore } from '../../src/gateway/session-store';
import { runSessionDedupStage } from '../../src/stages/cleanup/session-dedup';

/**
 * Audit M5b — MCP session rehydration could never have worked.
 *
 * `rehydrate_context` looked for `<ELIDED: ref=… >`; `cleanup:session-dedup` emits
 * `[TokenDamper Elided: ref=… bytes=… kind=…]`. Different brackets, different prefix, zero
 * overlap — so the replace call matched nothing on every marker the product can produce, and
 * returned the text unchanged with no error.
 *
 * Every assertion below takes its marker from the **emitting stage**, never from a literal.
 * A literal is what let the two drift: each side was independently self-consistent, and a test
 * restating either one would have passed while the pair was broken.
 */

const ORIGINAL_CONTENT =
  'Detailed file context content that is repeated across turns in a long conversation transcript';

/** Runs the real stage and returns the marker it actually emitted. */
function elideThroughStage(): { marker: string; contentHash: string } {
  const contentHash = hashContent({ role: 'user', content: ORIGINAL_CONTENT });

  const item = createContextItem({
    id: 'item-1',
    kind: 'conversation',
    contentType: 'text',
    content: ORIGINAL_CONTENT,
    origin: 'test',
    contentHash,
    metadata: {},
  });

  const bundle: ContextBundle = freeze({
    id: 'bundle-1',
    bundleId: 'bundle-1',
    source: 'text',
    items: freeze([item]),
    summary: freeze({ itemCount: 1, tokenEstimate: 25, preview: ORIGINAL_CONTENT.slice(0, 20) }),
    statistics: freeze({
      itemCount: 1,
      contentTypeCounts: freeze({ text: 1, markdown: 0, code: 0, html: 0, json: 0, yaml: 0, logs: 0, unknown: 0 }),
      kindCounts: freeze({ prompt: 0, file: 0, diff: 0, conversation: 1, note: 0 }),
      totalCharacters: ORIGINAL_CONTENT.length,
    }),
    contentHash: 'bundle-1',
  });

  const result = runSessionDedupStage(bundle, createOptimizationBudget({ riskTolerance: 'low' }), {
    previousBlockHashes: new Set([contentHash]),
  });

  expect(result.changed).toBe(true);
  const marker = result.bundle.items[0]!.content;
  expect(marker).not.toBe(ORIGINAL_CONTENT);
  return { marker, contentHash };
}

async function rehydrate(text: string, sessionId: string | undefined, store: GatewaySessionStore) {
  return handleToolCall(
    'rehydrate_context',
    { text, ...(sessionId ? { sessionId } : {}) },
    { sessionStore: store, tokenHasher: new TokenHasher() },
  );
}

describe('MCP rehydrate_context matches the marker the product emits (M5b)', () => {
  it('the shared pattern matches what the stage produced', () => {
    const { marker } = elideThroughStage();
    const match = new RegExp(SESSION_ELISION_MARKER_PATTERN.source).exec(marker);
    expect(match).not.toBeNull();
    // The captured group is the ref the session store is keyed on, not incidental text.
    expect(marker).toContain(`ref=${match![1]}`);
  });

  it('restores the original content through the tool', async () => {
    const { marker, contentHash } = elideThroughStage();

    const store = new GatewaySessionStore();
    const sessionId = 'session-m5b';
    store.getOrCreateSession(sessionId);
    // Keyed by the same 12-char ref the marker carries — `getContent` resolves a prefix.
    store.storeContent(sessionId, contentHash, ORIGINAL_CONTENT);

    const result = await rehydrate(marker, sessionId, store);

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toBe(ORIGINAL_CONTENT);
  });

  it('restores every marker in a payload that carries more than one', async () => {
    const { marker, contentHash } = elideThroughStage();

    const store = new GatewaySessionStore();
    const sessionId = 'session-m5b-multi';
    store.getOrCreateSession(sessionId);
    store.storeContent(sessionId, contentHash, ORIGINAL_CONTENT);

    const result = await rehydrate(`before ${marker} between ${marker} after`, sessionId, store);

    expect(result.content[0]!.text).toBe(
      `before ${ORIGINAL_CONTENT} between ${ORIGINAL_CONTENT} after`,
    );
  });

  it('leaves the marker in place when the session holds no content for the ref', async () => {
    const { marker } = elideThroughStage();

    const store = new GatewaySessionStore();
    store.getOrCreateSession('session-empty');

    const result = await rehydrate(marker, 'session-empty', store);

    // Unresolvable is not the same as unrecognized: the marker must survive intact rather
    // than be replaced with `undefined` or dropped.
    expect(result.content[0]!.text).toBe(marker);
  });

  it('leaves the marker alone when no sessionId is supplied', async () => {
    const { marker } = elideThroughStage();
    const result = await rehydrate(marker, undefined, new GatewaySessionStore());
    expect(result.content[0]!.text).toBe(marker);
  });
});
