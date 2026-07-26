import type { McpToolDefinition, McpToolCallResult } from './types';
import type { GatewaySessionStoreInterface } from '../../gateway/types';
import type { ResolvedConfig, OptimizationTrace, ContextItemKind } from '../../core/model/types';
import { createOptimizationRequest } from '../../core/model/constructors';
import { optimize } from '../../core/engine';
import { TokenHasher } from '../../core/hashing/token-hasher';
import { loadConfig } from '../../config';

export const MCP_ADAPTER_NAME = 'mcp';
export const MCP_ADAPTER_VERSION = '0.1.0';

export const TOOL_DEFINITIONS: ReadonlyArray<McpToolDefinition> = [
  {
    name: 'optimize_context',
    description: 'Compress and optimize prompt context using TokenDamper pipeline',
    inputSchema: {
      type: 'object',
      properties: {
        rawInput: {
          type: 'string',
          description: 'Raw context text or file content to optimize',
        },
        maxInputTokens: {
          type: 'number',
          description: 'Maximum allowable input tokens budget',
        },
        riskTolerance: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Risk tolerance level for elision/compression',
        },
        preserveKinds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Item kinds to preserve without compression (prompt, file, diff, conversation, note)',
        },
      },
      required: ['rawInput'],
    },
  },
  {
    name: 'rehydrate_context',
    description: 'Rehydrate elided placeholders or session references using TokenHasher cache and GatewaySessionStore',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text containing BLOCK_HASH placeholders or elision refs',
        },
        sessionId: {
          type: 'string',
          description: 'Optional Gateway session ID for session-bound lookup',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'get_optimization_trace',
    description: 'Retrieve execution trace and metrics for a specific optimization request',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: {
          type: 'string',
          description: 'Request ID assigned during optimize_context',
        },
      },
      required: ['requestId'],
    },
  },
  {
    name: 'get_session_metrics',
    description: 'Retrieve turn count, cumulative tokens saved, and stats for an active Gateway session',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Gateway session ID',
        },
      },
      required: ['sessionId'],
    },
  },
];

const traceStore = new Map<string, OptimizationTrace>();

export async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>,
  context: {
    readonly sessionStore: GatewaySessionStoreInterface;
    readonly tokenHasher: TokenHasher;
    readonly config?: ResolvedConfig;
  },
): Promise<McpToolCallResult> {
  switch (toolName) {
    case 'optimize_context': {
      const rawInput = typeof args.rawInput === 'string' ? args.rawInput : '';
      if (!rawInput) {
        return {
          content: [{ type: 'text', text: 'Error: rawInput is required and must be a non-empty string.' }],
          isError: true,
        };
      }

      const baseConfig = context.config ?? loadConfig({ cwd: process.cwd() });
      let budget = baseConfig.budget;

      if (args.maxInputTokens !== undefined || args.riskTolerance !== undefined || args.preserveKinds !== undefined) {
        budget = {
          ...budget,
          ...(typeof args.maxInputTokens === 'number' ? { maxInputTokens: args.maxInputTokens } : {}),
          ...(args.riskTolerance === 'low' || args.riskTolerance === 'medium' || args.riskTolerance === 'high'
            ? { riskTolerance: args.riskTolerance }
            : {}),
          ...(Array.isArray(args.preserveKinds)
            ? { preserveKinds: args.preserveKinds.filter((k): k is ContextItemKind => typeof k === 'string') }
            : {}),
        };
      }

      const effectiveConfig: ResolvedConfig = {
        ...baseConfig,
        budget,
      };

      const requestId = `mcp-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const request = createOptimizationRequest(rawInput, effectiveConfig, {
        requestId,
        adapterName: MCP_ADAPTER_NAME,
        adapterVersion: MCP_ADAPTER_VERSION,
        source: 'text',
      });

      const result = optimize(request, { tokenHasher: context.tokenHasher });
      traceStore.set(requestId, result.trace);
      if (traceStore.size > 100) {
        const oldestKey = traceStore.keys().next().value;
        if (oldestKey !== undefined) {
          traceStore.delete(oldestKey);
        }
      }

      const responsePayload = {
        requestId,
        emittedOutput: result.emittedOutput,
        tokenBefore: result.trace.tokenBefore,
        tokenAfter: result.trace.tokenAfter,
        tokensSaved: result.trace.tokenBefore - result.trace.tokenAfter,
        reductionRatio:
          result.trace.tokenBefore > 0
            ? Number((1 - result.trace.tokenAfter / result.trace.tokenBefore).toFixed(4))
            : 0,
        fallbackUsed: result.fallbackUsed,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(responsePayload, null, 2) }],
      };
    }

    case 'rehydrate_context': {
      const text = typeof args.text === 'string' ? args.text : '';
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined;

      let rehydrated = context.tokenHasher.rehydrateText(text);

      if (sessionId) {
        // Handle session ref patterns like <ELIDED: ref=abc123... lines=10>
        const elisionRefPattern = /<ELIDED:\s*ref=([A-Za-z0-9_-]+)[^>]*>/g;
        rehydrated = rehydrated.replace(elisionRefPattern, (match, ref) => {
          const content = context.sessionStore.getContent(sessionId, ref);
          return content !== undefined ? content : match;
        });
      }

      return {
        content: [{ type: 'text', text: rehydrated }],
      };
    }

    case 'get_optimization_trace': {
      const requestId = typeof args.requestId === 'string' ? args.requestId : '';
      const trace = traceStore.get(requestId);
      if (!trace) {
        return {
          content: [{ type: 'text', text: `Trace not found for requestId: ${requestId}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(trace, null, 2) }],
      };
    }

    case 'get_session_metrics': {
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId : '';
      const session = context.sessionStore.getOrCreateSession(sessionId);

      let cumulativeTokensSaved = 0;
      let totalRawTokens = 0;
      let totalOptimizedTokens = 0;

      for (const turn of session.turns) {
        cumulativeTokensSaved += turn.tokensSaved;
        totalRawTokens += turn.rawTokens;
        totalOptimizedTokens += turn.optimizedTokens;
      }

      const metrics = {
        sessionId: session.sessionId,
        turnCount: session.turnCount,
        createdAt: session.createdAt,
        lastActiveAt: session.lastActiveAt,
        cumulativeTokensSaved,
        totalRawTokens,
        totalOptimizedTokens,
        seenBlocksCount: session.seenBlockHashes.size,
        cachedContentEntries: session.contentByHash.size,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(metrics, null, 2) }],
      };
    }

    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
  }
}

/**
 * Returns registered trace for testing/inspection.
 */
export function getStoredTrace(requestId: string): OptimizationTrace | undefined {
  return traceStore.get(requestId);
}

/**
 * Clears stored trace map.
 */
export function clearTraceStore(): void {
  traceStore.clear();
}
