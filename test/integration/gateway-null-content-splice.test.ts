import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GatewayServer } from '../../src/gateway/server';

/**
 * One `content: null` message must not zero the whole request's saving — audit OX-H4.
 *
 * Egress splices replacements into the caller's raw bytes rather than re-serializing the payload
 * (invariant 9, DECISIONS §54). It locates each message by searching the raw body for
 * `JSON.stringify(text)`, where `text` comes from `flattenMessageContent` — which sends every
 * non-string through `JSON.stringify`. For `content: null` that yields the four-character string
 * `null`, and the search string becomes `"null"` **with quotes**, which does not occur where the
 * body holds a bare `null`.
 *
 * `spliceIntoRawBody` returns `undefined` on the *first* miss and `forwardableBody` maps that back
 * to the untouched `rawBody`, so the failure is **all-or-nothing**: one unmatchable message
 * discards the replacements for every other message in the payload.
 *
 * `content: null` is not an edge case. It is the standard OpenAI shape for an assistant turn that
 * calls a tool, so essentially every agentic OpenAI conversation carries one. The direction is
 * safe — bytes are forwarded unchanged, and `wireTokenMetrics` measures what actually left, so the
 * reported numbers stay honest — but the product's headline transform silently stops happening on
 * its most common payload shape.
 */
describe('gateway splice with non-string message content', () => {
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
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer sk-test',
            'x-session-id': sessionId,
            'content-length': body.length,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ sent: body.length, forwarded: Buffer.concat(chunks).length }));
        },
      );
      req.on('error', reject);
      req.end(body);
    });

  beforeAll(async () => {
    // The mock upstream echoes the outgoing body, which is what makes "bytes actually forwarded"
    // observable without a provider.
    server = new GatewayServer({ port: 0, mockUpstream: true });
    await server.start();
    const bound = server.port;
    expect(bound).toBeTypeOf('number');
    port = bound as number;
  });

  afterAll(async () => {
    await server.stop();
  });

  /** Same request, but returning the echoed body so its structure can be inspected. */
  const postBody = (sessionId: string, payload: unknown) =>
    new Promise<string>((resolve, reject) => {
      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer sk-test',
            'x-session-id': sessionId,
            'content-length': body.length,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        },
      );
      req.on('error', reject);
      req.end(body);
    });

  /** The within-payload repetition the Gateway does save on, with a turn 1 to seed the store. */
  const repeatedPayload = (extra: ReadonlyArray<unknown>) => ({
    model: 'gpt-x',
    messages: [
      { role: 'user', content: BLOCK },
      { role: 'assistant', content: 'ok' },
      ...extra,
      { role: 'user', content: BLOCK },
      { role: 'assistant', content: 'still ok' },
      { role: 'user', content: BLOCK },
    ],
  });

  it('saves bytes on a repeated block when every message content is a string — the control', async () => {
    // Without this the assertion below would pass on a payload that never had a saving to lose,
    // which is the shape of a green test that measured nothing.
    const session = `sess-openai-control-${Date.now()}`;
    await post(session, { model: 'gpt-x', messages: [{ role: 'user', content: BLOCK }] });

    const turn2 = await post(session, repeatedPayload([]));

    expect(turn2.forwarded).toBeLessThan(turn2.sent);
  });

  it('still saves those bytes when an assistant tool-call turn carries content: null', async () => {
    const session = `sess-openai-null-${Date.now()}`;
    await post(session, { model: 'gpt-x', messages: [{ role: 'user', content: BLOCK }] });

    // The standard OpenAI assistant tool-call turn. Nothing about it is elidable, and nothing
    // about it should prevent the *other* messages from being elided.
    const turn2 = await post(
      session,
      repeatedPayload([
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'file contents here' },
      ]),
    );

    expect(turn2.forwarded).toBeLessThan(turn2.sent);
  });

  it('forwards a body that still parses, with every untouched field intact', async () => {
    // The property that matters more than the saving. A splice writes over the caller's bytes, so
    // the failure mode this guards is not "saved less" but "sent something else" — the direction
    // invariant 3 forbids. Asserted on the payload shape that previously declined entirely, so it
    // is now exercising the span path rather than the old value search.
    const session = `sess-openai-shape-${Date.now()}`;
    await post(session, { model: 'gpt-x', messages: [{ role: 'user', content: BLOCK }] });

    const payload = repeatedPayload([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
        ],
      },
    ]);
    const echoed = await postBody(session, payload);
    const forwarded = JSON.parse(echoed) as {
      model: string;
      messages: ReadonlyArray<Record<string, unknown>>;
    };
    const sent = payload.messages as ReadonlyArray<Record<string, unknown>>;

    expect(forwarded.model).toBe('gpt-x');
    expect(forwarded.messages.length).toBe(sent.length);

    // The tool-call turn is not elidable and must come back exactly as sent, `null` included.
    const toolTurn = forwarded.messages[2] as Record<string, unknown>;
    expect(toolTurn.role).toBe('assistant');
    expect(toolTurn.content).toBeNull();
    expect(toolTurn.tool_calls).toEqual(sent[2]?.tool_calls);

    // Roles are structural, never touched by elision.
    expect(forwarded.messages.map((m) => m.role)).toEqual(sent.map((m) => m.role));
  });

  it('still saves those bytes when a message carries array content', async () => {
    // The same defect through the other common non-string shape: OpenAI multimodal content parts.
    // `JSON.stringify` of the parsed array is not guaranteed to be the caller's own bytes, so the
    // search can miss for formatting reasons alone.
    const session = `sess-openai-array-${Date.now()}`;
    await post(session, { model: 'gpt-x', messages: [{ role: 'user', content: BLOCK }] });

    const turn2 = await post(
      session,
      repeatedPayload([{ role: 'user', content: [{ type: 'text', text: 'and this part' }] }]),
    );

    expect(turn2.forwarded).toBeLessThan(turn2.sent);
  });
});
