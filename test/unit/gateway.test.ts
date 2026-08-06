import { createServer, type Server as HttpServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBundleStatistics, createContextItem, createOptimizationBudget, freeze, hashContent } from '../../src/core/model/constructors';
import type { ContextBundle } from '../../src/core/model/types';
import { handleProxyRequest } from '../../src/gateway/proxy';
import { GatewayServer } from '../../src/gateway/server';
import { GatewaySessionStore } from '../../src/gateway/session-store';
import { runSessionDedupStage } from '../../src/stages/cleanup/session-dedup';

describe('GatewaySessionStore', () => {
  let store: GatewaySessionStore;

  beforeEach(() => {
    store = new GatewaySessionStore({ sessionTtlMs: 1000, maxSessions: 2 });
  });

  it('creates new session and records turn data', () => {
    const session = store.getOrCreateSession('session-123');
    expect(session.sessionId).toBe('session-123');
    expect(session.turnCount).toBe(0);

    store.recordTurn(
      'session-123',
      {
        rawTokens: 100,
        optimizedTokens: 80,
        tokensSaved: 20,
        dedupRatio: 0.2,
        fallbackUsed: false,
      },
      ['hash-abc', 'hash-def'],
    );

    const updated = store.getOrCreateSession('session-123');
    expect(updated.turnCount).toBe(1);
    expect(updated.seenBlockHashes.has('hash-abc')).toBe(true);
    expect(updated.contentByHash.size).toBe(0);
    expect(store.hasBlockHash('session-123', 'hash-abc')).toBe(true);
    expect(store.hasBlockHash('session-123', 'hash-unknown')).toBe(false);
  });

  it('bounds seenBlockHashes to 1000 items and evicts oldest', () => {
    store.getOrCreateSession('session-bounds');
    const hashes: string[] = [];
    for (let i = 0; i < 1005; i++) {
      hashes.push(`hash-${i}`);
    }
    
    store.recordTurn(
      'session-bounds',
      { rawTokens: 100, optimizedTokens: 80, tokensSaved: 20, dedupRatio: 0.2, fallbackUsed: false },
      hashes
    );

    const updated = store.getOrCreateSession('session-bounds');
    expect(updated.seenBlockHashes.size).toBe(1000);
    expect(updated.seenBlockHashes.has('hash-0')).toBe(false);
    expect(updated.seenBlockHashes.has('hash-4')).toBe(false);
    expect(updated.seenBlockHashes.has('hash-5')).toBe(true);
  });

  it('stores raw content and retrieves it by full hash, short ref, or elision marker', () => {
    const rawContent = 'Original long context content retained for later rehydration.';
    const contentHash = hashContent({ role: 'user', content: rawContent });
    const shortRef = contentHash.slice(0, 12);

    store.storeContent('session-123', contentHash, rawContent);

    expect(store.getContent('session-123', contentHash)).toBe(rawContent);
    expect(store.getContent('session-123', shortRef)).toBe(rawContent);
    expect(store.getContent('session-123', `[TokenDamper Elided: ref=${shortRef} bytes=60 kind=conversation]`)).toBe(rawContent);
  });

  it('records raw content entries during turn recording', () => {
    store.recordTurn(
      'session-123',
      {
        rawTokens: 50,
        optimizedTokens: 25,
        tokensSaved: 25,
        dedupRatio: 0.5,
        fallbackUsed: false,
      },
      [{ hash: 'hash-with-content', content: 'raw session content' }],
    );

    expect(store.hasBlockHash('session-123', 'hash-with-content')).toBe(true);
    expect(store.getContent('session-123', 'hash-with-content')).toBe('raw session content');
  });

  it('rehydrates an elided session item from stored raw content when requested', () => {
    const rawContent = 'Detailed context that was elided but must be restored when confidence decays.';
    const contentHash = hashContent({ role: 'user', content: rawContent });
    const shortRef = contentHash.slice(0, 12);
    store.storeContent('session-123', contentHash, rawContent);

    const elidedItem = createContextItem({
      id: 'item-1',
      kind: 'conversation',
      contentType: 'text',
      content: `[TokenDamper Elided: ref=${shortRef} bytes=${rawContent.length} kind=conversation]`,
      origin: 'test',
      contentHash: hashContent({ originalHash: contentHash, elided: true }),
      metadata: freeze({
        elided: true,
        originalContentHash: contentHash,
        originalBytes: rawContent.length,
      }),
    });
    const items = freeze([elidedItem]);
    const statistics = createBundleStatistics(items);
    const bundle: ContextBundle = freeze({
      id: 'bundle-1',
      bundleId: 'bundle-1',
      source: 'text',
      items,
      summary: freeze({ itemCount: 1, tokenEstimate: 10, preview: elidedItem.content.slice(0, 20) }),
      statistics,
      contentHash: 'bundle-1',
    });

    const result = runSessionDedupStage(bundle, createOptimizationBudget({ riskTolerance: 'low' }), {
      previousBlockHashes: new Set<string>(),
      getContent: (hashOrRef) => store.getContent('session-123', hashOrRef),
      rehydrateRefs: new Set([shortRef]),
    });

    expect(result.changed).toBe(true);
    expect(result.metrics.itemsRehydrated).toBe(1);
    expect(result.bundle.items[0]?.content).toBe(rawContent);
    expect(result.bundle.items[0]?.metadata.rehydrated).toBe(true);
    expect(result.bundle.items[0]?.contentHash).toBe(contentHash);
  });

  it('evicts oldest session when maxSessions limit is reached', () => {
    store.getOrCreateSession('session-1');
    store.getOrCreateSession('session-2');
    expect(store.sessionCount).toBe(2);

    store.getOrCreateSession('session-3');
    expect(store.sessionCount).toBe(2);
    expect(store.getOrCreateSession('session-3').sessionId).toBe('session-3');
  });

  it('evicts oldest content entries when maxContentEntriesPerSession limit is reached', () => {
    const lruStore = new GatewaySessionStore({ maxContentEntriesPerSession: 2 });
    lruStore.storeContent('session-1', 'hash-1', 'content-1');
    lruStore.storeContent('session-1', 'hash-2', 'content-2');
    expect(lruStore.getContent('session-1', 'hash-1')).toBe('content-1');
    expect(lruStore.getContent('session-1', 'hash-2')).toBe('content-2');

    // Adding 3rd item should evict hash-1 (since hash-2 was accessed last)
    lruStore.storeContent('session-1', 'hash-3', 'content-3');
    expect(lruStore.getContent('session-1', 'hash-1')).toBeUndefined();
    expect(lruStore.getContent('session-1', 'hash-2')).toBe('content-2');
    expect(lruStore.getContent('session-1', 'hash-3')).toBe('content-3');
  });

  it('refreshes LRU position on cache hits', () => {
    const lruStore = new GatewaySessionStore({ maxContentEntriesPerSession: 2 });
    lruStore.storeContent('session-1', 'hash-1', 'content-1');
    lruStore.storeContent('session-1', 'hash-2', 'content-2');

    // Access hash-1 to refresh its LRU position (making hash-2 the oldest)
    expect(lruStore.getContent('session-1', 'hash-1')).toBe('content-1');

    // Adding hash-3 should now evict hash-2 instead of hash-1
    lruStore.storeContent('session-1', 'hash-3', 'content-3');
    expect(lruStore.getContent('session-1', 'hash-1')).toBe('content-1');
    expect(lruStore.getContent('session-1', 'hash-2')).toBeUndefined();
    expect(lruStore.getContent('session-1', 'hash-3')).toBe('content-3');
  });
});

describe('Gateway HTTP & Proxy Interceptor', () => {
  let server: GatewayServer;
  let port: number;
  let upstreamServer: HttpServer | undefined;

  beforeEach(async () => {
    server = new GatewayServer({ port: 0 });
    port = await server.start();
  });

  afterEach(async () => {
    await server.stop();
    if (upstreamServer) {
      await new Promise<void>((resolve, reject) => {
        upstreamServer?.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      upstreamServer = undefined;
    }
  });

  it('responds to GET /health', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
    const data = (await response.json()) as { status: string; activeSessions: number };
    expect(data.status).toBe('ok');
    expect(typeof data.activeSessions).toBe('number');
  });

  it('deduplicates repetitive OpenAI message content across turns', async () => {
    const sessionStore = server.getSessionStore();
    const repeatedContext = 'This is a long code context string that will be passed in turn 1 and repeated in turn 2';

    const turn1Payload = {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: repeatedContext },
      ],
    };

    const res1 = await handleProxyRequest(
      'POST',
      '/v1/chat/completions',
      { 'x-session-id': 'test-openai-session' },
      JSON.stringify(turn1Payload),
      { sessionStore },
    );

    expect(res1.statusCode).toBe(200);
    const res1Json = JSON.parse(res1.body);
    expect(res1Json.messages[0].content).toBe(repeatedContext);

    // Turn 2 repeats the context **twice**, so the first copy is preserved as a referent and
    // the second is elided recoverably.
    //
    // Phase A: the single-copy version of this payload no longer deduplicates. A sole copy
    // elided across turns is `recoverable: false`, carries no symbols and no content markers,
    // and the measurement gate now refuses to certify it — see the companion test below.
    // Within-payload duplication is unaffected because `resolveRecoverableElisions`
    // substitutes the original content back before the gate runs.
    const turn2Payload = {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: repeatedContext },
        { role: 'user', content: repeatedContext },
        { role: 'user', content: 'What does this code do?' },
      ],
    };

    const res2 = await handleProxyRequest(
      'POST',
      '/v1/chat/completions',
      { 'x-session-id': 'test-openai-session' },
      JSON.stringify(turn2Payload),
      { sessionStore },
    );

    expect(res2.statusCode).toBe(200);
    const res2Json = JSON.parse(res2.body);

    // Message 0 is preserved as the referent; message 1 is the elided copy.
    expect(res2Json.messages[0].content).toBe(repeatedContext);
    expect(res2Json.messages[1].content).toContain('[TokenDamper Elided: ref=');
    expect(sessionStore.getContent('test-openai-session', res2Json.messages[1].content)).toBe(repeatedContext);
    // The new prompt remains unchanged
    expect(res2Json.messages[2].content).toBe('What does this code do?');
  });

  it('refuses cross-turn dedup of a sole copy, which nothing witnesses (Phase A)', async () => {
    // The cost of the measurement gate, stated as a test rather than left to be discovered.
    //
    // A sole copy elided across turns is `recoverable: false`: the marker is not a pointer,
    // because the consumer is a stateless provider API that never calls `rehydrate_context`.
    // The content is deleted, and conversational prose carries neither symbols nor content
    // markers — so the elision cannot be evidenced and drift refuses it. The §9 addendum in
    // docs/phase-1-stabilization-summary.md already described this population as sending the
    // model a marker it has no way to resolve.
    const sessionStore = server.getSessionStore();
    const soleContext = 'A paragraph of ordinary conversational context that appears exactly once per turn';

    await handleProxyRequest(
      'POST',
      '/v1/chat/completions',
      { 'x-session-id': 'sole-copy-session' },
      JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: soleContext }] }),
      { sessionStore },
    );

    const turn2Body = JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: soleContext },
        { role: 'user', content: 'And now a follow-up question.' },
      ],
    });

    const res2 = await handleProxyRequest(
      'POST',
      '/v1/chat/completions',
      { 'x-session-id': 'sole-copy-session' },
      turn2Body,
      { sessionStore },
    );

    expect(res2.statusCode).toBe(200);
    const res2Json = JSON.parse(res2.body);

    // Nothing elided, and the caller's payload comes back intact.
    expect(res2Json.messages[0].content).toBe(soleContext);
    expect(res2Json.messages[1].content).toBe('And now a follow-up question.');

    const turn = sessionStore.getOrCreateSession('sole-copy-session').turns[1];
    expect(turn?.fallbackUsed).toBe(true);
    expect(turn?.optimizedTokens).toBe(turn?.rawTokens);
  });

  it('reports a computed fallbackUsed now that the proxy runs the engine (1.0b)', async () => {
    const sessionStore = server.getSessionStore();

    await handleProxyRequest(
      'POST',
      '/v1/messages',
      { 'x-session-id': 'fallback-honesty-session' },
      JSON.stringify({
        model: 'claude-sonnet-5',
        messages: [{ role: 'user', content: 'A single turn of context.' }],
      }),
      { sessionStore },
    );

    const session = sessionStore.getOrCreateSession('fallback-honesty-session');
    const turn = session.turns[0];
    expect(turn).toBeDefined();
    // The proxy now routes through core/engine.optimize(), so validators, ledgers and
    // the fallback resolver all run and the field carries a real evaluated result
    // rather than the hardcoded literal removed in Phase 1.0a.
    expect('fallbackUsed' in turn!).toBe(true);
    expect(turn!.fallbackUsed).toBe(false);
  });

  it('falls back to a byte-identical body when validation rejects the transform (1.0b)', async () => {
    const sessionStore = server.getSessionStore();
    // An imperative constraint directive. Deduplicating it away drops the directive, the
    // validators catch that, and the engine must fail open rather than ship the elision.
    const directive = 'You MUST never delete the production database under any circumstances.';

    const turn1 = JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: directive }],
    });
    await handleProxyRequest(
      'POST',
      '/v1/chat/completions',
      { 'x-session-id': 'fail-open-session' },
      turn1,
      { sessionStore },
    );

    const turn2 = JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: directive },
        { role: 'user', content: 'What should I do next?' },
      ],
    });
    const res2 = await handleProxyRequest(
      'POST',
      '/v1/chat/completions',
      { 'x-session-id': 'fail-open-session' },
      turn2,
      { sessionStore },
    );

    expect(res2.statusCode).toBe(200);
    // Fail-open (invariant 3): the caller gets their original payload back, byte for byte,
    // and the directive survives rather than being replaced by an elision marker.
    expect(res2.body).toBe(turn2);
    expect(res2.body).not.toContain('[TokenDamper Elided: ref=');

    const session = sessionStore.getOrCreateSession('fail-open-session');
    const turn = session.turns[session.turns.length - 1];
    expect(turn!.fallbackUsed).toBe(true);
    expect(turn!.tokensSaved).toBe(0);
  });

  const CODE_BLOCK = 'export function computeTotal(a, b) { const sum = a + b; return sum; }\nexport class Ledger {}';

  it('scores cross-turn elision of a sole copy as lossy, and falls back (Commit B)', async () => {
    const sessionStore = server.getSessionStore();

    // This test previously asserted the opposite, on the Phase 1.0b rationale that a dedup
    // marker is a pointer to restorable content. That rationale does not hold here: the
    // Gateway's consumer is a stateless provider API with no rehydration mechanism, so
    // content elided from the outbound payload is deleted, not referenced. With only one
    // copy in the payload nothing survives for the model to resolve the marker against, so
    // the elision is lossy and drift is right to score it.
    const turn1 = JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: CODE_BLOCK }] });
    await handleProxyRequest(
      'POST', '/v1/chat/completions', { 'x-session-id': 'sole-copy-session' }, turn1, { sessionStore },
    );

    const turn2 = JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: CODE_BLOCK },
        { role: 'user', content: 'Explain this.' },
      ],
    });
    const res2 = await handleProxyRequest(
      'POST', '/v1/chat/completions', { 'x-session-id': 'sole-copy-session' }, turn2, { sessionStore },
    );

    // Fail-open: the caller gets their payload back untouched rather than a marker the
    // model could not resolve.
    expect(res2.body).toBe(turn2);
    expect(res2.body).not.toContain('[TokenDamper Elided: ref=');

    const session = sessionStore.getOrCreateSession('sole-copy-session');
    const turn = session.turns[session.turns.length - 1];
    expect(turn!.fallbackUsed).toBe(true);
    expect(turn!.tokensSaved).toBe(0);
  });

  it('deduplicates redundant copies while preserving one referent in the payload (Commit B)', async () => {
    const sessionStore = server.getSessionStore();

    const turn1 = JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: CODE_BLOCK }] });
    await handleProxyRequest(
      'POST', '/v1/chat/completions', { 'x-session-id': 'redundant-copy-session' }, turn1, { sessionStore },
    );

    // Three copies in one payload. The first is preserved so the other two reference
    // content the model demonstrably has, in this request — a checkable precondition.
    const turn2 = JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: CODE_BLOCK },
        { role: 'user', content: 'Compare these.' },
        { role: 'user', content: CODE_BLOCK },
        { role: 'user', content: CODE_BLOCK },
      ],
    });
    const res2 = await handleProxyRequest(
      'POST', '/v1/chat/completions', { 'x-session-id': 'redundant-copy-session' }, turn2, { sessionStore },
    );

    const body = JSON.parse(res2.body);
    expect(body.messages[0].content).toBe(CODE_BLOCK); // referent preserved intact
    expect(body.messages[1].content).toBe('Compare these.');
    expect(body.messages[2].content).toContain('[TokenDamper Elided: ref=');
    expect(body.messages[3].content).toContain('[TokenDamper Elided: ref=');

    const session = sessionStore.getOrCreateSession('redundant-copy-session');
    const turn = session.turns[session.turns.length - 1];
    expect(turn!.fallbackUsed).toBe(false);
    expect(turn!.tokensSaved).toBeGreaterThan(0);
  });

  // A tool result of the shape the Gateway actually carries: JSON arriving as message
  // content. Before Commit C these items were tagged `contentType: 'text'`.
  const JSON_TOOL_RESULT = JSON.stringify({
    status: 'ok',
    durationMs: 42,
    rows: [
      { id: 1, name: 'alpha', owner: 'team-a', region: 'us-east-1' },
      { id: 2, name: 'beta', owner: 'team-b', region: 'eu-west-2' },
      { id: 3, name: 'gamma', owner: 'team-c', region: 'ap-south-1' },
    ],
    pagination: { cursor: 'eyJvZmZzZXQiOjN9', hasMore: false },
  });

  it('classifies message content, so drift can finally see JSON keys (Commit C)', async () => {
    const sessionStore = server.getSessionStore();

    const turn1 = JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: JSON_TOOL_RESULT }] });
    await handleProxyRequest(
      'POST', '/v1/chat/completions', { 'x-session-id': 'json-relabel-session' }, turn1, { sessionStore },
    );

    const turn2 = JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: JSON_TOOL_RESULT },
        { role: 'user', content: 'Summarize that result.' },
      ],
    });
    const res2 = await handleProxyRequest(
      'POST', '/v1/chat/completions', { 'x-session-id': 'json-relabel-session' }, turn2, { sessionStore },
    );

    // This is the sole copy of the content in the payload, so the elision is lossy and
    // drift must score it — exactly as the CODE_BLOCK case above already does.
    //
    // Before the relabel this payload deduplicated at ~99% and reported no fallback, but
    // only because `DriftTracker.extractSymbols` harvests `jsonkey:` symbols solely when
    // `contentType === 'json'`. Tagged `text`, a JSON document yielded zero symbols,
    // retention was vacuously 1.0 and drift vacuously 0.00 — a pass produced by not
    // looking. See docs/issue-2-content-type-contract-design.md §2.2.
    expect(res2.body).toBe(turn2);
    expect(res2.body).not.toContain('__td_block__');

    const session = sessionStore.getOrCreateSession('json-relabel-session');
    const turn = session.turns[session.turns.length - 1];
    expect(turn!.fallbackUsed).toBe(true);
    expect(turn!.tokensSaved).toBe(0);
  });

  // Passes both before and after the relabel, deliberately — see the comment inside. It is
  // a no-change guard, not evidence the relabel works. Do not cite it as the latter.
  it('emits a JSON-valid elision marker for a message classified json (Commit C)', async () => {
    const sessionStore = server.getSessionStore();

    const turn1 = JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: JSON_TOOL_RESULT }] });
    await handleProxyRequest(
      'POST', '/v1/chat/completions', { 'x-session-id': 'json-wrapper-session' }, turn1, { sessionStore },
    );

    // Two copies: the first is preserved as the referent, so the second is recoverable and
    // survives the drift gate. That is what lets this test observe the emitted marker.
    const turn2 = JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: JSON_TOOL_RESULT },
        { role: 'user', content: JSON_TOOL_RESULT },
      ],
    });
    const res2 = await handleProxyRequest(
      'POST', '/v1/chat/completions', { 'x-session-id': 'json-wrapper-session' }, turn2, { sessionStore },
    );

    const body = JSON.parse(res2.body) as { messages: Array<{ content: string }> };
    expect(body.messages[0]!.content).toBe(JSON_TOOL_RESULT);

    // The relabel moves `resolveElisionSyntax` from its classifier-vacuum branch onto the
    // `selectValidator` branch: the tag now selects JsonValidator directly, where before the
    // item had no governing authority and fell through to `classifyContent`.
    //
    // Both branches must render the same bytes — that is the point of Commit A routing them
    // through one classifier — so this assertion held before the relabel too and is not
    // evidence that the relabel took effect. What it pins is the *identity*: if a future
    // change makes the two branches disagree, an item's emitted syntax would depend on
    // whether its tag happened to be computed, which is the producer/checker split this
    // whole contract exists to prevent.
    const elided = body.messages[1]!.content;
    const parsed = JSON.parse(elided) as Record<string, unknown>;
    expect(parsed.__td_block__).toContain('[TokenDamper Elided: ref=');
    expect(sessionStore.getContent('json-wrapper-session', elided)).toBe(JSON_TOOL_RESULT);

    const session = sessionStore.getOrCreateSession('json-wrapper-session');
    expect(session.turns[session.turns.length - 1]!.fallbackUsed).toBe(false);
  });

  it('does not fall back on a fenced message that no stage transformed (Commit C1)', async () => {
    const sessionStore = server.getSessionStore();

    // Turn 1 has no previous block hashes, so `cleanup:session-dedup` cannot elide anything
    // and the bundle reaches validation untouched. Any fallback here is a false positive.
    //
    // The relabel is what exposes this: with `contentType` computed, a fenced message used
    // to classify as `code`, and `selectValidator` maps `code` to the TypeScript validator.
    // The three apostrophes below then read as an unterminated string literal. Commit C1
    // reclassified fenced content as `markdown`, which selects no validator. DECISIONS.md §17.
    const message = "Here's the fix. It's the guard that's missing:\n\n```ts\nconst a = 1;\n```";
    const body = JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: message }] });

    const res = await handleProxyRequest(
      'POST', '/v1/chat/completions', { 'x-session-id': 'fenced-prose-session' }, body, { sessionStore },
    );

    expect(res.body).toBe(body);
    const session = sessionStore.getOrCreateSession('fenced-prose-session');
    expect(session.turns[0]!.fallbackUsed).toBe(false);
  });

  it('forwards optimized OpenAI requests upstream with authorization headers', async () => {
    const sessionStore = server.getSessionStore();
    let forwardedBody = '';
    let forwardedAuthorization = '';

    upstreamServer = createServer((req, res) => {
      forwardedAuthorization = req.headers.authorization ?? '';
      req.on('data', (chunk) => {
        forwardedBody += chunk;
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'upstream-openai' });
        res.end(JSON.stringify({ id: 'chatcmpl-test', choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
      });
    });

    const upstreamPort = await listenOnEphemeralPort(upstreamServer);
    const payload = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Forward this upstream' }],
    };

    const result = await handleProxyRequest(
      'POST',
      '/v1/chat/completions',
      { authorization: 'Bearer test-openai-key', 'x-session-id': 'forward-openai-session' },
      JSON.stringify(payload),
      { sessionStore, upstreamOpenAiUrl: `http://127.0.0.1:${upstreamPort}` },
    );

    expect(result.statusCode).toBe(200);
    expect(result.headers['content-type']).toContain('application/json');
    expect(JSON.parse(result.body)).toMatchObject({ id: 'chatcmpl-test' });
    expect(forwardedAuthorization).toBe('Bearer test-openai-key');
    expect(JSON.parse(forwardedBody)).toMatchObject(payload);
  });

  it('streams upstream SSE chunks through the gateway server', async () => {
    upstreamServer = createServer((req, res) => {
      expect(req.url).toBe('/v1/chat/completions');
      expect(req.headers.authorization).toBe('Bearer test-openai-key');
      req.resume();
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
        res.end('data: [DONE]\n\n');
      });
    });

    const upstreamPort = await listenOnEphemeralPort(upstreamServer);
    await server.stop();
    server = new GatewayServer({
      port: 0,
      upstreamOpenAiUrl: `http://127.0.0.1:${upstreamPort}`,
    });
    port = await server.start();

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-openai-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        stream: true,
        messages: [{ role: 'user', content: 'stream this' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    await expect(response.text()).resolves.toBe('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n');
  });

  it('deduplicates Anthropic messages while preserving system prompt', async () => {
    const sessionStore = server.getSessionStore();
    const systemPrompt = 'You are a helpful coding assistant.';
    const repeatedContext = 'Unchanged repository context file contents sent repeatedly across turns';

    const turn1Payload = {
      model: 'claude-3-5-sonnet-20241022',
      system: systemPrompt,
      messages: [
        { role: 'user', content: repeatedContext },
      ],
    };

    const res1 = await handleProxyRequest(
      'POST',
      '/v1/messages',
      { 'x-session-id': 'test-anthropic-session' },
      JSON.stringify(turn1Payload),
      { sessionStore },
    );

    expect(res1.statusCode).toBe(200);

    // Turn 2 repeats context twice — the first copy is the referent, the second is elided
    // recoverably. A sole copy is refused since Phase A; see the OpenAI companion test.
    const turn2Payload = {
      model: 'claude-3-5-sonnet-20241022',
      system: systemPrompt,
      messages: [
        { role: 'user', content: repeatedContext },
        { role: 'user', content: repeatedContext },
        { role: 'user', content: 'Fix the bug in this file' },
      ],
    };

    const res2 = await handleProxyRequest(
      'POST',
      '/v1/messages',
      { 'x-session-id': 'test-anthropic-session' },
      JSON.stringify(turn2Payload),
      { sessionStore },
    );

    expect(res2.statusCode).toBe(200);
    const res2Json = JSON.parse(res2.body);

    // System prompt must remain unchanged
    expect(res2Json.system).toBe(systemPrompt);
    // First copy preserved as referent, second elided
    expect(res2Json.messages[0].content).toBe(repeatedContext);
    expect(res2Json.messages[1].content).toContain('[TokenDamper Elided: ref=');
    // New turn message remains intact
    expect(res2Json.messages[2].content).toBe('Fix the bug in this file');
  });

  it('returns 400 when invalid JSON is sent', async () => {
    const sessionStore = server.getSessionStore();
    const res = await handleProxyRequest(
      'POST',
      '/v1/messages',
      {},
      'invalid json string',
      { sessionStore },
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Invalid Anthropic JSON payload');
  });
});

describe('GatewayServer Security & Limits', () => {
  it('rejects requests missing valid gateway token with 401', async () => {
    const server = new GatewayServer({ port: 0, gatewayToken: 'secret-token' });
    const port = await server.start();

    try {
      const protectedResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({ messages: [] }),
      });
      expect(protectedResponse.status).toBe(401);

      const validResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'x-tokendamper-token': 'secret-token' },
        body: JSON.stringify({ messages: [] }),
      });
      expect(validResponse.status).not.toBe(401);
    } finally {
      await server.stop();
    }
  });

  it('rejects payload exceeding 10MB with 413', async () => {
    const server = new GatewayServer({ port: 0 });
    const port = await server.start();
    
    try {
      const largeBody = 'a'.repeat(10 * 1024 * 1024 + 100);
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        body: largeBody,
      });
      expect(response.status).toBe(413);
    } finally {
      await server.stop();
    }
  });
});

async function listenOnEphemeralPort(server: HttpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve(address.port);
      } else {
        reject(new Error('Failed to bind test server'));
      }
    });
    server.on('error', (error) => reject(error));
  });
}
