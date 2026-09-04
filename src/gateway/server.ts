import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { handleProxyRequest } from './proxy';
import { GatewaySessionStore } from './session-store';
import type { GatewayConfig, ProxyRequestResult } from './types';

/**
 * Whether the peer on the other end of this socket is the local machine.
 *
 * `::ffff:127.0.0.1` is the IPv4-mapped IPv6 form Node reports on a dual-stack listener, and
 * omitting it would make the carve-out silently fail on exactly the platforms that use it.
 * Read from the socket, never from a header: `X-Forwarded-For` and friends are attacker-supplied.
 */
function isLoopbackPeer(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress;
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.');
}

/**
 * Whether a *bind address* names only the local machine — the configuration-time counterpart of
 * `isLoopbackPeer`, which asks the same question of a live socket.
 *
 * `0.0.0.0` and `::` are deliberately **not** loopback. They include the loopback interface,
 * which is what makes them easy to mistake for it, but they also include every other interface
 * the host has — which is the exposure OX-M8 is about.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^[|]$/g, '');
  if (h === '' || h === '0.0.0.0' || h === '::' || h === '*') return false;
  return h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1' || /^127./.test(h);
}

/**
 * The hostname out of a `Host` or `Origin` authority, lowercased, with the port and any
 * IPv6 brackets removed. `undefined` when there is nothing parseable.
 */
function authorityHostname(authority: string): string | undefined {
  const trimmed = authority.trim().toLowerCase();
  if (trimmed === '') return undefined;
  const bracketed = /^\[([^\]]+)\]/.exec(trimmed);
  if (bracketed) return bracketed[1];
  const withoutPort = trimmed.includes(':') ? trimmed.slice(0, trimmed.lastIndexOf(':')) : trimmed;
  return withoutPort === '' ? undefined : withoutPort;
}

/** Whether a hostname names this machine by one of the names a local client actually uses. */
function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '::1' || hostname === '::ffff:127.0.0.1' || /^127\./.test(hostname);
}

/** Constant-time compare that tolerates absent/duplicated headers (audit L2). */
function timingSafeEqualString(provided: string | string[] | undefined, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // `timingSafeEqual` throws on a length mismatch, which would itself be a length oracle; compare
  // lengths first and keep the byte comparison constant-time for equal-length candidates.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export class GatewayServer {
  private readonly server: Server;
  private readonly sessionStore: GatewaySessionStore;

  /**
   * A per-connection identity for callers that name no session (security review F-01).
   *
   * `getSessionIdFromHeaders` used to fall back to the literal `'default-session'`, so **every**
   * client that set no session header shared one session object by construction — which is the
   * common case, because the third-party tools `exec` exists to wrap generally do not set one.
   * Two unrelated processes then wrote into each other's dedup state, and a third could flush it:
   * one request carrying 130 blocks drives `contentByHash` to its 100-entry cap, evicting
   * everything the first two had stored.
   *
   * Keyed on the socket, so HTTP keep-alive keeps one client's turns together while separate
   * connections stay apart. The socket is the only thing here a caller cannot choose — every peer
   * is `127.0.0.1`, so the address discriminates nothing, and the port is per-connection anyway.
   *
   * **This narrows the default, and does not authenticate anything.** A client that sets an
   * explicit `x-session-id` can still bind to any id it names, including another client's; that
   * is unchanged, and is the documented `exec` trust boundary — the peer is already trusted
   * enough to proxy provider traffic through this process. What it removes is the collision
   * nobody opted into.
   */
  private readonly connectionSessionIds = new WeakMap<object, string>();
  private readonly config: GatewayConfig;
  private listeningPort?: number;

  constructor(config?: Partial<GatewayConfig>) {
    this.config = {
      port: config?.port ?? 3000,
      host: config?.host ?? '127.0.0.1',
      sessionTtlMs: config?.sessionTtlMs ?? 60 * 60 * 1000,
      maxSessions: config?.maxSessions ?? 100,
      maxContentEntriesPerSession: config?.maxContentEntriesPerSession ?? 100,
      maxSeenBlockHashesPerSession: config?.maxSeenBlockHashesPerSession,
      upstreamOpenAiUrl: config?.upstreamOpenAiUrl,
      upstreamAnthropicUrl: config?.upstreamAnthropicUrl,
      gatewayToken: config?.gatewayToken,
      allowUnauthenticatedNonLoopback: config?.allowUnauthenticatedNonLoopback,
      upstreamTtfbTimeoutMs: config?.upstreamTtfbTimeoutMs,
      mockUpstream: config?.mockUpstream,
      allowMissingUpstreamCredentials: config?.allowMissingUpstreamCredentials,
    };

    this.sessionStore = new GatewaySessionStore({
      sessionTtlMs: this.config.sessionTtlMs,
      maxSessions: this.config.maxSessions,
      maxContentEntriesPerSession: this.config.maxContentEntriesPerSession,
      ...(this.config.maxSeenBlockHashesPerSession !== undefined
        ? { maxSeenBlockHashesPerSession: this.config.maxSeenBlockHashesPerSession }
        : {}),
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
    // Refuse an unauthenticated exposed bind — audit OX-M8.
    //
    // The token gate below reads `if (this.config.gatewayToken && !isLoopbackPeer(req))`, so a
    // token is enforced only when one exists. Binding `0.0.0.0` and configuring none therefore
    // produced an open relay: anything that could reach the port had its bodies forwarded to
    // upstream providers, and nothing said so. README:154 already described the intended rule
    // ("enforced only on a non-loopback bind"); the code implemented "enforced only if provided".
    //
    // Refusing rather than warning, because the failure mode this protects against is a server
    // nobody is watching. A warning on stderr is read by the person who starts it in a terminal
    // and by nobody who starts it from a unit file. An existing exposed-bind configuration
    // breaking loudly is the intended cost of the decision, not an accident of it.
    //
    // Checked here and not in the constructor so that constructing a server is still free of
    // side effects — the exposure begins at `listen`, and that is where it is refused.
    if (!isLoopbackHost(this.config.host) && !this.config.gatewayToken && !this.config.allowUnauthenticatedNonLoopback) {
      throw new Error(
        `Refusing to start: host "${this.config.host}" is not loopback and no gatewayToken is set, ` +
          'which would serve an unauthenticated relay forwarding request bodies to upstream ' +
          'providers. Set gatewayToken (TOKENDAMPER_GATEWAY_TOKEN), bind a loopback host such as ' +
          '127.0.0.1, or set allowUnauthenticatedNonLoopback if an open relay is genuinely what ' +
          'you want.',
      );
    }

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

  /** Mints, and then reuses, one identity per connection. See `connectionSessionIds`. */
  private defaultSessionIdFor(req: IncomingMessage): string {
    const socket: object | undefined = req.socket;
    if (!socket) return `conn-${randomBytes(8).toString('hex')}`;
    let id = this.connectionSessionIds.get(socket);
    if (id === undefined) {
      id = `conn-${randomBytes(8).toString('hex')}`;
      this.connectionSessionIds.set(socket, id);
    }
    return id;
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

  /**
   * Browser-origin defence — audit OX-M9. Returns a refusal message, or `undefined` to proceed.
   *
   * The threat is a **simple** cross-origin POST (`text/plain`), which needs no preflight, so an
   * OPTIONS handler was never the control that mattered: measured, this server already answers
   * OPTIONS with `405` and no `Access-Control-*` headers, which is exactly the restrictive
   * policy the audit asked for. What was missing is a check on requests that never preflight.
   *
   * `Origin` is checked on every bind: it is present only when a browser sent the request, so
   * refusing a foreign one costs non-browser clients nothing. That is the half of the decision
   * that keeps the local client contract intact.
   *
   * `Host` is different, and the decision as recorded overstated it — every HTTP/1.1 client must
   * send `Host`, so this cannot be justified by the header being absent. It is justified by what
   * is accepted: the loopback names a local client actually uses, plus the configured bind. And
   * it is enforced **only on a loopback bind**, because that is where DNS rebinding is the
   * threat — an attacker's name resolving to 127.0.0.1. On an exposed bind the hostname is
   * legitimately varied (a LAN IP, a service name), and the token OX-M8 now requires is the
   * real control there.
   */
  private refuseByOriginPolicy(req: IncomingMessage): string | undefined {
    const port = this.listeningPort ?? this.config.port;

    const originHeader = req.headers.origin;
    if (typeof originHeader === 'string' && originHeader !== '' && originHeader !== 'null') {
      let sameOrigin = false;
      try {
        const origin = new URL(originHeader);
        const hostname = origin.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        const originPort = origin.port === '' ? (origin.protocol === 'https:' ? '443' : '80') : origin.port;
        sameOrigin =
          originPort === String(port) &&
          (isLocalHostname(hostname) || hostname === this.config.host.trim().toLowerCase());
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin) {
        return (
          `Forbidden: cross-origin request rejected. Origin "${originHeader}" is not this ` +
          `gateway's own origin, and a browser page is not a supported client.`
        );
      }
    }

    if (isLoopbackHost(this.config.host)) {
      const hostHeader = req.headers.host;
      if (typeof hostHeader === 'string' && hostHeader !== '') {
        const hostname = authorityHostname(hostHeader);
        const configured = this.config.host.trim().toLowerCase().replace(/^\[|\]$/g, '');
        if (hostname !== undefined && !isLocalHostname(hostname) && hostname !== configured) {
          return (
            `Forbidden: Host header "${hostHeader}" does not name this gateway's bind address. ` +
            'This is the DNS-rebinding shape; use 127.0.0.1 or localhost.'
          );
        }
      }
    }

    return undefined;
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url || '/';
    const method = req.method || 'GET';

    // Before anything else, including `/health` — audit OX-M9. A policy the health endpoint sat
    // in front of would be a policy with a documented way around it.
    const refusal = this.refuseByOriginPolicy(req);
    if (refusal !== undefined) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: refusal }));
      return;
    }

    // `/health` is served without authorization, and no longer reports `sessionCount` — audit
    // OX-L13, folded into OX-M9 because it is the same question and answering it twice is how
    // two answers drift.
    //
    // Liveness is the whole job: a probe needs to know the process is up, and `activeSessions`
    // told an unauthenticated caller how much conversation traffic flows through the machine.
    // On a loopback bind that is a small leak to a peer already trusted to proxy; the reason to
    // drop it anyway is that `/health` is the one endpoint deployments expose deliberately, so
    // it is the one whose payload should carry nothing it does not need.
    if (method === 'GET' && url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Authorization, with the loopback case carved out — audit C3.
    //
    // The token gate made `tokendamper exec` impossible **by construction**. `exec` generates a
    // token and injects it as `TOKENDAMPER_GATEWAY_TOKEN`, a name no third-party client has ever
    // heard of; the child is `aider`, `claude`, `codex` or `curl`, and it sends `authorization`
    // or `x-api-key` and nothing else. Nothing in `src/` read that variable. Reproduced by
    // spawning a real child through `runExecCommand`: every request came back
    // `401 Unauthorized: Invalid or missing gateway token`.
    //
    // The server binds to `127.0.0.1` by default, so a loopback peer is already the only peer
    // that could connect at all, and the token was protecting one local process from another on
    // the same machine. That is a real but narrow boundary, and it was being paid for with a
    // mode that could not be used. Loopback connections are therefore trusted, and the token is
    // still enforced for any non-loopback bind — where the boundary is not narrow at all.
    //
    // The `?token=` query parameter is gone (audit L2): it put a credential into access logs,
    // shell history and any error message that echoed the URL, and with loopback trust it buys
    // nothing. The header comparison is now constant-time.
    if (this.config.gatewayToken && !isLoopbackPeer(req)) {
      const headerToken = req.headers['x-tokendamper-token'];
      if (!timingSafeEqualString(headerToken, this.config.gatewayToken)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error:
              'Unauthorized: Invalid or missing gateway token. Send it as the x-tokendamper-token header. (Loopback connections do not require a token.)',
          }),
        );
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
          ...(this.config.upstreamTtfbTimeoutMs !== undefined
            ? { upstreamTtfbTimeoutMs: this.config.upstreamTtfbTimeoutMs }
            : {}),
          // The bytes as received, so the proxy can tell whether the string above is a faithful
          // representation of them. Concatenating correctly removes the chunk-boundary defect;
          // it does not make a body that was never valid UTF-8 representable. The CLI applies
          // the same round-trip test for the same reason (`main.ts`, `inputSurvivesDecoding`).
          rawBodyBytes: rawBuffer,
          // Used only when the caller names no session of its own (F-01).
          defaultSessionId: this.defaultSessionIdFor(req),
          // Explicitly plumbed rather than read from `process.env` down in the request path.
          // Both default to absent, so a server nobody deliberately configured this way calls
          // real upstreams and enforces the credential check (audit M8).
          ...(this.config.mockUpstream !== undefined ? { mockUpstream: this.config.mockUpstream } : {}),
          ...(this.config.allowMissingUpstreamCredentials !== undefined
            ? { allowMissingUpstreamCredentials: this.config.allowMissingUpstreamCredentials }
            : {}),
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
      // `mockUpstream`, and the `allowMissingUpstreamCredentials` no-credentials path — where
      // writing `result.body` would re-encode the lossy decode and undo the pass-through.
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
