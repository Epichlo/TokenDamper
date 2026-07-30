import type { Readable, Writable } from 'node:stream';
import { McpStdioServer } from './server';
import { TOOL_DEFINITIONS, handleToolCall } from './tools';
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
import type { ResolvedConfig } from '../../core/model/types';
import { loadConfig } from '../../config';
import { TOKENDAMPER_VERSION } from '../../version';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const SERVER_NAME = 'tokendamper-mcp';
export const SERVER_VERSION = TOKENDAMPER_VERSION;

export interface CreateMcpServerOptions {
  readonly input?: Readable | NodeJS.ReadableStream;
  readonly output?: Writable | NodeJS.WritableStream;
  readonly log?: Writable | NodeJS.WritableStream;
  readonly sessionStore?: GatewaySessionStore;
  readonly tokenHasher?: TokenHasher;
  readonly config?: ResolvedConfig;
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

  const requestHandler = async (
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<unknown> => {
    switch (method) {
      case 'initialize': {
        const result: McpInitializeResult = {
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
          const session = sessionStore.getOrCreateSession(sessionId);
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
