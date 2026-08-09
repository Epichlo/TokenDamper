import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runExecCommand } from '../../src/gateway/exec';
import { GatewayServer } from '../../src/gateway/server';

/**
 * `tokendamper exec` has to work end to end — audit C3.
 *
 * The audit's closing note on C3 was that "an end-to-end test that actually spawns a child and
 * makes a request would have caught this". It would have: `runExecCommand` generated a token and
 * injected it as `TOKENDAMPER_GATEWAY_TOKEN`, a variable **nothing in `src/` ever read** and that
 * no third-party client has heard of, while the server required it on every request. The child is
 * `aider`, `claude`, `codex` or `curl`; it sends `authorization` or `x-api-key` and nothing else.
 * Every request came back `401`, on the command the README documents as the primary usage — and
 * `exec` still exited `0`.
 *
 * The unit-level tests below pin the server-side carve-out; the spawning test pins the whole
 * handoff, because the defect lived in the gap between two components that were each fine.
 */
describe('tokendamper exec reaches its own gateway', () => {
  let tempDir: string;

  beforeAll(() => {
    process.env.TOKENDAMPER_MOCK_UPSTREAM = 'true';
  });

  afterAll(() => {
    delete process.env.TOKENDAMPER_MOCK_UPSTREAM;
  });

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tokendamper-exec-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('spawns a child that can actually reach the gateway it was pointed at', async () => {
    // A stand-in for a third-party coding agent: it reads ANTHROPIC_BASE_URL and sends
    // `x-api-key`. It deliberately does NOT read TOKENDAMPER_GATEWAY_TOKEN — that is the point.
    const resultPath = join(tempDir, 'result.json');
    const agentPath = join(tempDir, 'agent.cjs');
    writeFileSync(
      agentPath,
      `const fs = require('node:fs');
(async () => {
  const out = { base: process.env.ANTHROPIC_BASE_URL, httpProxy: process.env.HTTP_PROXY ?? null };
  try {
    const res = await fetch(out.base + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' },
      body: JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] }),
    });
    out.status = res.status;
    out.body = await res.text();
  } catch (e) { out.error = e.message; }
  fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(out), 'utf8');
})();`,
      'utf8',
    );

    const exitCode = await runExecCommand(['node', JSON.stringify(agentPath)]);
    expect(exitCode).toBe(0);

    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      status?: number;
      body?: string;
      error?: string;
      httpProxy: string | null;
      base: string;
    };

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(200);

    // `HTTP_PROXY`/`HTTPS_PROXY` must not be set: `GatewayServer` is an origin server, not an
    // HTTP proxy, and implements neither absolute-form request URIs nor `CONNECT`. Setting them
    // broke any client that honoured them, independently of the 401.
    expect(result.httpProxy).toBeNull();
  }, 30_000);
});

describe('gateway authorization', () => {
  let server: GatewayServer;
  let port: number;
  let priorMock: string | undefined;

  const post = (headers: Record<string, string>, path = '/v1/messages') =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', reject);
      req.end(body);
    });

  beforeAll(async () => {
    priorMock = process.env.TOKENDAMPER_MOCK_UPSTREAM;
    process.env.TOKENDAMPER_MOCK_UPSTREAM = 'true';
    // A token IS configured — the point is that loopback does not need to present it.
    server = new GatewayServer({ port: 0, gatewayToken: 'secret-token-value' });
    await server.start();
    const bound = server.port;
    expect(bound).toBeTypeOf('number');
    port = bound as number;
  });

  afterAll(async () => {
    await server.stop();
    if (priorMock === undefined) delete process.env.TOKENDAMPER_MOCK_UPSTREAM;
    else process.env.TOKENDAMPER_MOCK_UPSTREAM = priorMock;
  });

  it('accepts a loopback request carrying no gateway token', async () => {
    const res = await post({ 'x-api-key': 'sk-test' });
    expect(res.status).toBe(200);
  });

  it('still accepts a loopback request that does present the token', async () => {
    const res = await post({ 'x-api-key': 'sk-test', 'x-tokendamper-token': 'secret-token-value' });
    expect(res.status).toBe(200);
  });

  it('does not treat a wrong token as a reason to reject a loopback peer', async () => {
    // The carve-out is about *who is connecting*, not about what they claim. A loopback client
    // that sends a stale token from a previous run must not be locked out.
    const res = await post({ 'x-api-key': 'sk-test', 'x-tokendamper-token': 'stale-token' });
    expect(res.status).toBe(200);
  });

  it('no longer authenticates via a ?token= query parameter', async () => {
    // Audit L2: a credential in the query string lands in access logs, shell history and any
    // error that echoes the URL. With loopback trust it bought nothing, so it is gone. The
    // request still succeeds — because the peer is loopback, not because the token was accepted.
    const res = await post({ 'x-api-key': 'sk-test' }, '/v1/messages?token=secret-token-value');
    expect(res.status).toBe(200);
  });

  it('serves /health without authorization', async () => {
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/health', method: 'GET' }, (r) => {
        r.resume();
        r.on('end', () => resolve({ status: r.statusCode ?? 0 }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(200);
  });
});
