import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { GatewaySessionStore } from '../../src/gateway/session-store';
import { McpStdioServer } from '../../src/adapters/mcp/server';
import { TOKENDAMPER_VERSION } from '../../src/version';

/**
 * The LOW band of `oxaudit.md` — the ones that turned out to be behaviour rather than tidiness.
 *
 * `max_audit.md`'s own LOW table went unscheduled and was found open weeks later (DECISIONS §55),
 * so these get a test file rather than a mention. The ones deliberately *not* fixed are recorded at
 * their sites and in `docs/audit-remediation-status.md`, not here — a test cannot pin an absence.
 */
describe('OX low findings', () => {
  describe('L6 — the seen-hash cap is configurable', () => {
    it('evicts at a custom cap instead of a hardcoded 1000', () => {
      // It was a bare local inside `capSeenBlockHashes` while every neighbouring bound was
      // settable, so the one limit that grows with conversation length was the one nobody could
      // tune. 1000 hashes is a lot of turns to reach in a test; a small cap is the same code path.
      const store = new GatewaySessionStore({
        sessionTtlMs: 60_000,
        maxSessions: 10,
        maxSeenBlockHashesPerSession: 3,
      });

      const session = store.getOrCreateSession('sess-cap');
      for (let i = 0; i < 10; i += 1) {
        session.seenBlockHashes.add(`hash-${i}`);
        store.recordTurn('sess-cap', { rawTokens: 0, optimizedTokens: 0, tokensSaved: 0, dedupRatio: 0 }, []);
      }

      expect(session.seenBlockHashes.size).toBeLessThanOrEqual(3);
      // Insertion-ordered eviction: the newest survive, the oldest go.
      expect(session.seenBlockHashes.has('hash-9')).toBe(true);
      expect(session.seenBlockHashes.has('hash-0')).toBe(false);
    });

    it('still defaults to 1000 when nothing is configured', () => {
      const store = new GatewaySessionStore({ sessionTtlMs: 60_000, maxSessions: 10 });
      const session = store.getOrCreateSession('sess-default');
      for (let i = 0; i < 50; i += 1) session.seenBlockHashes.add(`hash-${i}`);
      store.recordTurn('sess-default', { rawTokens: 0, optimizedTokens: 0, tokensSaved: 0, dedupRatio: 0 }, []);

      expect(session.seenBlockHashes.size).toBe(50);
    });
  });

  describe('L7 — an oversized line does not discard the requests before it', () => {
    it('answers complete requests that arrived in the same chunk as an overlong one', async () => {
      // The limit check ran before `processBuffer` and then cleared the whole buffer, so complete,
      // well-formed, already-received requests were thrown away alongside the oversized partial.
      // Nothing about them was too long.
      const input = new PassThrough();
      const output = new PassThrough();
      const log = new PassThrough();
      log.resume();

      const responses: string[] = [];
      output.setEncoding('utf8');
      output.on('data', (c: string) => responses.push(c));

      // A stub handler: this test is about which requests reach the handler at all, not about
      // what any tool returns.
      const server = new McpStdioServer({
        input,
        output,
        log,
        requestHandler: async () => ({ ok: true }),
      });
      server.start();

      const complete = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`;
      const oversized = 'x'.repeat(11 * 1024 * 1024);
      input.write(complete + oversized);

      await new Promise((r) => setTimeout(r, 50));
      server.stop();

      const joined = responses.join('');
      // The complete request was answered...
      expect(joined).toContain('"id":1');
      // ...and the oversized remainder was still rejected.
      expect(joined).toContain('Buffer limit exceeded');
    }, 30_000);
  });

  describe('L12 — one version, two files', () => {
    it('keeps package.json and src/version.ts in agreement', () => {
      // Not a restructure: `src/version.ts` stays the single source every adapter derives from,
      // per the release procedure. This closes the *drift class* — the two are hand-synced, and a
      // release that updates one and not the other ships a binary that misreports itself.
      const pkg = JSON.parse(
        readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
      ) as { version: string };

      expect(pkg.version).toBe(TOKENDAMPER_VERSION);
    });
  });
});
