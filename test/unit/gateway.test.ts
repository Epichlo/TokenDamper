import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleProxyRequest } from '../../src/gateway/proxy';
import { GatewayServer } from '../../src/gateway/server';
import { GatewaySessionStore } from '../../src/gateway/session-store';

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
    expect(store.hasBlockHash('session-123', 'hash-abc')).toBe(true);
    expect(store.hasBlockHash('session-123', 'hash-unknown')).toBe(false);
  });

  it('evicts oldest session when maxSessions limit is reached', () => {
    store.getOrCreateSession('session-1');
    store.getOrCreateSession('session-2');
    expect(store.sessionCount).toBe(2);

    store.getOrCreateSession('session-3');
    expect(store.sessionCount).toBe(2);
    expect(store.getOrCreateSession('session-3').sessionId).toBe('session-3');
  });
});

describe('Gateway HTTP & Proxy Interceptor', () => {
  let server: GatewayServer;
  let port: number;

  beforeEach(async () => {
    server = new GatewayServer({ port: 0 });
    port = await server.start();
  });

  afterEach(async () => {
    await server.stop();
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

    // Turn 2 repeats the context along with a new prompt
    const turn2Payload = {
      model: 'gpt-4o',
      messages: [
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

    // Message 0 should be elided
    expect(res2Json.messages[0].content).toContain('[TokenDamper Elided: ref=');
    // Message 1 should remain unchanged
    expect(res2Json.messages[1].content).toBe('What does this code do?');
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

    // Turn 2 repeats context
    const turn2Payload = {
      model: 'claude-3-5-sonnet-20241022',
      system: systemPrompt,
      messages: [
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
    // Repeated context message should be elided
    expect(res2Json.messages[0].content).toContain('[TokenDamper Elided: ref=');
    // New turn message remains intact
    expect(res2Json.messages[1].content).toBe('Fix the bug in this file');
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
