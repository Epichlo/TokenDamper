import type { OptimizationResult } from '../core/model/types';

/**
 * Metadata for a single session turn.
 */
export interface SessionTurn {
  readonly turnIndex: number;
  readonly timestamp: number;
  readonly rawTokens: number;
  readonly optimizedTokens: number;
  readonly tokensSaved: number;
  readonly dedupRatio: number;
  // Optional and absent unless validation/fallback was actually evaluated for the
  // turn. The proxy path now runs the full engine (Phase 1.0b) and records a computed
  // value; the field stays optional so any producer that skips validation can omit it
  // rather than assert a `false` it never computed.
  readonly fallbackUsed?: boolean;
}

/**
 * Stateful record for a cross-turn session.
 */
export interface GatewaySession {
  readonly sessionId: string;
  readonly createdAt: number;
  lastActiveAt: number;
  turnCount: number;
  readonly seenBlockHashes: Set<string>;
  readonly contentByHash: Map<string, string>;
  prefixHash?: string | undefined;
  readonly turns: SessionTurn[];
}

/**
 * Original raw content retained for later session rehydration.
 */
export interface SessionContentEntry {
  readonly hash: string;
  readonly content: string;
}

/**
 * Configuration options for the Gateway server.
 */
export interface GatewayConfig {
  readonly port: number;
  readonly host: string;
  readonly upstreamOpenAiUrl?: string | undefined;
  readonly upstreamAnthropicUrl?: string | undefined;
  readonly sessionTtlMs: number;
  readonly maxSessions: number;
  readonly maxContentEntriesPerSession?: number | undefined;
  /**
   * Cap on the per-session set of block hashes seen in earlier turns. Default 1000.
   *
   * Configurable because its neighbours are (audit OX-L6): it was a bare local constant inside
   * `capSeenBlockHashes` while `sessionTtlMs`, `maxSessions` and `maxContentEntriesPerSession`
   * were all settable, so the one bound that grows with conversation length was the one nobody
   * could tune. Eviction is insertion-ordered, so lowering it discards the oldest hashes first.
   */
  readonly maxSeenBlockHashesPerSession?: number | undefined;
  readonly gatewayToken?: string | undefined;
  /**
   * How long the upstream has to produce **response headers**, in milliseconds. Default 30000.
   *
   * Time-to-first-byte only. It deliberately does not bound how long the response *body* may
   * take, because an LLM completion routinely streams for minutes and a budget that governed
   * the body would truncate it mid-generation (audit OX-H2).
   */
  readonly upstreamTtfbTimeoutMs?: number | undefined;
  /**
   * Test seams, forwarded to `ProxyHandlerOptions`. See the fields of the same names there —
   * both replace ambient environment reads that used to sit inside the request path (audit M8),
   * and neither belongs in a deployed configuration.
   */
  readonly mockUpstream?: boolean | undefined;
  readonly allowMissingUpstreamCredentials?: boolean | undefined;
}

/**
 * Options passed to the proxy request handler.
 */
export interface ProxyHandlerOptions {
  readonly sessionStore: GatewaySessionStoreInterface;
  readonly upstreamOpenAiUrl?: string | undefined;
  readonly upstreamAnthropicUrl?: string | undefined;
  readonly abortSignal?: AbortSignal | undefined;
  /** Header budget in milliseconds; see `GatewayConfig.upstreamTtfbTimeoutMs`. Default 30000. */
  readonly upstreamTtfbTimeoutMs?: number | undefined;
  /**
   * The request body exactly as it arrived on the socket.
   *
   * The pipeline is string-based, so `rawBody` is a decode of these bytes. When the decode is
   * not faithful — the body was not valid UTF-8 — every stage, validator and token estimate
   * downstream would be reasoning about content the caller never sent, and the re-encoded
   * result is what gets forwarded to the provider. Supplying the bytes lets the proxy detect
   * that and pass the original through untouched.
   *
   * Optional because in-process callers (tests, and `processOpenAiRequest` used directly)
   * legitimately have only a string; absent, the body is trusted as-is, which is what the
   * behaviour was before.
   */
  readonly rawBodyBytes?: Buffer | undefined;
  /**
   * Answer locally with the optimized request body instead of calling a provider.
   *
   * A test seam, and the only way to reach that behaviour. It was previously triggered by
   * `TOKENDAMPER_MOCK_UPSTREAM=true` read from the ambient environment inside the request
   * path — which meant an agent pointed at a misconfigured process received its own prompt
   * back with a 200, indistinguishable from a completion (audit M8).
   *
   * Never enable this against real traffic.
   */
  readonly mockUpstream?: boolean | undefined;
  /**
   * Forward — or rather, return — a request that carries no upstream credentials, instead of
   * refusing it with a 401.
   *
   * Also a test seam. It was previously `process.env.NODE_ENV === 'test'`, a variable set by
   * a great many CI systems and process managers for reasons having nothing to do with this
   * proxy, so the credential check could switch itself off in an environment nobody had
   * chosen it for (audit M8).
   */
  readonly allowMissingUpstreamCredentials?: boolean | undefined;
}

export interface GatewaySessionStoreInterface {
  getOrCreateSession(sessionId: string): GatewaySession;
  /** Read-only lookup — returns `undefined` rather than bringing a session into existence. */
  getSession(sessionId: string): GatewaySession | undefined;
  recordTurn(
    sessionId: string,
    turn: Omit<SessionTurn, 'turnIndex' | 'timestamp'>,
    newBlocks: ReadonlyArray<string | SessionContentEntry>,
  ): GatewaySession;
  hasBlockHash(sessionId: string, hash: string): boolean;
  storeContent(sessionId: string, hash: string, content: string): void;
  getContent(sessionId: string, hashOrRef: string): string | undefined;
}

/**
 * Result returned by the reverse proxy handler.
 */
export interface ProxyRequestResult {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: string;
  /**
   * Bytes to forward upstream in place of `body`, when the two are not interchangeable.
   *
   * Set only on the pass-through path for a body that does not survive a UTF-8 round trip.
   * `body` is still populated (lossily) so existing readers keep working; anything that
   * actually puts bytes on the wire must prefer this when present.
   */
  readonly bodyBytes?: Buffer | undefined;
  readonly upstreamBody?: ReadableStream<Uint8Array> | null | undefined;
  readonly session: GatewaySession;
  readonly optimizationResult?: OptimizationResult | undefined;
}

/**
 * Standard OpenAI message structure.
 */
export interface OpenAiMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool' | 'function';
  readonly content: string | ReadonlyArray<{ type: string; text?: string; [key: string]: unknown }>;
  readonly name?: string;
  readonly tool_calls?: unknown[];
}

/**
 * Standard OpenAI chat completions request body payload.
 */
export interface OpenAiChatPayload {
  readonly model: string;
  readonly messages: ReadonlyArray<OpenAiMessage>;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly stream?: boolean;
  readonly tools?: unknown[];
  readonly [key: string]: unknown;
}

/**
 * Standard Anthropic message block structure.
 */
export interface AnthropicContentBlock {
  readonly type: 'text' | 'image' | 'tool_use' | 'tool_result' | 'thinking';
  readonly text?: string;
  readonly [key: string]: unknown;
}

/**
 * Standard Anthropic message structure.
 */
export interface AnthropicMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string | ReadonlyArray<AnthropicContentBlock>;
}

/**
 * Standard Anthropic messages request body payload.
 */
export interface AnthropicMessagesPayload {
  readonly model: string;
  readonly system?: string | ReadonlyArray<AnthropicContentBlock>;
  readonly messages: ReadonlyArray<AnthropicMessage>;
  readonly max_tokens?: number;
  readonly temperature?: number;
  readonly stream?: boolean;
  readonly tools?: unknown[];
  readonly [key: string]: unknown;
}
