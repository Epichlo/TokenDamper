import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { handleProxyRequest } from './proxy';
import { GatewaySessionStore } from './session-store';
import type { GatewayConfig } from './types';

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
      upstreamOpenAiUrl: config?.upstreamOpenAiUrl,
      upstreamAnthropicUrl: config?.upstreamAnthropicUrl,
    };

    this.sessionStore = new GatewaySessionStore({
      sessionTtlMs: this.config.sessionTtlMs,
      maxSessions: this.config.maxSessions,
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

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', async () => {
      try {
        const result = await handleProxyRequest(method, url, req.headers, body, {
          sessionStore: this.sessionStore,
          upstreamOpenAiUrl: this.config.upstreamOpenAiUrl,
          upstreamAnthropicUrl: this.config.upstreamAnthropicUrl,
        });

        res.writeHead(result.statusCode, result.headers);
        res.end(result.body);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Gateway Internal Error';
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      }
    });
  }
}
