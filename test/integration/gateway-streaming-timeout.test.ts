import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GatewayServer } from '../../src/gateway/server';

/**
 * The upstream timeout budgets time-to-first-byte, not the whole response — audit OX-H2.
 *
 * `forwardUpstreamRequest` armed `AbortSignal.timeout(30000)` and passed it to `fetch`. That
 * signal does not stop governing once headers arrive: it governs the **response body stream** as
 * well. So for `"stream": true` payloads the reader rejected roughly 30 s in and the pump called
 * `res.destroy(...)`, truncating the answer mid-generation.
 *
 * LLM completions routinely exceed 30 s of wall clock — long-form Anthropic streams especially —
 * so this broke exactly the traffic the Gateway intercepts by default. It is also silent from the
 * client's side in the worst way: a partial answer that looks like the model stopped.
 *
 * The budget now applies to headers only and is disarmed the moment `fetch` resolves. The
 * caller-disconnect signal stays combined into the same fetch signal, so a client hanging up still
 * kills the upstream request — that path is asserted below too, because a timeout fix that
 * silently removed it would be a worse regression than the bug.
 *
 * These tests drive a real upstream over a socket rather than `mockUpstream`, because the defect
 * lives in `fetch`'s signal handling and a short-circuited upstream never exercises it. The budget
 * is configurable (`upstreamTtfbTimeoutMs`) partly so this suite runs in milliseconds instead of
 * needing a 30-second upstream, which is why the audit could observe the defect but no test caught
 * it.
 */
describe('gateway upstream timeout', () => {
  let upstream: Server;
  let upstreamPort: number;

  /** Set per-test to shape how the upstream responds. */
  let headerDelayMs = 0;
  let chunkCount = 3;
  let chunkGapMs = 0;
  /** Set when the upstream's own response socket closes before it finished writing. */
  let upstreamClosedEarly = false;

  const CHUNK = 'data: {"choices":[{"delta":{"content":"tok"}}]}\n\n';

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      const body: Buffer[] = [];
      req.on('data', (c: Buffer) => body.push(c));
      req.on('end', () => {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.on('close', () => {
            if (!res.writableEnded) upstreamClosedEarly = true;
          });
          let sent = 0;
          const pump = (): void => {
            if (sent >= chunkCount) {
              res.end('data: [DONE]\n\n');
              return;
            }
            sent += 1;
            res.write(CHUNK);
            setTimeout(pump, chunkGapMs);
          };
          pump();
        }, headerDelayMs);
      });
    });

    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const addr = upstream.address();
    expect(addr).not.toBeNull();
    upstreamPort = (addr as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  const withGateway = async <T>(
    ttfbMs: number,
    run: (port: number) => Promise<T>,
  ): Promise<T> => {
    const server = new GatewayServer({
      port: 0,
      upstreamOpenAiUrl: `http://127.0.0.1:${upstreamPort}`,
      upstreamTtfbTimeoutMs: ttfbMs,
    });
    await server.start();
    const bound = server.port as number;
    try {
      return await run(bound);
    } finally {
      await server.stop();
    }
  };

  const post = (port: number) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const payload = Buffer.from(
        JSON.stringify({ model: 'gpt-x', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
        'utf8',
      );
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer sk-test',
            'content-length': payload.length,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          );
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(payload);
    });

  it('delivers a stream whose body outlives the timeout budget', async () => {
    // The defect. Headers arrive immediately; the body then takes well over the budget to finish.
    // Under the old signal the reader rejected mid-stream and the pump destroyed the response.
    headerDelayMs = 0;
    chunkCount = 5;
    chunkGapMs = 60; // ~300ms of body against a 120ms budget

    const result = await withGateway(120, post);

    expect(result.status).toBe(200);
    expect(result.body).toContain('[DONE]');
    expect(result.body.split('data: {').length - 1).toBe(5);
  }, 30_000);

  it('still returns 504 when the upstream is slow to send headers', async () => {
    // The behaviour the budget exists for, and the mapping the audit said must be preserved.
    headerDelayMs = 400;
    chunkCount = 1;
    chunkGapMs = 0;

    const result = await withGateway(120, post);

    expect(result.status).toBe(504);
    expect(result.body).toContain('Gateway Timeout');
  }, 30_000);

  it('still aborts the upstream when the client hangs up mid-stream', async () => {
    // The half a careless timeout fix removes. Disarming the budget must not disarm the
    // caller-disconnect signal — otherwise a client that walks away leaves the Gateway pulling a
    // response nobody will read, and paying the provider for it.
    headerDelayMs = 0;
    chunkCount = 200;
    chunkGapMs = 20;
    upstreamClosedEarly = false;

    await withGateway(120, async (port) => {
      // Every path resolves — a client that hangs up mid-stream legitimately produces socket
      // errors on both sides, and none of them is a test failure. The assertion is on what the
      // upstream observed, not on how the client's own socket ended.
      await new Promise<void>((resolve) => {
        const payload = Buffer.from(
          JSON.stringify({ model: 'gpt-x', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
          'utf8',
        );
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: 'Bearer sk-test',
              'content-length': payload.length,
            },
          },
          (res) => {
            res.once('data', () => {
              // Hang up after the first chunk, while the upstream is still generating.
              req.destroy();
              resolve();
            });
            res.on('error', () => resolve());
          },
        );
        req.on('error', () => resolve());
        req.end(payload);
      });

      // Give the abort a moment to propagate through the pump to the upstream socket.
      await new Promise((r) => setTimeout(r, 300));

      // Read *inside* the gateway's lifetime. `withGateway` stops the server on the way out, and
      // that closes the upstream socket too — so asserting after it returns would pass whether or
      // not the client hangup propagated. Sampling here is what makes this test about the abort.
      return upstreamClosedEarly;
    }).then((closedBeforeShutdown) => {
      expect(closedBeforeShutdown).toBe(true);
    });
  }, 30_000);

  it('does not truncate a slow body just because the budget is small', async () => {
    // Same property as the first case, pushed harder: the body takes an order of magnitude longer
    // than the budget. A per-chunk or restarted timer would fail this even though it passes the
    // first.
    headerDelayMs = 0;
    chunkCount = 8;
    chunkGapMs = 50; // ~400ms of body against a 40ms budget

    const result = await withGateway(40, post);

    expect(result.status).toBe(200);
    expect(result.body).toContain('[DONE]');
    expect(result.body.split('data: {').length - 1).toBe(8);
  }, 30_000);
});
