import { once } from 'node:events';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { handleProxyRequest } from './proxy';
import { GatewaySessionStore } from './session-store';
import type { GatewayConfig, ProxyRequestResult } from './types';

export class GatewayServer {
  private readonly server: Server;
  private readonly sessionStore: GatewaySessionStore;
  private readonly config: GatewayConfig;
  private listeningPort?: number;

  constructor(config?: Partial<GatewayConfig>) {
    this.config = {
      port: config?.port ?? 3000,
      host: config?.host ?? '127.0.0.1',
      sessionTtlMs: config?.sessionTtlMs ?? 60 * 60 * 1000,
      maxSessions: config?.maxSessions ?? 100,
      maxContentEntriesPerSession: config?.maxContentEntriesPerSession ?? 100,
      upstreamOpenAiUrl: config?.upstreamOpenAiUrl,
      upstreamAnthropicUrl: config?.upstreamAnthropicUrl,
      gatewayToken: config?.gatewayToken,
    };

    this.sessionStore = new GatewaySessionStore({
      sessionTtlMs: this.config.sessionTtlMs,
      maxSessions: this.config.maxSessions,
      maxContentEntriesPerSession: this.config.maxContentEntriesPerSession,
    });

    this.server = createServer((req, res) => this.onRequest(req, res));
  }

  public getSessionStore(): GatewaySessionStore {
    return this.sessionStore;
  }

  public get port(): number | undefined {
    return this.listeningPort;
  }

  public async start(): Promise<number> {
    return new Promise((res, rej) => {
      this.server.listen(this.config.port, this.config.host, () => {
        const addr = this.server.address();
        if (addr && typeof addr === 'object') {
          this.listeningPort = addr.port;
          res(addr.port);
        } else {
          rej(new Error('Failed to obtain server address'));
        }
      });

      this.server.on('error', (err) => rej(err));
    });
  }

  public async stop(): Promise<void> {
    return new Promise((res, rej) => {
      if ('closeAllConnections' in this.server) {
        this.server.closeAllConnections();
      }
      this.server.close((err) => {
        if (err) rej(err);
        else res();
      });
    });
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url || '/';
    const method = req.method || 'GET';

    if (method === 'GET' && url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          activeSessions: this.sessionStore.sessionCount,
        }),
      );
      return;
    }

    if (this.config.gatewayToken) {
      const headerToken = req.headers['x-tokendamper-token'];
      let queryToken: string | null = null;
      try {
        const urlObj = new URL(url, `http://${this.config.host}`);
        queryToken = urlObj.searchParams.get('token');
      } catch {
        // Ignore URL parse errors
      }
      
      if (headerToken !== this.config.gatewayToken && queryToken !== this.config.gatewayToken) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Invalid or missing gateway token' }));
        return;
      }
    }

    // Collect bytes, not string fragments.
    //
    // This was `body += chunk`, which invokes `Buffer.prototype.toString('utf8')` on each chunk
    // *independently*. A multi-byte UTF-8 sequence straddling a chunk boundary is therefore
    // decoded as two truncated fragments and becomes U+FFFD on both sides — silently, before
    // the pipeline exists, on the bytes that then get forwarded to the provider. Node reads in
    // ~64 KB chunks, so this fires by chance on any body large enough to be chunked, and
    // deterministically for a body split at the wrong offset. Reproduced with an 89-byte body
    // written in two `req.write()` calls split inside `é`.
    //
    // This is the same defect Phase B fixed in the CLI (DECISIONS §35) — "`rawInput` is a
    // *decoded string*, so the evidence is gone by the time a request exists" — arriving at the
    // socket instead of at `readFileSync`. It is worse here, because the corrupted bytes are
    // sent upstream rather than printed to a terminal. Note the MCP transport is *not* affected:
    // `setEncoding('utf8')` installs a `StringDecoder`, which holds partial sequences across
    // chunk boundaries. Manual concatenation is precisely what bypasses that.
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    const MAX_BODY_BYTES = 10 * 1024 * 1024;

    req.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      // Running total rather than re-measuring the accumulated body on every chunk, which was
      // O(n²) over the length of the request (audit L3).
      receivedBytes += buf.length;
      if (receivedBytes > MAX_BODY_BYTES) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload Too Large' }));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });

    req.on('end', async () => {
      if (req.destroyed) return;

      // Concatenate first, decode exactly once.
      const rawBuffer = Buffer.concat(chunks);
      const body = rawBuffer.toString('utf8');

      const abortController = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) {
          abortController.abort();
        }
      });

      try {
        const result = await handleProxyRequest(method, url, req.headers, body, {
          sessionStore: this.sessionStore,
          upstreamOpenAiUrl: this.config.upstreamOpenAiUrl,
          upstreamAnthropicUrl: this.config.upstreamAnthropicUrl,
          abortSignal: abortController.signal,
          // The bytes as received, so the proxy can tell whether the string above is a faithful
          // representation of them. Concatenating correctly removes the chunk-boundary defect;
          // it does not make a body that was never valid UTF-8 representable. The CLI applies
          // the same round-trip test for the same reason (`main.ts`, `inputSurvivesDecoding`).
          rawBodyBytes: rawBuffer,
        });

        await this.writeProxyResult(res, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Gateway Internal Error';
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      }
    });
  }

  private async writeProxyResult(res: ServerResponse, result: ProxyRequestResult): Promise<void> {
    res.writeHead(result.statusCode, result.headers);

    if (!result.upstreamBody) {
      // Prefer the bytes when the result carries them. This is the locally-returned branch —
      // mock upstream, and the `NODE_ENV === 'test'` no-credentials path — where writing
      // `result.body` would re-encode the lossy decode and undo the pass-through.
      res.end(result.bodyBytes ?? result.body);
      return;
    }

    const reader = result.upstreamBody.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value && !res.write(value)) {
          await once(res, 'drain');
        }
      }
      res.end();
    } catch (error) {
      if (!res.destroyed) {
        res.destroy(error instanceof Error ? error : new Error('Gateway stream forwarding failed'));
      }
    } finally {
      reader.releaseLock();
    }
  }
}
