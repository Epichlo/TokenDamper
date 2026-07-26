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
  readonly fallbackUsed: boolean;
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
}

/**
 * Options passed to the proxy request handler.
 */
export interface ProxyHandlerOptions {
  readonly sessionStore: GatewaySessionStoreInterface;
  readonly upstreamOpenAiUrl?: string | undefined;
  readonly upstreamAnthropicUrl?: string | undefined;
  readonly abortSignal?: AbortSignal | undefined;
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
