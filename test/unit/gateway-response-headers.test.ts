import { describe, expect, it } from 'vitest';
import { handleProxyRequest } from '../../src/gateway/proxy';
import { GatewaySessionStore } from '../../src/gateway/session-store';

const BODY = JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] });

const SECRETS = {
  authorization: 'Bearer sk-super-secret',
  'x-api-key': 'sk-test-secret',
  cookie: 'session=deadbeef',
} as const;

/**
 * Audit M9 — request headers were returned as response headers.
 *
 * The two optimize paths returned `{ ...cleanHeaders, 'content-type': 'application/json' }`,
 * and `cleanHeaders` strips only `host` and `content-length`. Everything else the caller sent
 * — `authorization`, `x-api-key`, cookies — came back out on the response.
 *
 * Audit M8 — the switch that made it observable was an environment variable.
 *
 * `TOKENDAMPER_MOCK_UPSTREAM` and `NODE_ENV === 'test'` were read from `process.env` inside the
 * request path. Both are now injected options, which is what lets these tests state their
 * preconditions instead of inheriting them from whatever set a variable.
 */
describe('the Gateway constructs its response headers (M9)', () => {
  for (const route of ['/v1/chat/completions', '/v1/messages'] as const) {
    it(`does not echo request credentials back on ${route}`, async () => {
      const result = await handleProxyRequest(
        'POST',
        route,
        { ...SECRETS, 'content-type': 'application/json', 'x-session-id': 'm9' },
        BODY,
        { sessionStore: new GatewaySessionStore(), mockUpstream: true },
      );

      expect(result.statusCode).toBe(200);

      const returned = Object.keys(result.headers).map((k) => k.toLowerCase());
      for (const secret of Object.keys(SECRETS)) {
        expect(returned).not.toContain(secret);
      }
      // Nor by value under some other name.
      const values = Object.values(result.headers).join(' ');
      for (const value of Object.values(SECRETS)) {
        expect(values).not.toContain(value);
      }

      // What it does carry is exactly what it needs to.
      expect(result.headers['content-type']).toBe('application/json');
      expect(Object.keys(result.headers)).toEqual(['content-type']);
    });
  }

  it('does not echo them on the non-UTF-8 pass-through path either', async () => {
    // `passThroughUnrepresentable` returned `cleanHeaders` too — a body that fails the UTF-8
    // round trip is forwarded untouched, but that is a reason to preserve the *body*, not the
    // caller's credentials on the way back.
    const latin1 = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xe9, 0x22, 0x7d]);

    const result = await handleProxyRequest(
      'POST',
      '/v1/messages',
      { ...SECRETS },
      latin1.toString('utf8'),
      { sessionStore: new GatewaySessionStore(), mockUpstream: true, rawBodyBytes: latin1 },
    );

    expect(result.statusCode).toBe(200);
    expect(result.bodyBytes).toBeDefined();
    expect(Object.keys(result.headers)).toEqual(['content-type']);
  });
});

describe('the Gateway test seams are parameters, not environment variables (M8)', () => {
  it('refuses a request with no upstream credentials by default', async () => {
    // The default now holds even under vitest, which sets `NODE_ENV=test`. Before M8 this
    // branch waived the check whenever that variable was set — by this test runner, and by a
    // great many CI systems and process managers that mean nothing by it.
    const result = await handleProxyRequest(
      'POST',
      '/v1/chat/completions',
      { 'content-type': 'application/json' },
      BODY,
      { sessionStore: new GatewaySessionStore() },
    );

    expect(result.statusCode).toBe(401);
    expect(result.body).toContain('Missing upstream authorization header');
  });

  it('waives the credentials check only when the option says so', async () => {
    const result = await handleProxyRequest(
      'POST',
      '/v1/chat/completions',
      { 'content-type': 'application/json' },
      BODY,
      { sessionStore: new GatewaySessionStore(), allowMissingUpstreamCredentials: true },
    );

    expect(result.statusCode).toBe(200);
  });

  it('ignores TOKENDAMPER_MOCK_UPSTREAM in the environment', async () => {
    const prior = process.env.TOKENDAMPER_MOCK_UPSTREAM;
    process.env.TOKENDAMPER_MOCK_UPSTREAM = 'true';
    try {
      // With the env var set but the option absent, the request must reach the credentials
      // gate rather than being answered locally. An agent pointed at a process that happens to
      // carry this variable must not receive its own prompt back as though a model wrote it.
      const result = await handleProxyRequest(
        'POST',
        '/v1/chat/completions',
        { 'content-type': 'application/json' },
        BODY,
        { sessionStore: new GatewaySessionStore() },
      );
      expect(result.statusCode).toBe(401);
    } finally {
      if (prior === undefined) delete process.env.TOKENDAMPER_MOCK_UPSTREAM;
      else process.env.TOKENDAMPER_MOCK_UPSTREAM = prior;
    }
  });
});
