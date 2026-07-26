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

    let body = '';
    const MAX_BODY_BYTES = 10 * 1024 * 1024;

    req.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload Too Large' }));
        req.destroy();
      }
    });

    req.on('end', async () => {
      if (req.destroyed) return;

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
      res.end(result.body);
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
