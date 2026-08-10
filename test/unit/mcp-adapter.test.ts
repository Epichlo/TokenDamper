import { PassThrough } from 'node:stream';
import { describe, expect, it, beforeEach } from 'vitest';
import { createMcpServer, MCP_PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION, createTraceStore, getStoredTrace, clearTraceStore } from '../../src/adapters/mcp';
import { GatewaySessionStore } from '../../src/gateway/session-store';
import { TokenHasher } from '../../src/core/hashing/token-hasher';
import { runCli } from '../../src/cli/main';

describe('MCP Adapter', () => {
  let input: PassThrough;
  let output: PassThrough;
  let log: PassThrough;
  let sessionStore: GatewaySessionStore;
  let tokenHasher: TokenHasher;

  beforeEach(() => {
    input = new PassThrough();
    output = new PassThrough();
    log = new PassThrough();
    sessionStore = new GatewaySessionStore();
    tokenHasher = new TokenHasher();
  });

  function sendRpcRequest(serverInput: PassThrough, request: Record<string, unknown>): void {
    serverInput.write(JSON.stringify(request) + '\n');
  }

  function readRpcResponse(serverOutput: PassThrough): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let data = '';
      const onData = (chunk: Buffer | string) => {
        data += chunk.toString();
        if (data.includes('\n')) {
          serverOutput.removeListener('data', onData);
          const line = data.split('\n')[0]?.trim();
          if (line) {
            try {
              resolve(JSON.parse(line));
            } catch (err) {
              reject(err);
            }
          }
        }
      };
      serverOutput.on('data', onData);
    });
  }

  it('handles JSON-RPC initialization handshake', async () => {
    const server = createMcpServer({ input, output, log, sessionStore, tokenHasher });
    server.start();

    const responsePromise = readRpcResponse(output);
    sendRpcRequest(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });

    const res = await responsePromise;
    expect(res.jsonrpc).toBe('2.0');
    expect(res.id).toBe(1);
    expect(res.result).toEqual({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
    });

    server.stop();
  });

  it('lists registered MCP tools via tools/list', async () => {
    const server = createMcpServer({ input, output, log, sessionStore, tokenHasher });
    server.start();

    const responsePromise = readRpcResponse(output);
    sendRpcRequest(input, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    const res = (await responsePromise) as { result: { tools: Array<{ name: string }> } };
    expect(res.result.tools.length).toBe(4);
    const toolNames = res.result.tools.map((t) => t.name);
    expect(toolNames).toContain('optimize_context');
    expect(toolNames).toContain('rehydrate_context');
    expect(toolNames).toContain('get_optimization_trace');
    expect(toolNames).toContain('get_session_metrics');

    server.stop();
  });

  it('executes optimize_context tool call', async () => {
    const server = createMcpServer({ input, output, log, sessionStore, tokenHasher });
    server.start();

    const responsePromise = readRpcResponse(output);
    sendRpcRequest(input, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'optimize_context',
        arguments: {
          rawInput: 'System prompt: hello world\n' + 'Line of code\n'.repeat(50),
          maxInputTokens: 50,
          riskTolerance: 'low',
        },
      },
    });

    const res = (await responsePromise) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    expect(res.result.content[0]?.type).toBe('text');
    const parsedText = JSON.parse(res.result.content[0]!.text);
    expect(parsedText.requestId).toBeDefined();
    expect(parsedText.emittedOutput).toBeDefined();
    expect(typeof parsedText.tokenBefore).toBe('number');
    expect(typeof parsedText.tokenAfter).toBe('number');

    server.stop();
  });

  it('executes rehydrate_context tool call', async () => {
    const placeholder = tokenHasher.createBlockPlaceholder('secret block content');
    const server = createMcpServer({ input, output, log, sessionStore, tokenHasher });
    server.start();

    const responsePromise = readRpcResponse(output);
    sendRpcRequest(input, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'rehydrate_context',
        arguments: {
          text: `Here is the placeholder: ${placeholder}`,
        },
      },
    });

    const res = (await responsePromise) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    expect(res.result.content[0]!.text).toBe('Here is the placeholder: secret block content');

    server.stop();
  });

  it('retrieves session metrics via get_session_metrics', async () => {
    sessionStore.recordTurn(
      'session-abc',
      {
        rawTokens: 500,
        optimizedTokens: 200,
        tokensSaved: 300,
        dedupRatio: 0.6,
        fallbackUsed: false,
      },
      ['hash-1'],
    );

    const server = createMcpServer({ input, output, log, sessionStore, tokenHasher });
    server.start();

    const responsePromise = readRpcResponse(output);
    sendRpcRequest(input, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'get_session_metrics',
        arguments: {
          sessionId: 'session-abc',
        },
      },
    });

    const res = (await responsePromise) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    const metrics = JSON.parse(res.result.content[0]!.text);
    expect(metrics.sessionId).toBe('session-abc');
    expect(metrics.turnCount).toBe(1);
    expect(metrics.cumulativeTokensSaved).toBe(300);

    server.stop();
  });

  it('handles resources/list and resources/templates/list', async () => {
    const server = createMcpServer({ input, output, log, sessionStore, tokenHasher });
    server.start();

    let responsePromise = readRpcResponse(output);
    sendRpcRequest(input, {
      jsonrpc: '2.0',
      id: 6,
      method: 'resources/list',
    });
    let res = (await responsePromise) as { result: { resources: Array<{ uri: string }> } };
    expect(res.result.resources[0]?.uri).toBe('tokendamper://config');

    responsePromise = readRpcResponse(output);
    sendRpcRequest(input, {
      jsonrpc: '2.0',
      id: 7,
      method: 'resources/templates/list',
    });
    res = (await responsePromise) as unknown as { result: { resources: Array<{ uri: string }> } };
    expect((res.result as unknown as { resourceTemplates: Array<{ uriTemplate: string }> }).resourceTemplates[0]?.uriTemplate).toBe('tokendamper://session/{sessionId}');

    server.stop();
  });

  it('reads config resource via resources/read', async () => {
    const server = createMcpServer({ input, output, log, sessionStore, tokenHasher });
    server.start();

    const responsePromise = readRpcResponse(output);
    sendRpcRequest(input, {
      jsonrpc: '2.0',
      id: 8,
      method: 'resources/read',
      params: {
        uri: 'tokendamper://config',
      },
    });

    const res = (await responsePromise) as {
      result: { contents: Array<{ uri: string; text: string }> };
    };
    expect(res.result.contents[0]?.uri).toBe('tokendamper://config');
    const parsedConfig = JSON.parse(res.result.contents[0]!.text);
    expect(parsedConfig.appName).toBeDefined();

    server.stop();
  });

  it('reads dynamic session resource via resources/read', async () => {
    sessionStore.getOrCreateSession('dynamic-session-123');

    const server = createMcpServer({ input, output, log, sessionStore, tokenHasher });
    server.start();

    const responsePromise = readRpcResponse(output);
    sendRpcRequest(input, {
      jsonrpc: '2.0',
      id: 9,
      method: 'resources/read',
      params: {
        uri: 'tokendamper://session/dynamic-session-123',
      },
    });

    const res = (await responsePromise) as {
      result: { contents: Array<{ uri: string; text: string }> };
    };
    expect(res.result.contents[0]?.uri).toBe('tokendamper://session/dynamic-session-123');
    const parsedSession = JSON.parse(res.result.contents[0]!.text);
    expect(parsedSession.sessionId).toBe('dynamic-session-123');

    server.stop();
  });

  it('lists and gets prompt templates', async () => {
    const server = createMcpServer({ input, output, log, sessionStore, tokenHasher });
    server.start();

    let responsePromise = readRpcResponse(output);
    sendRpcRequest(input, {
      jsonrpc: '2.0',
      id: 10,
      method: 'prompts/list',
    });
    let res = (await responsePromise) as { result: { prompts: Array<{ name: string }> } };
    expect(res.result.prompts[0]?.name).toBe('optimize-context');

    responsePromise = readRpcResponse(output);
    sendRpcRequest(input, {
      jsonrpc: '2.0',
      id: 11,
      method: 'prompts/get',
      params: {
        name: 'optimize-context',
        arguments: {
          inputContext: 'My large system prompt',
          targetRatio: '0.4',
        },
      },
    });
    const promptRes = (await responsePromise) as {
      result: { messages: Array<{ role: string; content: { text: string } }> };
    };
    expect(promptRes.result.messages[0]?.role).toBe('user');
    expect(promptRes.result.messages[0]?.content.text).toContain('My large system prompt');

    server.stop();
  });

  it('runs mcp subcommand via runCli', () => {
    const stdoutMock = new PassThrough();
    const stderrMock = new PassThrough();
    const code = runCli(['mcp'], { stdout: stdoutMock, stderr: stderrMock });
    expect(code).toBe(0);
  });

  it('bounds traceStore to 100 entries and evicts oldest', async () => {
    // The store is now per-server rather than per-process (audit M5, minor), so the test holds
    // the one this server was given instead of reading a module-level map that every other
    // server in the process was also writing to.
    const traceStore = createTraceStore();
    const server = createMcpServer({ input, output, log, sessionStore, tokenHasher, traceStore });
    server.start();
    clearTraceStore();

    const requestIds: string[] = [];
    for (let i = 0; i < 105; i++) {
      sendRpcRequest(input, {
        jsonrpc: '2.0',
        id: `call-${i}`,
        method: 'tools/call',
        params: {
          name: 'optimize_context',
          arguments: { rawInput: `Input chunk ${i}` },
        },
      });
      const res = (await readRpcResponse(output)) as { result: { content: Array<{ text: string }> } };
      const parsedText = JSON.parse(res.result.content[0]!.text) as { requestId: string };
      requestIds.push(parsedText.requestId);
    }
    server.stop();

    // Check that we only have 100 entries max.
    // The first 5 should be evicted.
    expect(traceStore.size).toBe(100);
    expect(traceStore.get(requestIds[0]!)).toBeUndefined();
    expect(traceStore.get(requestIds[4]!)).toBeUndefined();
    expect(traceStore.get(requestIds[5]!)).toBeDefined();
    expect(traceStore.get(requestIds[104]!)).toBeDefined();

    // And nothing leaked into the process-wide default store.
    expect(getStoredTrace(requestIds[104]!)).toBeUndefined();
  });

  it('gives each server its own trace store', async () => {
    const storeA = createTraceStore();
    const storeB = createTraceStore();

    const serverA = createMcpServer({ input, output, log, sessionStore, tokenHasher, traceStore: storeA });
    serverA.start();
    sendRpcRequest(input, {
      jsonrpc: '2.0',
      id: 'iso-1',
      method: 'tools/call',
      params: { name: 'optimize_context', arguments: { rawInput: 'Isolation check input' } },
    });
    const res = (await readRpcResponse(output)) as { result: { content: Array<{ text: string }> } };
    const { requestId } = JSON.parse(res.result.content[0]!.text) as { requestId: string };
    serverA.stop();

    expect(storeA.get(requestId)).toBeDefined();
    // A second server must not see it. Before the split, both read one module-level map, so a
    // request id minted by one server was retrievable through the other.
    expect(storeB.get(requestId)).toBeUndefined();
  });

  it('rejects input chunk exceeding 10MB buffer size', async () => {
    const server = createMcpServer({ input, output, log, sessionStore, tokenHasher });
    server.start();

    const responsePromise = readRpcResponse(output);
    const largeChunk = 'a'.repeat(10 * 1024 * 1024 + 100);
    input.write(largeChunk);

    const res = (await responsePromise) as { error?: { code: number; message: string } };
    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(-32700);
    expect(res.error?.message).toContain('Buffer limit exceeded');

    server.stop();
  });
});
