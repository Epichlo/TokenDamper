import type { Readable, Writable } from 'node:stream';
import { McpStdioServer } from './server';
import { TOOL_DEFINITIONS, createTraceStore, handleToolCall } from './tools';
import type {
  McpInitializeResult,
  McpResourceDefinition,
  McpResourceTemplate,
  McpResourceContent,
  McpPromptDefinition,
  McpPromptMessage,
} from './types';
import { JSON_RPC_ERROR_CODES } from './types';
import { GatewaySessionStore } from '../../gateway/session-store';
import { TokenHasher } from '../../core/hashing/token-hasher';
import type { OptimizationTrace, ResolvedConfig } from '../../core/model/types';
import { loadConfig } from '../../config';
import { TOKENDAMPER_VERSION } from '../../version';

export const MCP_PROTOCOL_VERSION = '2024-11-05';

/**
 * Protocol revisions this server will speak, newest first.
 *
 * `initialize` used to answer `MCP_PROTOCOL_VERSION` unconditionally, ignoring whatever the
 * client asked for. That is not a handshake — a client requesting a revision this server does
 * not implement was told it had been agreed to (audit M5, minor). The list is deliberately the
 * single revision actually implemented: negotiation that claims more than the code does would
 * be the same defect with extra steps.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: ReadonlyArray<string> = [MCP_PROTOCOL_VERSION];

/**
 * Resolves the revision to answer `initialize` with.
 *
 * Echoes the client's request when it is one this server implements; otherwise answers with
 * this server's own, which is what the specification prescribes for an unsupported request —
 * the client then decides whether it can proceed.
 */
export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : MCP_PROTOCOL_VERSION;
}
export const SERVER_NAME = 'tokendamper-mcp';
export const SERVER_VERSION = TOKENDAMPER_VERSION;

export interface CreateMcpServerOptions {
  readonly input?: Readable | NodeJS.ReadableStream;
  readonly output?: Writable | NodeJS.WritableStream;
  readonly log?: Writable | NodeJS.WritableStream;
  readonly sessionStore?: GatewaySessionStore;
  readonly tokenHasher?: TokenHasher;
  readonly config?: ResolvedConfig;
  /**
   * Trace store for this server. Defaults to a fresh one, which is the point — it used to be
   * a single module-level map shared by every server in the process. Injectable on the same
   * terms as `sessionStore`, so a caller that wants to inspect traces can hold the map.
   */
  readonly traceStore?: Map<string, OptimizationTrace>;
}

const STATIC_RESOURCES: ReadonlyArray<McpResourceDefinition> = [
  {
    uri: 'tokendamper://config',
    name: 'TokenDamper Configuration',
    description: 'Active TokenDamper runtime optimization configuration and budget rules',
    mimeType: 'application/json',
  },
];

const RESOURCE_TEMPLATES: ReadonlyArray<McpResourceTemplate> = [
  {
    uriTemplate: 'tokendamper://session/{sessionId}',
    name: 'Gateway Session State',
    description: 'Dynamic session state, turn history, and metrics for a Gateway session',
    mimeType: 'application/json',
  },
];

const PROMPT_DEFINITIONS: ReadonlyArray<McpPromptDefinition> = [
  {
    name: 'optimize-context',
    description: 'System prompt template instructing how to compress large context prompts with TokenDamper',
    arguments: [
      {
        name: 'inputContext',
        description: 'The raw input text or codebase context to compress',
        required: true,
      },
      {
        name: 'targetRatio',
        description: 'Optional target reduction ratio (e.g. 0.5 for 50% savings)',
        required: false,
      },
    ],
  },
];

/**
 * Creates an instance of the TokenDamper MCP Stdio Server.
 */
export function createMcpServer(options: CreateMcpServerOptions = {}): McpStdioServer {
  const sessionStore = options.sessionStore ?? new GatewaySessionStore();
  const tokenHasher = options.tokenHasher ?? new TokenHasher();
  const config = options.config ?? loadConfig({ cwd: process.cwd() });
  // One store per server rather than one per process, so two servers in a process cannot
  // evict each other's traces or read each other's request ids (audit M5, minor).
  const traceStore = options.traceStore ?? createTraceStore();

  const requestHandler = async (
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<unknown> => {
    switch (method) {
      case 'initialize': {
        const result: McpInitializeResult = {
          protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false },
          },
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION,
          },
        };
        return result;
      }

      case 'tools/list': {
        return { tools: TOOL_DEFINITIONS };
      }

      case 'tools/call': {
        if (!params || typeof params.name !== 'string') {
          const err = new Error('Missing or invalid tool name parameter') as Error & { code?: number };
          err.code = JSON_RPC_ERROR_CODES.INVALID_PARAMS;
          throw err;
        }
        const toolArgs = (params.arguments as Record<string, unknown>) ?? {};
        return handleToolCall(params.name, toolArgs, {
          sessionStore,
          tokenHasher,
          config,
          traceStore,
        });
      }

      case 'resources/list': {
        return { resources: STATIC_RESOURCES };
      }

      case 'resources/templates/list': {
        return { resourceTemplates: RESOURCE_TEMPLATES };
      }

      case 'resources/read': {
        if (!params || typeof params.uri !== 'string') {
          const err = new Error('Missing or invalid uri parameter') as Error & { code?: number };
          err.code = JSON_RPC_ERROR_CODES.INVALID_PARAMS;
          throw err;
        }

        const uri = params.uri;

        if (uri === 'tokendamper://config') {
          const content: McpResourceContent = {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(config, null, 2),
          };
          return { contents: [content] };
        }

        const sessionMatch = /^tokendamper:\/\/session\/([^/]+)$/.exec(uri);
        if (sessionMatch && sessionMatch[1]) {
          const sessionId = sessionMatch[1];
          // Reading a resource must not create one. `getOrCreateSession` here meant every
          // `resources/read` of a session URI materialized that session, so the resource
          // could never report "no such session" and an inspecting client mutated the store
          // it was inspecting (audit M5, minor).
          const session = sessionStore.getSession(sessionId);
          if (!session) {
            const missing = new Error(`Session not found: ${sessionId}`) as Error & { code?: number };
            missing.code = JSON_RPC_ERROR_CODES.INVALID_PARAMS;
            throw missing;
          }
          const sessionData = {
            sessionId: session.sessionId,
            createdAt: session.createdAt,
            lastActiveAt: session.lastActiveAt,
            turnCount: session.turnCount,
            seenBlockHashes: Array.from(session.seenBlockHashes),
            turns: session.turns,
          };
          const content: McpResourceContent = {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(sessionData, null, 2),
          };
          return { contents: [content] };
        }

        const err = new Error(`Resource not found: ${uri}`) as Error & { code?: number };
        err.code = JSON_RPC_ERROR_CODES.INVALID_PARAMS;
        throw err;
      }

      case 'prompts/list': {
        return { prompts: PROMPT_DEFINITIONS };
      }

      case 'prompts/get': {
        if (!params || typeof params.name !== 'string') {
          const err = new Error('Missing or invalid prompt name parameter') as Error & { code?: number };
          err.code = JSON_RPC_ERROR_CODES.INVALID_PARAMS;
          throw err;
        }

        if (params.name === 'optimize-context') {
          const promptArgs = (params.arguments as Record<string, string>) ?? {};
          const inputContext = promptArgs.inputContext ?? '';
          const targetRatio = promptArgs.targetRatio ? ` Target reduction ratio: ${promptArgs.targetRatio}.` : '';

          const userMessage: McpPromptMessage = {
            role: 'user',
            content: {
              type: 'text',
              text: `Please optimize and compress the following prompt context using TokenDamper while preserving critical semantics.${targetRatio}\n\nContext:\n${inputContext}`,
            },
          };

          return {
            description: 'TokenDamper context optimization prompt template',
            messages: [userMessage],
          };
        }

        const err = new Error(`Prompt template not found: ${params.name}`) as Error & { code?: number };
        err.code = JSON_RPC_ERROR_CODES.INVALID_PARAMS;
        throw err;
      }

      default: {
        const err = new Error(`Method not found: ${method}`) as Error & { code?: number };
        err.code = JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND;
        throw err;
      }
    }
  };

  const notificationHandler = (_method: string, _params: Record<string, unknown> | undefined): void => {
    // Handling notifications (e.g. notifications/initialized) - no response required per JSON-RPC standard
  };

  return new McpStdioServer({
    ...(options.input ? { input: options.input } : {}),
    ...(options.output ? { output: options.output } : {}),
    ...(options.log ? { log: options.log } : {}),
    requestHandler,
    notificationHandler,
  });
}

/**
 * Creates and starts the MCP stdio server.
 */
export function startMcpServer(options: CreateMcpServerOptions = {}): McpStdioServer {
  const server = createMcpServer(options);
  server.start();
  return server;
}

export * from './types';
export * from './server';
export * from './tools';
