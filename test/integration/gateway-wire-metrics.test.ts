import { describe, expect, it } from 'vitest';
import { handleProxyRequest } from '../../src/gateway/proxy';
import { GatewaySessionStore } from '../../src/gateway/session-store';

/**
 * What the Gateway does to the caller's bytes — audit M7.
 *
 * M7 says savings are computed from `summary.tokenEstimate` — a property of the bundle *render*
 * — while what leaves the process is a re-serialization of the parsed payload. The second half
 * is the one with user-visible consequences, and these tests are written against it.
 *
 * **Every test here needs a warm-up turn, and says so.** `cleanup:session-dedup` elides a block
 * only once a previous turn has registered its hash, so a single-turn fixture elides nothing and
 * every assertion below passes without exercising anything. The first version of this file did
 * exactly that and was green: 4520 bytes in, 4520 out, `tokensSaved: 0`. `elisionFired` is
 * asserted first for that reason — invariant 10 applied to this file.
 */

const BLOCK = Array.from(
  { length: 24 },
  (_, i) => `export function helper${i}(input) {\n  const scaled = input * ${i};\n  return scaled + ${i};\n}`,
).join('\n\n');

async function send(rawBody: string, store: GatewaySessionStore, sessionId: string): Promise<string> {
  const result = await handleProxyRequest(
    'POST',
    '/v1/chat/completions',
    { 'content-type': 'application/json', authorization: 'Bearer sk-test', 'x-session-id': sessionId },
    rawBody,
    { sessionStore: store, mockUpstream: true, rawBodyBytes: Buffer.from(rawBody, 'utf8') },
  );
  return String(result.body ?? '');
}

/** A session whose first turn has already registered `BLOCK`, so the next one can elide it. */
async function warmedSession(sessionId: string): Promise<GatewaySessionStore> {
  const store = new GatewaySessionStore();
  await send(
    JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: BLOCK }] }),
    store,
    sessionId,
  );
  return store;
}

describe('the Gateway forwards the caller’s bytes, not a re-encoding of them (audit M7)', () => {
  it('preserves numeric literals it has no reason to touch, including past 2^53', async () => {
    const session = `m7-numbers-${Date.now()}`;
    const store = await warmedSession(session);

    // Hand-written rather than built with `JSON.stringify`, which would normalise these literals
    // before they were ever sent — the first probe did that and could not observe the defect.
    const encoded = JSON.stringify(BLOCK);
    const rawBody =
      `{\n  "model": "gpt-4",\n  "temperature": 1.0,\n  "top_p": 1e3,\n` +
      `  "seed": 12345678901234567890,\n  "messages": [\n` +
      `    {"role": "user", "content": ${encoded}},\n` +
      `    {"role": "user", "content": ${encoded}}\n  ]\n}`;

    const forwarded = await send(rawBody, store, session);

    // The elision has to have happened, or everything below is vacuous.
    expect(forwarded).not.toBe(rawBody);
    expect(Buffer.byteLength(forwarded, 'utf8')).toBeLessThan(Buffer.byteLength(rawBody, 'utf8'));

    // Measured before the fix: 1.0 -> 1, 1e3 -> 1000, and the seed came out as
    // 12345678901234567000 — a different number than the caller asked for.
    expect(forwarded).toContain('"temperature": 1.0');
    expect(forwarded).toContain('"top_p": 1e3');
    expect(forwarded).toContain('"seed": 12345678901234567890');
  });

  it('preserves the caller’s formatting outside the elided content', async () => {
    const session = `m7-format-${Date.now()}`;
    const store = await warmedSession(session);

    const encoded = JSON.stringify(BLOCK);
    const rawBody =
      `{\n  "model": "gpt-4",\n  "messages": [\n` +
      `    {"role": "user", "content": ${encoded}},\n` +
      `    {"role": "user", "content": ${encoded}}\n  ]\n}`;

    const forwarded = await send(rawBody, store, session);

    expect(forwarded).not.toBe(rawBody);
    // Pretty-printing survives: only the content strings were replaced.
    expect(forwarded).toContain('{\n  "model": "gpt-4",\n  "messages": [\n');
  });

  it('never forwards a body larger than the one it received', async () => {
    const session = `m7-growth-${Date.now()}`;
    const store = await warmedSession(session);

    const encoded = JSON.stringify(BLOCK);
    const rawBody = `{"model":"gpt-4","messages":[{"role":"user","content":${encoded}},{"role":"user","content":${encoded}}]}`;

    const forwarded = await send(rawBody, store, session);

    expect(Buffer.byteLength(forwarded, 'utf8')).toBeLessThanOrEqual(Buffer.byteLength(rawBody, 'utf8'));
  });

  it('leaves the request byte-identical when nothing was elided', async () => {
    const session = `m7-untouched-${Date.now()}`;
    const store = new GatewaySessionStore();

    // No warm-up and no duplication: nothing to elide, so nothing may change.
    const rawBody = `{\n  "model": "gpt-4",\n  "temperature": 1.0,\n  "messages": [\n    {"role": "user", "content": "hello"}\n  ]\n}`;

    expect(await send(rawBody, store, session)).toBe(rawBody);
  });

  it('reports a saving only when the forwarded bytes actually shrank', async () => {
    const session = `m7-agree-${Date.now()}`;
    const store = await warmedSession(session);

    const rawBody = JSON.stringify({
      model: 'gpt-4',
      messages: [
        { role: 'user', content: BLOCK },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: BLOCK },
      ],
    });

    const forwarded = await send(rawBody, store, session);
    const wireSaved = Buffer.byteLength(rawBody, 'utf8') - Buffer.byteLength(forwarded, 'utf8');

    const turns = store.getSession(session)?.turns ?? [];
    const reported = turns[turns.length - 1];

    // Asserted, not assumed: without a real elision this test proves nothing.
    expect(wireSaved).toBeGreaterThan(0);
    expect(reported?.tokensSaved ?? 0).toBeGreaterThan(0);

    // The reported figure is a token estimate over item content and the wire figure is bytes of
    // JSON, so they are not required to match — only to agree about direction and stay in the
    // same neighbourhood. Measured: 48.5% reported against 47.1% on the wire, the gap being the
    // JSON structural overhead the estimate does not see. Pinned loosely on purpose; tightening
    // it would be asserting that two different units are the same quantity, which is the defect
    // DECISIONS §19 exists to prevent.
    const reportedRatio = (reported?.dedupRatio ?? 0) as number;
    const wireRatio = wireSaved / Buffer.byteLength(rawBody, 'utf8');
    expect(Math.abs(reportedRatio - wireRatio)).toBeLessThan(0.1);
  });
});
