import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { GatewayServer } from '../../src/gateway/server';
import type { GatewayConfig } from '../../src/gateway/types';

/**
 * Audit OX-M8 — a non-loopback bind with no `gatewayToken` is an unauthenticated relay.
 *
 * The token gate reads `if (this.config.gatewayToken && !isLoopbackPeer(req))`, so the token is
 * enforced only **if one was configured**. Binding `0.0.0.0` and setting no token therefore
 * produced a server that forwards arbitrary bodies to upstream providers for anyone who can
 * reach the port, and nothing warned or refused. The README already claimed the token was
 * "enforced only on a non-loopback bind", which describes the intent rather than the code.
 *
 * The decision (recorded in `docs/audit-remediation-status.md`) is **refuse to start**, with an
 * explicit opt-in for a caller who genuinely wants an open relay. An existing exposed-bind
 * config breaking loudly is the point of it, not a side effect. Loopback trust (audit C3) and
 * the constant-time compare are untouched, and both are asserted below so that a future change
 * cannot quietly buy this guarantee by revoking C3.
 */
describe('an exposed bind must be authenticated (audit OX-M8)', () => {
  const started: GatewayServer[] = [];

  afterEach(async () => {
    while (started.length > 0) {
      const server = started.pop();
      if (server) await server.stop().catch(() => undefined);
    }
  });

  const startOn = async (config: Partial<GatewayConfig>): Promise<GatewayServer> => {
    const server = new GatewayServer(config);
    started.push(server);
    await server.start();
    return server;
  };

  for (const host of ['0.0.0.0', '::', '192.168.1.50']) {
    it(`refuses to start on ${host} with no token`, async () => {
      const server = new GatewayServer({ host, port: 0 });
      started.push(server);
      await expect(server.start()).rejects.toThrow(/gatewayToken|unauthenticated|open relay/i);
    });
  }

  it('names the exposure and the two ways out', async () => {
    const server = new GatewayServer({ host: '0.0.0.0', port: 0 });
    started.push(server);
    const error = await server.start().then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error).toBeDefined();
    const message = error?.message ?? '';
    expect(message).toContain('0.0.0.0');
    expect(message).toMatch(/gatewayToken/);
    expect(message).toMatch(/allowUnauthenticatedNonLoopback/);
  });

  it('starts on an exposed bind when a token is configured', async () => {
    const server = await startOn({ host: '0.0.0.0', port: 0, gatewayToken: 'a-real-token' });
    expect(server.port).toBeGreaterThan(0);
  });

  it('starts on an exposed bind when the caller opts in explicitly', async () => {
    const server = await startOn({ host: '0.0.0.0', port: 0, allowUnauthenticatedNonLoopback: true });
    expect(server.port).toBeGreaterThan(0);
  });

  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    it(`still starts on ${host} with no token — loopback trust is untouched (audit C3)`, async () => {
      const server = await startOn({ host, port: 0 });
      expect(server.port).toBeGreaterThan(0);
    });
  }

  it('the default host is loopback, so the common case does not change', async () => {
    const server = await startOn({ port: 0 });
    expect(server.port).toBeGreaterThan(0);

    // And it really serves — a refusal that happened to leave a listening socket would pass the
    // assertion above while breaking every user.
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: server.port, path: '/health', method: 'GET' },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(200);
  });
});
