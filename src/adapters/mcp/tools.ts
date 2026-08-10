import type { McpToolDefinition, McpToolCallResult } from './types';
import type { GatewaySessionStoreInterface } from '../../gateway/types';
import type { ResolvedConfig, OptimizationTrace, ContextItemKind } from '../../core/model/types';
import {
  createOptimizationRequest,
  declarableLanguages,
  normalizeLanguage,
} from '../../core/model/constructors';
import { optimize } from '../../core/engine';
import { SESSION_ELISION_MARKER_PATTERN } from '../../core/elision';
import { TokenHasher } from '../../core/hashing/token-hasher';
import { loadConfig } from '../../config';
import { TOKENDAMPER_VERSION } from '../../version';

export const MCP_ADAPTER_NAME = 'mcp';
export const MCP_ADAPTER_VERSION = TOKENDAMPER_VERSION;

export const TOOL_DEFINITIONS: ReadonlyArray<McpToolDefinition> = [
  {
    name: 'optimize_context',
    description:
      'Compress and optimize prompt context using the TokenDamper pipeline. A budget is REQUIRED: pass `targetReductionRatio` (or `maxInputTokens`), or configure one in tokendamper.config.json. With no budget the planner selects pass-through, runs zero stages, and returns the input unchanged at 0% reduction — the response reports that as `budgetApplied: false`.',
    inputSchema: {
      type: 'object',
      properties: {
        rawInput: {
          type: 'string',
          description: 'Raw context text or file content to optimize',
        },
        targetReductionRatio: {
          type: 'number',
          description:
            'Fraction of tokens to try to remove, 0–1 (e.g. 0.3). Any value above 0 engages the knapsack planner; this or `maxInputTokens` is what makes the tool do anything at all. Note it currently acts as an on/off switch rather than a proportional target.',
        },
        language: {
          type: 'string',
          description:
            'What the content is (typescript, python, json, markdown, …). An MCP call carries no filename, so without this the engine falls back to content heuristics and code goes unvalidated and uncompressed. Outranks `path`.',
        },
        path: {
          type: 'string',
          description:
            'The filename this content has or would have. Never opened — used for classification, validator selection and topology only.',
        },
        maxInputTokens: {
          type: 'number',
          description:
            'Maximum allowable input tokens. Also engages the knapsack planner, so it serves as a budget in its own right.',
        },
        // `riskTolerance` was advertised here as "Risk tolerance level for elision/compression"
        // and read by nothing in the pipeline — it reached the budget and stopped. Withdrawn
        // from the schema rather than reimplemented, so a caller is not offered a dial that
        // reports success and changes nothing (audit H4).
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

/** Maximum traces retained per store, oldest evicted first. */
const TRACE_STORE_CAPACITY = 100;

/**
 * Creates a trace store scoped to one server.
 *
 * A module-level `Map` used to serve every `createMcpServer` in the process at once, so two
 * servers shared a 100-entry budget and each could evict the other's traces — and a request id
 * minted by one was retrievable through the other (audit M5, minor). Kept as a plain `Map` so
 * the eviction below stays first-in-first-out by insertion order.
 */
export function createTraceStore(): Map<string, OptimizationTrace> {
  return new Map<string, OptimizationTrace>();
}

/**
 * Fallback store for callers that invoke `handleToolCall` without supplying one.
 *
 * `createMcpServer` always supplies its own; this exists for direct callers (chiefly tests)
 * and is what `getStoredTrace`/`clearTraceStore` read.
 */
const defaultTraceStore = createTraceStore();

export async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>,
  context: {
    readonly sessionStore: GatewaySessionStoreInterface;
    readonly tokenHasher: TokenHasher;
    readonly config?: ResolvedConfig;
    readonly traceStore?: Map<string, OptimizationTrace>;
  },
): Promise<McpToolCallResult> {
  const traceStore = context.traceStore ?? defaultTraceStore;

  switch (toolName) {
    case 'optimize_context': {
      const rawInput = typeof args.rawInput === 'string' ? args.rawInput : '';
      if (!rawInput) {
        return {
          content: [{ type: 'text', text: 'Error: rawInput is required and must be a non-empty string.' }],
          isError: true,
        };
      }

      // Declared, not probed. This is the entry mode with the strongest case for a
      // declaration and the weakest case for inference: the caller is a coding assistant
      // that knows exactly which file it is sending, and the JSON-RPC frame carries no
      // filename at all. Rejected rather than dropped when unrecognized — see
      // `normalizeLanguage`.
      const declaredLanguage = typeof args.language === 'string' ? args.language : undefined;
      if (declaredLanguage !== undefined && !normalizeLanguage(declaredLanguage)) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: unsupported language "${declaredLanguage}". Accepted: ${declarableLanguages().join(', ')}.`,
            },
          ],
          isError: true,
        };
      }
      const declaredPath = typeof args.path === 'string' && args.path ? args.path : undefined;

      // Rejected rather than clamped, for the same reason `language` is: a budget silently
      // coerced into range is a run the caller believes they configured and did not.
      if (args.targetReductionRatio !== undefined) {
        const ratio = args.targetReductionRatio;
        if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: targetReductionRatio must be a number between 0 and 1; received ${JSON.stringify(ratio)}.`,
              },
            ],
            isError: true,
          };
        }
      }

      const baseConfig = context.config ?? loadConfig({ cwd: process.cwd() });
      let budget = baseConfig.budget;

      if (
        args.targetReductionRatio !== undefined ||
        args.maxInputTokens !== undefined ||
        args.preserveKinds !== undefined
      ) {
        budget = {
          ...budget,
          ...(typeof args.targetReductionRatio === 'number'
            ? { targetReductionRatio: args.targetReductionRatio }
            : {}),
          ...(typeof args.maxInputTokens === 'number' ? { maxInputTokens: args.maxInputTokens } : {}),
          ...(Array.isArray(args.preserveKinds)
            ? { preserveKinds: args.preserveKinds.filter((k): k is ContextItemKind => typeof k === 'string') }
            : {}),
        };
      }

      // The same condition `plan()` uses to choose knapsack mode over pass-through. Computed
      // here so the response can state it, because the two outcomes are otherwise identical
      // on the wire: `reductionRatio: 0`, no error, no indication that zero stages ran.
      // That is invariant 10's shape — a clean result from something that never looked —
      // and it was the whole of the MCP entry mode's behaviour before this (audit M5a).
      const budgetApplied =
        (typeof budget.maxInputTokens === 'number' && budget.maxInputTokens > 0) ||
        (typeof budget.targetReductionRatio === 'number' && budget.targetReductionRatio > 0);

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
        ...(declaredPath ? { sourcePath: declaredPath } : {}),
        ...(declaredLanguage ? { language: declaredLanguage } : {}),
      });

      const result = optimize(request, { tokenHasher: context.tokenHasher });
      traceStore.set(requestId, result.trace);
      if (traceStore.size > TRACE_STORE_CAPACITY) {
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
        // Reported, not merely implied by a 0. `planMode` and `stagesExecuted` say what the
        // engine chose to do; `budgetApplied` says whether the caller gave it anything to
        // work with. A caller seeing `budgetApplied: false` knows the 0% is their
        // configuration and not this input's compressibility.
        budgetApplied,
        planMode: result.trace.planMode,
        stagesExecuted: result.trace.stageCount,
        ...(budgetApplied
          ? {}
          : {
              notice:
                'No budget in effect: pass `targetReductionRatio` (0–1) or `maxInputTokens`, or set one in tokendamper.config.json. Zero stages ran and the input was returned unchanged.',
            }),
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
        // The pattern comes from the module that renders the marker, rather than being
        // restated here. Restating it is exactly how this tool came to look for
        // `<ELIDED: ref=… >` while `cleanup:session-dedup` emitted
        // `[TokenDamper Elided: ref=… bytes=… kind=…]` — a shape the product has never
        // produced, so session rehydration through MCP matched nothing (audit M5b).
        const elisionRefPattern = new RegExp(SESSION_ELISION_MARKER_PATTERN.source, 'g');
        rehydrated = rehydrated.replace(elisionRefPattern, (match, ref: string) => {
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
      // `getSession`, not `getOrCreateSession`: asking for metrics used to create the session
      // being asked about, so an unknown id answered with a plausible all-zero record instead
      // of saying it did not exist — and, under `maxSessions`, could evict a live one.
      const session = context.sessionStore.getSession(sessionId);
      if (!session) {
        return {
          content: [{ type: 'text', text: `Session not found: ${sessionId}` }],
          isError: true,
        };
      }

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
 * Returns a trace from the default store, for testing/inspection.
 *
 * Only sees traces from `handleToolCall` invocations that supplied no `traceStore`. A server
 * created by `createMcpServer` owns its own and is inspected through `McpStdioServer.getTrace`.
 */
export function getStoredTrace(requestId: string): OptimizationTrace | undefined {
  return defaultTraceStore.get(requestId);
}

/**
 * Clears the default trace map.
 */
export function clearTraceStore(): void {
  defaultTraceStore.clear();
}
