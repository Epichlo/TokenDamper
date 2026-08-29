import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GatewayServer } from '../../src/gateway/server';

/**
 * Audit OX-M9 — no OPTIONS handler, no Origin or Host validation. OX-L13 (`/health` reporting
 * `sessionCount` unauthenticated) is folded in deliberately: whether that endpoint needs
 * protecting is the same question, and `server.ts` already carried a comment deferring it here
 * so the two answers could not drift.
 *
 * The threat is narrow and worth stating exactly, because overstating it leads to overcorrecting:
 * a web page the victim visits can issue a **simple** cross-origin POST (`text/plain`) to
 * `http://127.0.0.1:<port>/v1/chat/completions` with no preflight. It cannot read the response —
 * there are no CORS headers to grant that — and it must supply its own upstream credentials. What
 * it gets is the victim's machine as a relay and whatever provider-side effects the request has.
 * A DNS-rebinding variant reaches the same port with an attacker-controlled `Host`.
 *
 * The decision is **Origin/Host validation, not token-on-loopback**. Requiring
 * `x-tokendamper-token` even on loopback splits browsers from local clients more cleanly —
 * browsers cannot set custom headers on a simple request — but it taxes every existing local
 * client to close a browser-only hole.
 *
 * One correction to the decision as recorded: it says non-browser clients "send neither header".
 * That is true of `Origin` and false of `Host`, which every HTTP/1.1 client must send. The local
 * client contract is preserved by *what* is accepted — loopback names and the configured bind —
 * not by the header being absent, and the tests below pin both halves.
 */
describe('gateway Origin and Host policy (audit OX-M9, OX-L13)', () => {
  let server: GatewayServer;
  let port: number;

  beforeAll(async () => {
    server = new GatewayServer({ port: 0, mockUpstream: true, allowMissingUpstreamCredentials: true });
    port = await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  interface Reply {
    readonly status: number;
    readonly headers: Record<string, string | string[] | undefined>;
    readonly body: string;
  }

  const send = (
    options: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
  ): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const payload = options.body;
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: options.path ?? '/v1/chat/completions',
          method: options.method ?? 'POST',
          headers: {
            'content-type': 'application/json',
            ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
            ...options.headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });

  const CHAT = JSON.stringify({
    model: 'gpt-4',
    messages: [{ role: 'user', content: 'hello' }],
  });

  describe('Origin', () => {
    it('rejects a POST carrying a foreign Origin', async () => {
      const reply = await send({ headers: { origin: 'https://evil.example.com' }, body: CHAT });
      expect(reply.status).toBe(403);
      expect(reply.body).toMatch(/origin/i);
    });

    it('rejects a foreign Origin even when it is another localhost port', async () => {
      // Same-host, different-port is still a different origin, and it is the shape a malicious
      // local page actually has.
      const reply = await send({ headers: { origin: `http://127.0.0.1:${port + 1}` }, body: CHAT });
      expect(reply.status).toBe(403);
    });

    it('accepts a POST with no Origin at all — the local client contract', async () => {
      const reply = await send({ body: CHAT });
      expect(reply.status).not.toBe(403);
    });

    it('accepts a same-origin POST', async () => {
      const reply = await send({ headers: { origin: `http://127.0.0.1:${port}` }, body: CHAT });
      expect(reply.status).not.toBe(403);
    });
  });

  describe('Host', () => {
    it('rejects a Host naming somewhere else — the DNS-rebinding shape', async () => {
      const reply = await send({ headers: { host: 'evil.example.com' }, body: CHAT });
      expect(reply.status).toBe(403);
      expect(reply.body).toMatch(/host/i);
    });

    it('accepts the loopback names a local client actually sends', async () => {
      for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
        const reply = await send({ headers: { host }, body: CHAT });
        expect(reply.status, `Host: ${host}`).not.toBe(403);
      }
    });
  });

  describe('OPTIONS', () => {
    it('answers without granting any cross-origin permission', async () => {
      const reply = await send({ method: 'OPTIONS', headers: { origin: 'https://evil.example.com' } });
      expect(reply.headers['access-control-allow-origin']).toBeUndefined();
      expect(reply.headers['access-control-allow-headers']).toBeUndefined();
      expect(reply.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('does not fall through to the proxy as an unhandled method', async () => {
      const reply = await send({ method: 'OPTIONS' });
      expect([204, 403, 405]).toContain(reply.status);
    });
  });

  describe('/health (audit OX-L13)', () => {
    it('still answers, so a liveness probe keeps working', async () => {
      const reply = await send({ method: 'GET', path: '/health' });
      expect(reply.status).toBe(200);
      expect(JSON.parse(reply.body).status).toBe('ok');
    });

    it('no longer reports how many sessions are open', async () => {
      const reply = await send({ method: 'GET', path: '/health' });
      const parsed = JSON.parse(reply.body) as Record<string, unknown>;
      expect(parsed).not.toHaveProperty('activeSessions');
      expect(parsed).not.toHaveProperty('sessionCount');
    });

    it('is subject to the same Host rule as everything else', async () => {
      const reply = await send({ method: 'GET', path: '/health', headers: { host: 'evil.example.com' } });
      expect(reply.status).toBe(403);
    });
  });
});
