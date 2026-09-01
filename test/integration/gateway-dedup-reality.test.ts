import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GatewayServer } from '../../src/gateway/server';

/**
 * What the Gateway actually saves — audit H1, pinned as a measurement rather than a claim.
 *
 * The README advertised "Cross-turn Session Deduplication". Measured over real sockets on
 * realistic two-turn conversations, the saving is **0 bytes** and every turn falls back.
 *
 * This is a design consequence, not a bug, and the distinction is why this file pins it instead
 * of fixing it. `cleanup:session-dedup` marks an elision `recoverable: true` **only when an
 * intact copy survives elsewhere in the same outbound payload** (DECISIONS §16). Cross-turn
 * deduplication of a *sole* copy is `recoverable: false`, is scored in full by `DriftTracker`,
 * and exceeds the gate. Phase A established why that is correct: the consumer is a stateless
 * provider API with no rehydration mechanism, so an elided sole copy is **deleted, not
 * referenced**, and the model receives a marker it cannot resolve.
 *
 * The consequence is that the Gateway has no cross-turn transform today. It is a validated,
 * byte-faithful pass-through that deduplicates within a payload. That is what the docs now say.
 *
 * **If a future change makes these numbers move, that is the signal to read.** A non-zero
 * cross-turn saving means either provider-side resolvability was implemented (in which case
 * update this test deliberately) or the drift gate was relaxed and the Gateway is now deleting
 * content the model cannot recover (in which case do not).
 */
describe('what the Gateway saves, measured', () => {
  let server: GatewayServer;
  let port: number;
  const BLOCK = Array.from(
    { length: 30 },
    (_, i) => `export function helper${i}(input) {\n  const scaled = input * ${i};\n  return scaled + ${i};\n}`,
  ).join('\n\n');

  const post = (sessionId: string, payload: unknown) =>
    new Promise<{ sent: number; forwarded: number }>((resolve, reject) => {
      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': 'sk-test',
            'x-session-id': sessionId,
            'content-length': body.length,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ sent: body.length, forwarded: Buffer.concat(chunks).length }),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });

  beforeAll(async () => {
    // Mock upstream echoes the outgoing body back, which is what makes "bytes actually
    // forwarded" observable without a provider. Set on the server, not via
    // `TOKENDAMPER_MOCK_UPSTREAM` in the environment — that read is gone (audit M8).
    server = new GatewayServer({ port: 0, mockUpstream: true });
    await server.start();
    const bound = server.port;
    expect(bound).toBeTypeOf('number');
    port = bound as number;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('saves nothing across turns when the repeated block appears once per payload', async () => {
    // The realistic shape: a conversation resends its history, so each block appears exactly
    // once and was seen in a previous turn. This is the case "cross-turn deduplication" names.
    const session = `sess-cross-${Date.now()}`;
    await post(session, { model: 'm', messages: [{ role: 'user', content: BLOCK }] });

    const turn2 = await post(session, {
      model: 'm',
      messages: [
        { role: 'user', content: BLOCK },
        { role: 'assistant', content: 'Understood.' },
        { role: 'user', content: 'Now add error handling to helper3.' },
      ],
    });

    expect(turn2.forwarded).toBe(turn2.sent);
    expect(turn2.sent - turn2.forwarded).toBe(0);
  });

  it('does save when the same block appears more than once inside one payload', async () => {
    // The case that works, and the reason the mode is not simply inert: an intact copy survives
    // in the same payload, so the elision is `recoverable: true` and drift exempts it.
    const session = `sess-within-${Date.now()}`;
    await post(session, { model: 'm', messages: [{ role: 'user', content: BLOCK }] });

    const turn2 = await post(session, {
      model: 'm',
      messages: [
        { role: 'user', content: BLOCK },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: BLOCK },
        { role: 'assistant', content: 'still ok' },
        { role: 'user', content: BLOCK },
      ],
    });

    expect(turn2.forwarded).toBeLessThan(turn2.sent);
  });

  it('saves on within-payload repetition on the very first turn, with no history at all', async () => {
    // Audit OX-M1. Within-payload dedup used to be a *side condition* of cross-turn matching: the
    // whole branch was gated on `previousBlockHashes.has(hash)`, and the stage returned early
    // unless that set was non-empty. So on turn 1 three identical blocks all survived, and the
    // README's "same block repeated within one payload → saves" was true only from turn 2.
    //
    // The gate was doing no safety work here. `recoverable: true` requires an intact copy in the
    // *same outbound payload*, which rule 3 guarantees by preserving the first occurrence — and
    // that claim is verifiable without any history. DECISIONS §16/§41 are about a **sole** copy
    // elided across turns, which is a different case and is still refused above.
    const session = `sess-first-turn-${Date.now()}`;

    const turn1 = await post(session, {
      model: 'm',
      messages: [
        { role: 'user', content: BLOCK },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: BLOCK },
        { role: 'assistant', content: 'still ok' },
        { role: 'user', content: BLOCK },
      ],
    });

    expect(turn1.forwarded).toBeLessThan(turn1.sent);
  });

  it('still saves nothing on a first turn whose blocks are all distinct', async () => {
    // The control that keeps the case above honest: turn 1 is not simply "always saves now".
    // Without repetition there is no intact copy to reference, so nothing is recoverable to elide
    // and the payload goes out whole.
    const session = `sess-first-distinct-${Date.now()}`;

    const turn1 = await post(session, {
      model: 'm',
      messages: [
        { role: 'user', content: BLOCK },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: `${BLOCK}\n\nexport const tail = 1;` },
      ],
    });

    expect(turn1.forwarded).toBe(turn1.sent);
  });
});
