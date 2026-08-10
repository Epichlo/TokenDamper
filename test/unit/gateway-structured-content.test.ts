import { describe, expect, it } from 'vitest';
import { CONTENT_SHAPE_METADATA_KEY, elideItem } from '../../src/core/elision';
import {
  createBundleStatistics,
  createContextItem,
  createOptimizationBudget,
  freeze,
  hashContent,
} from '../../src/core/model/constructors';
import type { ContextBundle, ContextItem } from '../../src/core/model/types';
import { handleProxyRequest } from '../../src/gateway/proxy';
import { GatewaySessionStore } from '../../src/gateway/session-store';
import { runSessionDedupStage } from '../../src/stages/cleanup/session-dedup';

/**
 * Audit C4 — structured message content was flattened to a string, and written back as one.
 *
 * A message whose content is `[{"type":"tool_result","tool_use_id":"toolu_01ABC",…}]` was
 * ingested as `JSON.stringify(...)` and, on egress, replaced with whatever string the pipeline
 * produced. The Anthropic Messages API requires a `tool_use` block to be answered by a
 * `tool_result` block carrying the matching id; a bare string there is a
 * `400 invalid_request_error`, and the same shape breaks OpenAI multimodal content parts.
 *
 * **The audit's own note is why these tests are shaped the way they are:** the flattening defect
 * was "masked by H1" — the drift gate refuses the elision first, so the whole request falls back
 * and the corruption never reaches the wire. Testing it only through `handleProxyRequest` would
 * therefore pass against the unfixed code and assert nothing.
 *
 * Run against the pre-fix engine, **four** of the nine tests below fail. Which four matters, so
 * it is written down rather than left to be rediscovered:
 *
 *  - The two `elideItem`/stage tests fail, because they reach past the drift-gate mask.
 *  - `does not shift content onto the wrong message` fails: positional drift is **not** masked.
 *    It reports `expected 'ok' to be 'export function helper0…'` — the assistant's message
 *    received the previous item's content.
 *  - `leaves structured content untouched when it is duplicated within one payload` fails, and
 *    this one revises the audit. **C4 was live, not latent.** Within-payload duplication is
 *    elided `recoverable: true`, which drift exempts, so no fallback intervenes; measured on the
 *    pre-C4 engine that payload shipped `messages[2].content` as the *string*
 *    `"{\"__td_block__\":\"[TokenDamper Elided: …]\"}"` with `fallbackUsed: false` and
 *    `tokensSaved: 42`.
 *
 * The remaining five pass either way, deliberately. `an untagged item is treated as plain text`
 * and `elides the byte-identical content when it is tagged as a plain string` are **controls** —
 * without them a refusal for some unrelated reason would read as the fix working. The
 * non-duplicated structured case and the two system-prompt cases are **guards on a path that is
 * genuinely masked today**: the drift gate blocks the first, and no Gateway stage can change a
 * system item. They fail the moment either of those changes without this fix.
 */

const TOOL_RESULT_BLOCKS = [
  { type: 'tool_result', tool_use_id: 'toolu_01ABCDEFGHIJKLMNOPQRST', content: 'the tool said something reasonably long here' },
  { type: 'text', text: 'and then some accompanying prose that pads this out past the marker length' },
];
const STRUCTURED_TEXT = JSON.stringify(TOOL_RESULT_BLOCKS);

function itemWith(shape: 'string' | 'structured', content: string): ContextItem {
  return createContextItem({
    id: 'item-1',
    kind: 'conversation',
    contentType: 'json',
    content,
    origin: 'test',
    contentHash: hashContent({ content }),
    role: 'user',
    metadata: freeze({ [CONTENT_SHAPE_METADATA_KEY]: shape }),
  });
}

function bundleOf(item: ContextItem): ContextBundle {
  const items = freeze([item]);
  return freeze({
    id: 'b1',
    bundleId: 'b1',
    source: 'text',
    items,
    summary: freeze({ itemCount: 1, tokenEstimate: 50, preview: item.content.slice(0, 20) }),
    statistics: freeze(createBundleStatistics(items)),
    contentHash: 'b1',
  });
}

describe('elision refuses structured content (C4)', () => {
  it('skips a structured item, naming the reason', () => {
    const outcome = elideItem({
      item: itemWith('structured', STRUCTURED_TEXT),
      marker: '[TokenDamper Elided: ref=abc123456789 bytes=100 kind=conversation]',
      contentHash: 'h',
      metadata: {},
    });

    expect(outcome.status).toBe('skipped');
    expect(outcome.status === 'skipped' && outcome.reason).toBe('structured_content');
  });

  it('elides the byte-identical content when it is tagged as a plain string', () => {
    // The control that gives the test above its meaning. Same bytes, same content type, same
    // marker — only the tag differs. Without this, a refusal for some unrelated reason (JSON
    // handling, no savings) would read as the fix working.
    const outcome = elideItem({
      item: itemWith('string', STRUCTURED_TEXT),
      marker: '[TokenDamper Elided: ref=abc123456789 bytes=100 kind=conversation]',
      contentHash: 'h',
      metadata: {},
    });

    expect(outcome.status).toBe('elided');
  });

  it('refuses through the stage, and reports it in the metrics', () => {
    const item = itemWith('structured', STRUCTURED_TEXT);
    const result = runSessionDedupStage(bundleOf(item), createOptimizationBudget({}), {
      previousBlockHashes: new Set([item.contentHash]),
    });

    expect(result.changed).toBe(false);
    expect(result.bundle.items[0]!.content).toBe(STRUCTURED_TEXT);
    expect(result.metrics.skippedStructuredContent).toBe(1);
  });

  it('an untagged item is treated as plain text', () => {
    // CLI, MCP and bench never set the tag, and their content really is text. The refusal must
    // not leak into them.
    const content = STRUCTURED_TEXT;
    const untagged = createContextItem({
      id: 'item-1',
      kind: 'conversation',
      contentType: 'json',
      content,
      origin: 'test',
      contentHash: hashContent({ content }),
      metadata: freeze({}),
    });

    const outcome = elideItem({
      item: untagged,
      marker: '[TokenDamper Elided: ref=abc123456789 bytes=100 kind=conversation]',
      contentHash: 'h',
      metadata: {},
    });

    expect(outcome.status).toBe('elided');
  });
});

describe('the Gateway maps items back by slot, not by position (C4)', () => {
  const BLOCK = Array.from(
    { length: 20 },
    (_, i) => `export function helper${i}(input) { return input * ${i}; }`,
  ).join('\n');

  const post = async (store: GatewaySessionStore, sessionId: string, payload: unknown) =>
    handleProxyRequest(
      'POST',
      '/v1/chat/completions',
      { 'x-session-id': sessionId },
      JSON.stringify(payload),
      { sessionStore: store, mockUpstream: true },
    );

  it('does not shift content onto the wrong message when messages has a hole', async () => {
    // Ingestion skips falsy entries (`if (!msg) continue`), but egress used to index
    // `finalBundle.items[idx]` by array position — so one hole moved every later item onto the
    // wrong message. Within-payload duplication is used here because it is the one case that
    // survives the drift gate (`recoverable: true`), so something actually changes and the
    // misalignment becomes observable.
    const store = new GatewaySessionStore();
    const session = 'hole-session';

    await post(store, session, { model: 'gpt-4o', messages: [{ role: 'user', content: BLOCK }] });

    const turn2 = await post(store, session, {
      model: 'gpt-4o',
      messages: [
        null,
        { role: 'user', content: BLOCK },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: BLOCK },
        { role: 'user', content: 'What does this do?' },
      ],
    });

    expect(turn2.statusCode).toBe(200);
    const out = JSON.parse(turn2.body) as { messages: Array<{ role?: string; content?: string } | null> };

    // The hole stays a hole.
    expect(out.messages[0]).toBeNull();
    // The referent copy is preserved intact, and the assistant turn is untouched — under the
    // positional mapping the assistant message received the first item's content.
    expect(out.messages[1]!.content).toBe(BLOCK);
    expect(out.messages[2]!.content).toBe('ok');
    // The new prompt is never elided and must still be itself.
    expect(out.messages[4]!.content).toBe('What does this do?');
    // Whatever happened to the duplicate copy, every surviving message keeps its own role.
    expect(out.messages.map((m) => (m === null ? null : m.role))).toEqual([
      null,
      'user',
      'assistant',
      'user',
      'user',
    ]);
  });

  it('leaves structured content untouched when it is duplicated within one payload', async () => {
    // **The case the audit got wrong, and the reason C4 was live rather than latent.**
    //
    // C4 is recorded as "masked by H1": the drift gate refuses the elision first, so the request
    // falls back and the corruption never ships. That holds for a cross-turn *sole* copy. It does
    // not hold here. Content duplicated within one payload is elided `recoverable: true`, which
    // `DriftTracker` exempts by substitution — so there is no drift, no fallback, and the elision
    // goes out on the wire. That is also the only case the Gateway saves anything on at all
    // (DECISIONS §41), so C4 was live on precisely the path the mode exists for.
    //
    // Measured against the pre-C4 engine, this payload came back with
    //   messages[2].content = "{\"__td_block__\":\"[TokenDamper Elided: ref=… kind=conversation]\"}"
    // as a *string*, with fallbackUsed false and tokensSaved 42. A `tool_result` block replaced
    // by a bare string is a 400 invalid_request_error.
    const store = new GatewaySessionStore();
    const session = 'structured-dup-session';
    const payload = {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: TOOL_RESULT_BLOCKS },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: TOOL_RESULT_BLOCKS },
      ],
    };

    await post(store, session, payload);
    const turn2 = await post(store, session, payload);

    expect(turn2.statusCode).toBe(200);
    const out = JSON.parse(turn2.body) as { messages: Array<{ content: unknown }> };

    // Both copies keep their structure — the second is the one that was being elided.
    expect(Array.isArray(out.messages[0]!.content)).toBe(true);
    expect(Array.isArray(out.messages[2]!.content)).toBe(true);
    expect(out.messages[2]!.content).toEqual(TOOL_RESULT_BLOCKS);

    // And the saving is honestly zero rather than bought by corrupting the payload.
    const turn = store.getSession(session)!.turns[1]!;
    expect(turn.fallbackUsed).toBe(false);
    expect(turn.tokensSaved).toBe(0);
  });

  it('leaves structured content untouched end to end', async () => {
    const store = new GatewaySessionStore();
    const session = 'structured-session';
    const payload = {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: TOOL_RESULT_BLOCKS },
        { role: 'assistant', content: 'understood' },
      ],
    };

    await post(store, session, payload);
    const turn2 = await post(store, session, payload);

    expect(turn2.statusCode).toBe(200);
    const out = JSON.parse(turn2.body) as { messages: Array<{ content: unknown }> };
    // Still an array of blocks, not a string — and the tool_use_id survives.
    expect(Array.isArray(out.messages[0]!.content)).toBe(true);
    expect(out.messages[0]!.content).toEqual(TOOL_RESULT_BLOCKS);
  });
});

describe('the Anthropic system prompt survives the rebuild (C4)', () => {
  const BLOCK = 'A repeated context block that is long enough to be worth eliding twice over.'.repeat(4);

  const post = async (store: GatewaySessionStore, sessionId: string, payload: unknown) =>
    handleProxyRequest('POST', '/v1/messages', { 'x-session-id': sessionId }, JSON.stringify(payload), {
      sessionStore: store,
      mockUpstream: true,
    });

  it('keeps a string system prompt when messages change around it', async () => {
    // `finalBody` is rebuilt from `parsedPayload` when anything changes. The system field used
    // never to be mapped back at all; now that it can be, the rebuild must neither drop it nor
    // duplicate it.
    const store = new GatewaySessionStore();
    const session = 'sys-session';
    const system = 'You are a careful assistant. Preserve the user intent exactly.';

    await post(store, session, { model: 'claude-x', system, messages: [{ role: 'user', content: BLOCK }] });

    const turn2 = await post(store, session, {
      model: 'claude-x',
      system,
      messages: [
        { role: 'user', content: BLOCK },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: BLOCK },
      ],
    });

    expect(turn2.statusCode).toBe(200);
    const out = JSON.parse(turn2.body) as { system: unknown; messages: unknown[] };
    expect(out.system).toBe(system);
    expect(out.messages).toHaveLength(3);
  });

  it('keeps a structured system prompt as structure', async () => {
    const store = new GatewaySessionStore();
    const session = 'sys-structured-session';
    const system = [{ type: 'text', text: 'You are a careful assistant.', cache_control: { type: 'ephemeral' } }];

    const payload = { model: 'claude-x', system, messages: [{ role: 'user', content: BLOCK }] };
    await post(store, session, payload);
    const turn2 = await post(store, session, payload);

    expect(turn2.statusCode).toBe(200);
    const out = JSON.parse(turn2.body) as { system: unknown };
    expect(out.system).toEqual(system);
  });
});
