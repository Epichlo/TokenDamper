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
  readonly gatewayToken?: string | undefined;
}

/**
 * Options passed to the proxy request handler.
 */
export interface ProxyHandlerOptions {
  readonly sessionStore: GatewaySessionStoreInterface;
  readonly upstreamOpenAiUrl?: string | undefined;
  readonly upstreamAnthropicUrl?: string | undefined;
  readonly abortSignal?: AbortSignal | undefined;
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
}

export interface GatewaySessionStoreInterface {
  getOrCreateSession(sessionId: string): GatewaySession;
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
