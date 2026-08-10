import { describe, expect, it } from 'vitest';
import { TOOL_DEFINITIONS, handleToolCall } from '../../src/adapters/mcp/tools';
import { negotiateProtocolVersion, MCP_PROTOCOL_VERSION } from '../../src/adapters/mcp';
import { TokenHasher } from '../../src/core/hashing/token-hasher';
import { GatewaySessionStore } from '../../src/gateway/session-store';
import { loadConfig } from '../../src/config';
import { readFileSync } from 'node:fs';

/**
 * Audit M5a — `optimize_context` had no budget parameter, so the MCP entry mode was a
 * guaranteed 0% no-op.
 *
 * With no budget the planner returns `pass_through` with an empty `stageIds`: zero stages run,
 * the input comes back unchanged, and the response reports `reductionRatio: 0` with no error.
 * One of three advertised entry modes did nothing, and said nothing about it.
 *
 * Two things are asserted here: a budget can now be passed and it actually engages the
 * pipeline, and the budget-less case is *reported* rather than silently indistinguishable from
 * incompressible input.
 */

// Real source, so a reduction has something to find. `src/core/planner/index.ts` is small,
// stable and comfortably above the size where elision beats its own marker.
const SAMPLE_TYPESCRIPT = readFileSync('src/core/planner/index.ts', 'utf8');

function context() {
  return {
    sessionStore: new GatewaySessionStore(),
    tokenHasher: new TokenHasher(),
    config: loadConfig({ cwd: process.cwd() }),
    traceStore: new Map(),
  };
}

async function optimize(args: Record<string, unknown>) {
  const result = await handleToolCall('optimize_context', args, context());
  return {
    isError: result.isError,
    text: result.content[0]!.text,
    payload: result.isError ? undefined : (JSON.parse(result.content[0]!.text) as Record<string, unknown>),
  };
}

describe('optimize_context budget parameter (M5a)', () => {
  it('advertises targetReductionRatio in its input schema', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'optimize_context');
    expect(tool).toBeDefined();
    expect(Object.keys(tool!.inputSchema.properties)).toContain('targetReductionRatio');
  });

  it('states in its description that a budget is required', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'optimize_context')!;
    expect(tool.description).toMatch(/budget is REQUIRED/i);
    expect(tool.description).toContain('targetReductionRatio');
  });

  it('reduces tokens when a targetReductionRatio is supplied', async () => {
    const { payload } = await optimize({
      rawInput: SAMPLE_TYPESCRIPT,
      language: 'typescript',
      targetReductionRatio: 0.3,
    });

    expect(payload!.budgetApplied).toBe(true);
    expect(payload!.planMode).toBe('topology_knapsack');
    expect(payload!.stagesExecuted).toBeGreaterThan(0);
    expect(payload!.tokensSaved).toBeGreaterThan(0);
    expect(payload!.reductionRatio as number).toBeGreaterThan(0);
  });

  it('runs zero stages and says so when no budget is given', async () => {
    const { payload } = await optimize({
      rawInput: SAMPLE_TYPESCRIPT,
      language: 'typescript',
    });

    // This is the pre-fix behaviour, retained — a budget genuinely is required. What changed
    // is that the response now distinguishes it from "nothing was compressible".
    expect(payload!.budgetApplied).toBe(false);
    expect(payload!.planMode).toBe('pass_through');
    expect(payload!.stagesExecuted).toBe(0);
    expect(payload!.reductionRatio).toBe(0);
    expect(payload!.notice).toMatch(/No budget in effect/);
  });

  it('omits the notice once a budget is in effect', async () => {
    const { payload } = await optimize({
      rawInput: SAMPLE_TYPESCRIPT,
      language: 'typescript',
      targetReductionRatio: 0.3,
    });
    expect(payload!.notice).toBeUndefined();
  });

  it('treats maxInputTokens as a budget too', async () => {
    const { payload } = await optimize({
      rawInput: SAMPLE_TYPESCRIPT,
      language: 'typescript',
      maxInputTokens: 200,
    });
    expect(payload!.budgetApplied).toBe(true);
    expect(payload!.planMode).toBe('topology_knapsack');
  });

  it('rejects an out-of-range ratio rather than clamping it', async () => {
    for (const bad of [1.5, -0.1, Number.NaN, 'aggressive']) {
      const result = await optimize({ rawInput: SAMPLE_TYPESCRIPT, targetReductionRatio: bad });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('targetReductionRatio must be a number between 0 and 1');
    }
  });

  it('accepts the boundary values', async () => {
    for (const ratio of [0, 1]) {
      const result = await optimize({ rawInput: SAMPLE_TYPESCRIPT, targetReductionRatio: ratio });
      expect(result.isError).toBeFalsy();
      // 0 is a legal value that engages nothing — the planner's own test is `> 0`.
      expect(result.payload!.budgetApplied).toBe(ratio === 1);
    }
  });
});

describe('MCP reads do not create state (M5 minor)', () => {
  it('get_session_metrics reports a missing session instead of creating it', async () => {
    const sessionStore = new GatewaySessionStore();
    const result = await handleToolCall(
      'get_session_metrics',
      { sessionId: 'never-seen' },
      { sessionStore, tokenHasher: new TokenHasher() },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Session not found: never-seen');
    expect(sessionStore.sessionCount).toBe(0);
  });

  it('still reports metrics for a session that exists', async () => {
    const sessionStore = new GatewaySessionStore();
    sessionStore.recordTurn(
      'real-session',
      { rawTokens: 500, optimizedTokens: 200, tokensSaved: 300, dedupRatio: 0.6, fallbackUsed: false },
      ['hash-1'],
    );

    const result = await handleToolCall(
      'get_session_metrics',
      { sessionId: 'real-session' },
      { sessionStore, tokenHasher: new TokenHasher() },
    );

    expect(result.isError).toBeFalsy();
    const metrics = JSON.parse(result.content[0]!.text) as { turnCount: number; cumulativeTokensSaved: number };
    expect(metrics.turnCount).toBe(1);
    expect(metrics.cumulativeTokensSaved).toBe(300);
  });

  it('getSession does not resurrect or touch the store', () => {
    const store = new GatewaySessionStore();
    expect(store.getSession('absent')).toBeUndefined();
    expect(store.sessionCount).toBe(0);

    store.getOrCreateSession('present');
    expect(store.getSession('present')).toBeDefined();
    expect(store.sessionCount).toBe(1);
  });
});

describe('MCP protocol version negotiation (M5 minor)', () => {
  it('echoes a requested version this server implements', () => {
    expect(negotiateProtocolVersion(MCP_PROTOCOL_VERSION)).toBe(MCP_PROTOCOL_VERSION);
  });

  it('answers with its own version when the request is unsupported or absent', () => {
    expect(negotiateProtocolVersion('2099-01-01')).toBe(MCP_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(undefined)).toBe(MCP_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(42)).toBe(MCP_PROTOCOL_VERSION);
  });
});
