import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GatewayServer } from '../../src/gateway/server';

/**
 * Byte fidelity on the Gateway — audit C2, invariant 3 on the only path that carries live
 * provider traffic.
 *
 * The server accumulated its body with `body += chunk`, which calls `toString('utf8')` on each
 * chunk *independently*. A multi-byte UTF-8 sequence straddling a chunk boundary is decoded as
 * two truncated fragments and becomes U+FFFD on both sides — before the pipeline exists, on the
 * bytes that are then forwarded upstream. Node reads in ~64 KB chunks, so this fires by chance
 * on any body large enough to be chunked and deterministically for a body split at the wrong
 * offset. Measured against the unfixed server, every case below came back longer than it went
 * out: 94 -> 98, 76 -> 82, 89 -> 95 bytes.
 *
 * This is the defect Phase B closed in the CLI (DECISIONS §35) arriving at the socket instead of
 * at `readFileSync`, and it is worse here because the corrupted bytes reach a provider rather
 * than a terminal. Note the MCP transport is *not* affected: `setEncoding('utf8')` installs a
 * `StringDecoder`, which holds partial sequences across chunk boundaries. Manual concatenation
 * is precisely what bypasses that.
 *
 * The splits below are chosen programmatically to land on a UTF-8 continuation byte, so this
 * tests the actual hazard rather than an arbitrary offset that might be character-aligned.
 */
describe('the Gateway forwards the caller bytes it was given', () => {
  let server: GatewayServer;
  let port: number;
  let priorMock: string | undefined;

  beforeAll(async () => {
    // Mock upstream echoes the outgoing request body back as the response, which is what makes
    // "what would have been forwarded" observable without a real provider.
    priorMock = process.env.TOKENDAMPER_MOCK_UPSTREAM;
    process.env.TOKENDAMPER_MOCK_UPSTREAM = 'true';
    server = new GatewayServer({ port: 0 });
    await server.start();
    const boundPort = server.port;
    expect(boundPort).toBeTypeOf('number');
    port = boundPort as number;
  });

  afterAll(async () => {
    await server.stop();
    if (priorMock === undefined) delete process.env.TOKENDAMPER_MOCK_UPSTREAM;
    else process.env.TOKENDAMPER_MOCK_UPSTREAM = priorMock;
  });

  /** POSTs `body` as two separate TCP writes split at `splitAt`. */
  const postSplit = (body: Buffer, splitAt: number): Promise<{ status: number; body: Buffer }> =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': 'sk-test',
            'content-length': body.length,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        },
      );
      req.on('error', reject);
      req.write(body.subarray(0, splitAt));
      setTimeout(() => req.end(body.subarray(splitAt)), 20);
    });

  /** First offset that is a UTF-8 continuation byte (10xxxxxx), i.e. inside a character. */
  const firstContinuationByte = (buf: Buffer): number => {
    for (let i = 1; i < buf.length; i++) {
      const byte = buf[i];
      if (byte !== undefined && (byte & 0xc0) === 0x80) return i;
    }
    return -1;
  };

  const cases: ReadonlyArray<readonly [string, string]> = [
    ['accented, em-dash, CJK and emoji', 'héllo — ünïcode ✓ 日本語 😀'],
    ['CJK only', 'こんにちは世界'],
    ['box drawing, as in captured terminal output', '┌─┐│ build ok │└─┘'],
  ];

  for (const [label, text] of cases) {
    it(`preserves ${label} across a chunk boundary inside a character`, async () => {
      const body = Buffer.from(
        JSON.stringify({ model: 'm', messages: [{ role: 'user', content: text }] }),
        'utf8',
      );
      const splitAt = firstContinuationByte(body);

      // Invariant 10: if the split were not inside a multi-byte character this test would pass
      // against the unfixed server too, and assert nothing.
      expect(splitAt).toBeGreaterThan(0);
      expect(body[splitAt]! & 0xc0).toBe(0x80);

      const { status, body: got } = await postSplit(body, splitAt);

      expect(status).toBe(200);
      expect(got.equals(body)).toBe(true);
      // Stated separately because it is the symptom that shows up in production: U+FFFD
      // re-encodes to three bytes, so a corrupted body is always *longer* than it was sent.
      expect(got.length).toBe(body.length);
      expect(got.toString('utf8')).not.toContain('�');
    });
  }

  it('forwards a body that is not valid UTF-8 at all, rather than re-encoding it', async () => {
    // Latin-1 bytes inside a JSON string: 0xE9 is `é` in Latin-1 and an illegal lone lead byte
    // in UTF-8. Concatenating chunks correctly does not make this representable — the decode is
    // still lossy — so the round-trip check has to catch it and pass the original through.
    const body = Buffer.concat([
      Buffer.from('{"model":"m","messages":[{"role":"user","content":"caf', 'utf8'),
      Buffer.from([0xe9]),
      Buffer.from('"}]}', 'utf8'),
    ]);
    expect(Buffer.from(body.toString('utf8'), 'utf8').equals(body)).toBe(false);

    const { status, body: got } = await postSplit(body, 20);

    expect(status).toBe(200);
    expect(got.equals(body)).toBe(true);
  });
});
