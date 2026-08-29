import type { IncomingHttpHeaders } from 'node:http';
import { loadConfig } from '../config';
import {
  classifyContentShape,
  type ContentShape,
  createBundleStatistics,
  createContextItem,
  createOptimizationBudget,
  freeze,
  hashContent,
} from '../core/model/constructors';
import type {
  ContextBundle,
  ContextItem,
  ContextItemKind,
  OptimizationRequest,
  ResolvedConfig,
} from '../core/model/types';
import { optimize } from '../core/engine';
import { CONTENT_SHAPE_METADATA_KEY, type ContentShapeTag } from '../core/elision';
import { estimateBundleTokens } from '../core/hashing/tokenizer';
import { ConfidenceLedger } from '../core/ledger/confidence-ledger';
import { TOKENDAMPER_VERSION } from '../version';
import { GatewaySessionStore } from './session-store';
import type { AnthropicMessagesPayload, GatewaySession, OpenAiChatPayload, ProxyHandlerOptions, ProxyRequestResult, SessionContentEntry } from './types';

/**
 * Handles incoming API requests, normalizing payloads, running cross-turn deduplication,
 * and forwarding requests upstream.
 */
export async function handleProxyRequest(
  method: string,
  urlPath: string,
  headers: IncomingHttpHeaders,
  rawBody: string,
  options: ProxyHandlerOptions,
): Promise<ProxyRequestResult> {
  const requestUrl = new URL(urlPath, 'http://tokendamper.local');
  const routePath = requestUrl.pathname;
  const sessionId = getSessionIdFromHeaders(headers, rawBody);
  const session = options.sessionStore.getOrCreateSession(sessionId);

  // Can the string model represent what the caller actually sent?
  //
  // A round trip, not a charset sniff — the only question that matters is whether these exact
  // bytes survive the representation everything downstream is built on. Identical reasoning to
  // the CLI's `inputSurvivesDecoding` (DECISIONS §35); the difference is that here an
  // unfaithful decode is not merely printed, it is forwarded to a provider as if the caller had
  // sent it.
  const bodyBytes = options.rawBodyBytes;
  const bodyIsLossless = bodyBytes === undefined || Buffer.from(rawBody, 'utf8').equals(bodyBytes);

  const cleanHeaders: Record<string, string> = {};
  for (const [key, val] of Object.entries(headers)) {
    if (val !== undefined && key.toLowerCase() !== 'host' && key.toLowerCase() !== 'content-length') {
      cleanHeaders[key] = Array.isArray(val) ? val.join(', ') : val;
    }
  }

  if (method.toUpperCase() !== 'POST' && (routePath === '/v1/chat/completions' || routePath === '/v1/messages')) {
    return {
      statusCode: 405,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: `Method ${method} is not allowed for ${routePath}` }),
      session,
    };
  }

  // Handle OpenAI API endpoint
  if (routePath === '/v1/chat/completions') {
    const optimized = bodyIsLossless
      ? processOpenAiRequest(rawBody, session, options)
      : passThroughUnrepresentable(bodyBytes as Buffer, rawBody, session);
    if (optimized.statusCode !== 200 || shouldUseMockUpstream(options)) {
      return optimized;
    }
    if (!hasAuthHeaders(cleanHeaders)) {
      if (options.allowMissingUpstreamCredentials === true) {
        return optimized;
      }
      return {
        statusCode: 401,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'Unauthorized: Missing upstream authorization header' }),
        session,
      };
    }

    return forwardUpstreamRequest({
      provider: 'openai',
      requestUrl,
      body: optimized.body,
      ...(optimized.bodyBytes ? { bodyBytes: optimized.bodyBytes } : {}),
      incomingHeaders: cleanHeaders,
      streamRequested: isStreamRequested(optimized.body),
      session: optimized.session,
      options,
    });
  }

  // Handle Anthropic API endpoint
  if (routePath === '/v1/messages') {
    const optimized = bodyIsLossless
      ? processAnthropicRequest(rawBody, session, options)
      : passThroughUnrepresentable(bodyBytes as Buffer, rawBody, session);
    if (optimized.statusCode !== 200 || shouldUseMockUpstream(options)) {
      return optimized;
    }
    if (!hasAuthHeaders(cleanHeaders)) {
      if (options.allowMissingUpstreamCredentials === true) {
        return optimized;
      }
      return {
        statusCode: 401,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'Unauthorized: Missing upstream authorization header' }),
        session,
      };
    }

    return forwardUpstreamRequest({
      provider: 'anthropic',
      requestUrl,
      body: optimized.body,
      ...(optimized.bodyBytes ? { bodyBytes: optimized.bodyBytes } : {}),
      incomingHeaders: cleanHeaders,
      streamRequested: isStreamRequested(optimized.body),
      session: optimized.session,
      options,
    });
  }

  // Fallback pass-through for unknown endpoints
  return {
    statusCode: 404,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: `Unknown gateway endpoint: ${urlPath}` }),
    session,
  };
}

type UpstreamProvider = 'openai' | 'anthropic';

interface ForwardUpstreamOptions {
  readonly provider: UpstreamProvider;
  readonly requestUrl: URL;
  readonly body: string;
  /** Preferred over `body` when set — see `ProxyRequestResult.bodyBytes`. */
  readonly bodyBytes?: Buffer | undefined;
  readonly incomingHeaders: Record<string, string>;
  readonly streamRequested: boolean;
  readonly session: ReturnType<GatewaySessionStore['getOrCreateSession']>;
  readonly options: ProxyHandlerOptions;
}

async function forwardUpstreamRequest(params: ForwardUpstreamOptions): Promise<ProxyRequestResult> {
  const upstreamBase =
    params.provider === 'openai'
      ? (params.options.upstreamOpenAiUrl ?? 'https://api.openai.com')
      : (params.options.upstreamAnthropicUrl ?? 'https://api.anthropic.com');
  const upstreamUrl = buildUpstreamUrl(upstreamBase, params.requestUrl);

  let upstreamResponse: Response;
  try {
    const timeoutSignal = AbortSignal.timeout(30000);
    const signal = params.options.abortSignal 
      ? AbortSignal.any([params.options.abortSignal, timeoutSignal])
      : timeoutSignal;

    const fetchInit: RequestInit = {
      method: 'POST',
      headers: buildForwardHeaders(params.incomingHeaders, params.provider),
      // Bytes win when present: `params.body` is a lossy decode in that case, and re-encoding
      // it is exactly the corruption this path exists to avoid. Copied into a standalone
      // `ArrayBuffer` because neither `Buffer` nor a `Uint8Array` view satisfies the `BodyInit`
      // union this project's lib resolves. The copy is irrelevant — this branch is reached only
      // by a body that is not valid UTF-8, and bodies are capped at 10 MB.
      body: params.bodyBytes ? new Uint8Array(params.bodyBytes).buffer : params.body,
      signal,
    };

    upstreamResponse = await fetch(upstreamUrl, fetchInit);
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return {
        statusCode: 504,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'Gateway Timeout: Upstream request exceeded 30000ms' }),
        session: params.session,
      };
    }
    const message = error instanceof Error ? error.message : 'Unknown upstream fetch error';
    return {
      statusCode: 502,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: `Upstream ${params.provider} request failed: ${message}` }),
      session: params.session,
    };
  }

  const responseHeaders = copyResponseHeaders(upstreamResponse.headers);
  const contentType = upstreamResponse.headers.get('content-type') ?? '';
  const shouldStream = params.streamRequested || contentType.toLowerCase().includes('text/event-stream');

  if (shouldStream && upstreamResponse.body) {
    return {
      statusCode: upstreamResponse.status,
      headers: responseHeaders,
      body: '',
      upstreamBody: upstreamResponse.body,
      session: params.session,
    };
  }

  return {
    statusCode: upstreamResponse.status,
    headers: responseHeaders,
    body: await upstreamResponse.text(),
    session: params.session,
  };
}

function buildUpstreamUrl(upstreamBase: string, requestUrl: URL): string {
  const base = upstreamBase.endsWith('/') ? upstreamBase.slice(0, -1) : upstreamBase;
  return `${base}${requestUrl.pathname}${requestUrl.search}`;
}

/**
 * The headers a locally-produced 200 carries back to the caller.
 *
 * Constructed, never derived from the request. The two optimize paths used to return
 * `{ ...cleanHeaders, 'content-type': 'application/json' }`, and `cleanHeaders` strips only
 * `host` and `content-length` — so `authorization` and `x-api-key` came straight back out as
 * *response* headers, reproducible under mock upstream as `x-api-key: sk-test` on the way out
 * (audit M9).
 *
 * On the normal path those values were overwritten by the upstream response's headers, which
 * made this latent rather than live — but "latent" here meant one environment variable away,
 * and a response header is a value that gets logged, cached and proxied onward. Nothing about
 * an inbound request header makes it a correct thing to say on the way back, so the fix is to
 * stop deriving one from the other rather than to lengthen a strip-list.
 */
function localResponseHeaders(): Record<string, string> {
  return { 'content-type': 'application/json' };
}

/**
 * Whether to answer locally with the optimized request instead of calling a provider.
 *
 * Read from the injected options and from nowhere else. This used to be
 * `process.env.TOKENDAMPER_MOCK_UPSTREAM === 'true'`, an undocumented ambient switch that made
 * the proxy return the caller's own optimized prompt with a 200 as though a model had produced
 * it. A test seam reachable by an environment variable is reachable in production; a parameter
 * is not (audit M8).
 */
function shouldUseMockUpstream(options: ProxyHandlerOptions): boolean {
  return options.mockUpstream === true;
}

function hasAuthHeaders(headers: Record<string, string>): boolean {
  return !!getHeader(headers, 'authorization') || !!getHeader(headers, 'x-api-key');
}

function isStreamRequested(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { stream?: unknown };
    return parsed.stream === true;
  } catch {
    return false;
  }
}

function getHeader(headers: Record<string, string>, headerName: string): string | undefined {
  const wanted = headerName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function buildForwardHeaders(headers: Record<string, string>, provider: UpstreamProvider): Record<string, string> {
  const forwarded: Record<string, string> = {};
  const blockedHeaders = new Set([
    'host',
    'content-length',
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'x-session-id',
    'x-tokendamper-session-id',
  ]);
  const providerPrefixes = provider === 'openai' ? ['openai-'] : ['anthropic-'];

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (blockedHeaders.has(lower)) {
      continue;
    }

    if (
      lower === 'authorization' ||
      lower === 'x-api-key' ||
      lower === 'accept' ||
      lower === 'user-agent' ||
      lower === 'content-type' ||
      providerPrefixes.some((prefix) => lower.startsWith(prefix))
    ) {
      forwarded[key] = value;
    }
  }

  forwarded['content-type'] = forwarded['content-type'] ?? 'application/json';
  return forwarded;
}

function copyResponseHeaders(headers: Headers): Record<string, string> {
  const copied: Record<string, string> = {};
  const blockedHeaders = new Set([
    'connection',
    'content-length',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ]);

  headers.forEach((value, key) => {
    if (!blockedHeaders.has(key.toLowerCase())) {
      copied[key] = value;
    }
  });

  return copied;
}

function getSessionIdFromHeaders(headers: IncomingHttpHeaders, body: string): string {
  const headerSessionId = headers['x-session-id'] || headers['x-tokendamper-session-id'];
  if (headerSessionId) {
    if (Array.isArray(headerSessionId)) {
      const first = headerSessionId[0];
      if (first) return first;
    } else {
      return headerSessionId;
    }
  }

  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (parsed && typeof parsed.session_id === 'string') {
      return parsed.session_id;
    }
    if (parsed && typeof parsed.metadata === 'object' && parsed.metadata !== null) {
      const meta = parsed.metadata as Record<string, unknown>;
      if (typeof meta.session_id === 'string') {
        return meta.session_id;
      }
    }
  } catch {
    // Ignore JSON parse error in session ID extraction
  }

  return 'default-session';
}

/**
 * Fail-open for a body the string model cannot represent: forward the caller's bytes, unchanged.
 *
 * Invariant 3 on the Gateway. Optimizing is not an option — every stage, validator and estimate
 * operates on the decoded string, so for these bytes they would all be reasoning about content
 * the caller never sent, and a "saving" measured against corrupted input is worse than none.
 * Rejecting is not an option either: TokenDamper is a transparent proxy, and a body the provider
 * might well accept is not TokenDamper's to refuse.
 *
 * `body` is still populated with the lossy decode so existing readers of `ProxyRequestResult`
 * keep working; `bodyBytes` carries the truth and is what reaches the socket.
 */
function passThroughUnrepresentable(
  bytes: Buffer,
  lossyBody: string,
  session: GatewaySession,
): ProxyRequestResult {
  return {
    statusCode: 200,
    headers: localResponseHeaders(),
    body: lossyBody,
    bodyBytes: bytes,
    session,
  };
}

/**
 * What the optimizer produced, and deliberately **not** what it cost.
 *
 * This carried `rawTokens`, `optimizedTokens` and `tokensSaved` off
 * `summary.tokenEstimate` until audit M7 (DECISIONS §54) moved the measurement onto the bytes
 * actually forwarded. `wireTokenMetrics` computes them now, from `rawBody` and `finalBody`,
 * and both call sites spread it — so these three were still being computed and read by nobody.
 *
 * Removed rather than left in place, because the two sets disagree by design: the render-based
 * numbers read 48.5% where the wire saw 47.1%, and a field that looks authoritative next to the
 * one that replaced it is how a fixed finding comes back.
 */
interface GatewayOptimizationOutcome {
  readonly finalBundle: ContextBundle;
  readonly fallbackUsed: boolean;
}

/**
 * Runs the proxy payload through the shared optimization engine so Gateway traffic
 * gets the same validators, ledgers, drift/debt tracking and fail-open fallback the
 * CLI and MCP adapters already have (Phase 1.0b).
 *
 * The planner is pinned to `session_dedup` mode: cross-turn deduplication is the only
 * transform safe to apply to live provider payloads today, because `token-hashing`
 * corrupts JSON-shaped message content (Issue 2).
 */
function runGatewayOptimization(
  rawBody: string,
  initialBundle: ContextBundle,
  session: ReturnType<GatewaySessionStore['getOrCreateSession']>,
  options: ProxyHandlerOptions,
): GatewayOptimizationOutcome {
  const baseConfig = loadConfig();
  // DO NOT widen this to the knapsack stage list without first fixing Issue 2.
  //
  // Running exactly one stage here is deliberate containment, NOT an unfinished
  // implementation. `session_dedup` mode plans only `cleanup:session-dedup`.
  // `compression:token-hashing` elides item content; Gateway message content is frequently
  // JSON (tool calls arrive as `JSON.stringify(msg.content)`). The original reason recorded
  // here — that the stage wrote bare `<BLOCK_HASH:...>` markers and would emit corrupted
  // JSON — no longer holds: `core/elision` renders every marker validly for the item's
  // syntax. The planner still has no content-type awareness, and drift below is now the
  // operative blocker.
  //
  // Note the drift exemption in DriftTracker covers `recoverable` (dedup) elisions only.
  // The lossy compression stages are still scored in full, so drift is a second, separate
  // blocker on widening this list. See docs/phase-1-stabilization-summary.md (§5.3, §7). [retired]
  const config: ResolvedConfig = {
    ...baseConfig,
    planner: { ...baseConfig.planner, defaultMode: 'session_dedup' },
  };

  const request: OptimizationRequest = {
    requestId: `gateway:${session.sessionId}:${session.turnCount + 1}`,
    rawInput: rawBody,
    bundle: initialBundle,
    budget: createOptimizationBudget(config.budget),
    config,
    adapterName: 'gateway',
    adapterVersion: TOKENDAMPER_VERSION,
  };

  const result = optimize(request, {
    sessionContext: {
      previousBlockHashes: session.seenBlockHashes,
      storeContent: (hash, content) => options.sessionStore.storeContent(session.sessionId, hash, content),
      getContent: (hashOrRef) => options.sessionStore.getContent(session.sessionId, hashOrRef),
    },
    // Deliberately per-request rather than session-scoped: a persistent ledger decays
    // earlier turns' elision confidence below `validation.minimumConfidence` (default 1),
    // which would force a fallback on every turn after the first. Cross-turn confidence
    // decay needs its own threshold policy and is out of scope for this phase.
    confidenceLedger: new ConfidenceLedger(),
    currentTurn: session.turnCount + 1,
  });

  return {
    // DO NOT switch this to `result.emittedOutput` — doing so reintroduces Issue 5 on
    // live provider traffic.
    //
    // `emittedOutput` comes from the fallback resolver, which renders a bundle by joining
    // item contents with newlines. That is a plain text blob, not a valid provider API
    // payload: it drops `model`, `system`, role structure and every other top-level field,
    // and on the fallback path it is what makes output larger than input (Issue 5, the
    // -1.39% result on session.json).
    //
    // Mapping `finalBundle` items positionally back onto the already-parsed payload keeps
    // the request shape intact. Because the engine returns the ORIGINAL bundle whenever
    // fallback fires, that mapping reproduces the request body byte-for-byte — which is
    // how this path satisfies invariant 3 structurally rather than by test enforcement.
    finalBundle: result.finalBundle,
    fallbackUsed: result.fallbackUsed,
  };
}

/**
 * Classifies a provider message body with the canonical ingestion classifier.
 *
 * Every other construction site in the codebase reaches `classifyContent` through
 * `createContextBundle`; the Gateway built its items by hand and hardcoded
 * `contentType: 'text'` instead. That literal was not cosmetic — it silently disarmed
 * both safety nets on JSON-shaped traffic, which is most of what a Gateway carries:
 *
 *  - `selectValidator` dispatches on `language` -> `path` -> `contentType`. Gateway items
 *    have no language and no path, so a `text` tag meant it returned `null` and **no AST
 *    validator ran at all**.
 *  - `DriftTracker.extractSymbols` only harvests `jsonkey:` symbols when
 *    `contentType === 'json'`. A JSON payload tagged `text` yields zero symbols, so
 *    retention was vacuously 1.0 and drift vacuously 0.00.
 *
 * Both checks were reporting a pass they had never performed. See
 * `docs/issue-2-content-type-contract-design.md` §2.2. [retired]
 *
 * **This closed the JSON half only, and the record overstates it.** `classifyContent` does
 * see JSON as JSON, so the drift half above holds. It did *not* start selecting a validator
 * for code: it answered `html` for TypeScript (46 of 57 of this repository's own sources),
 * and `selectValidator` has no `html` branch — so a pathless item carrying broken TypeScript
 * still reached the provider with `valid: true` and nothing having examined it. DECISIONS
 * §22 fixes the classifier; §23 makes an unvalidated item report itself as unvalidated
 * instead of as a pass. Pathless code remains unchecked by design (§17 removed content-only
 * code detection) — it is now visible on `trace.astCoverage` rather than silent.
 *
 * There is deliberately no `sourcePath` argument: a provider message has no filename, so
 * classification is by content alone. Do not invent one from `origin` — the extension
 * branch of `classifyContent` would then trust a synthesized path over real content.
 *
 * **Returns a shape, not a type, since 4b.2.** A message the Python probe identifies carries
 * `language: 'python'` as well as `contentType: 'code'`, and both are needed: the tag alone
 * would route it to the TypeScript validator, and the language alone would leave `#` comments
 * being harvested as markdown headings. This is the only place a Gateway item can acquire a
 * language — there is no per-message language field in any provider payload, which is why
 * §29 declined a Gateway *declaration* and why a probe is the only route available here.
 */
function classifyGatewayContent(content: string): ContentShape {
  return classifyContentShape(content, 'text');
}

/**
 * Metadata key marking which slot of the parsed payload an item came from, so egress can put it
 * back where it belongs instead of trusting array position.
 */
const PAYLOAD_SLOT_KEY = 'payloadSlot';

/** The slot name for Anthropic's top-level `system` field, which is not in `messages`. */
const SYSTEM_SLOT = 'system';

/**
 * Flattens a provider message's content to the string the pipeline needs, and records whether
 * anything was lost in doing so.
 *
 * The flattening itself is unavoidable — every stage, validator and estimator downstream reads
 * `item.content` as a string. What was missing is the *record* that it happened: egress wrote
 * the optimized item back as a plain string regardless of what the caller had sent, so a
 * message whose content was `[{"type":"tool_result","tool_use_id":"toolu_01ABC",…}]` could come
 * back as `content: "[TokenDamper Elided: …]"`. The Anthropic Messages API requires a
 * `tool_use` block to be answered by a `tool_result` block carrying the matching
 * `tool_use_id`; a bare string there is a `400 invalid_request_error`, and the same shape
 * breaks OpenAI multimodal content parts (audit C4).
 *
 * `contentShape` travels with the item and `core/elision` refuses to elide anything carrying
 * `'structured'`, so no transform can reach these until a structure-preserving substitution
 * exists.
 */
function flattenMessageContent(content: unknown): { text: string; shape: ContentShapeTag } {
  return typeof content === 'string'
    ? { text: content, shape: 'string' }
    : { text: JSON.stringify(content), shape: 'structured' };
}

/**
 * Indexes the optimized bundle by the payload slot each item was ingested from.
 *
 * Egress used to be `messages.map((msg, idx) => finalBundle.items[idx])` — positional. Ingestion
 * skips falsy entries with `if (!msg) continue;`, so a single hole in `messages` shifted every
 * later item onto the wrong message, silently. Invariant 9 requires this mapping to be faithful,
 * and a filtered push cannot supply the precondition it assumes (audit C4).
 *
 * Keyed on the slot recorded at ingestion, so it survives holes, and would survive a stage that
 * reorders or drops items — which the Gateway's single stage does not do today, but the
 * correspondence should not depend on that.
 */
function indexBySlot(items: ReadonlyArray<ContextItem>): Map<string, ContextItem> {
  const bySlot = new Map<string, ContextItem>();
  for (const item of items) {
    const slot = item.metadata[PAYLOAD_SLOT_KEY];
    if (typeof slot === 'string') {
      bySlot.set(slot, item);
    }
  }
  return bySlot;
}

/**
 * The optimized replacement for a payload slot, or `undefined` to leave the original alone.
 *
 * Returns `undefined` for an unchanged item, for a slot no item claims, and — defensively — for
 * a *structured* item that changed anyway. That last case is unreachable while `core/elision`
 * refuses structured content, and it is written down rather than assumed: if some future
 * transform does change one, the correct behaviour is still to leave the caller's structure
 * intact rather than overwrite it with a string.
 */
function replacementFor(item: ContextItem | undefined, originalText: string): string | undefined {
  if (!item || item.content === originalText) {
    return undefined;
  }
  return item.metadata[CONTENT_SHAPE_METADATA_KEY] === 'structured' ? undefined : item.content;
}

/**
 * Rewrites elided content **inside the caller's own bytes**, instead of re-serializing the
 * payload around it. Audit M7.
 *
 * `JSON.stringify({...parsedPayload, messages})` produces a body that is *equivalent* to the
 * request but is not the request. Measured on a hand-written payload with one elision firing —
 * the only shape the Gateway saves on — the proxy rewrote three fields it had no reason to
 * touch:
 *
 * | client sent | provider received |
 * |---|---|
 * | `"temperature": 1.0` | `"temperature":1` |
 * | `"top_p": 1e3` | `"top_p":1000` |
 * | `"seed": 12345678901234567890` | `"seed":12345678901234567000` |
 *
 * The first two are cosmetic. **The third is a different number**: an integer past 2^53 does not
 * survive `JSON.parse` → `JSON.stringify`, so the provider is asked for a seed the caller never
 * chose. Duplicate keys collapse the same way, and pretty-printing is lost. This is the same
 * re-serialization mechanism the project already identified as the phantom "-1.39%" in the
 * Python harness (Issue 5), reproduced in production code — and it is *not* a metrics bug, which
 * is why fixing it is not the same work as fixing the numbers.
 *
 * ### How a splice can be safe
 *
 * Each entry is located by the **canonical JSON encoding** of the text the parser produced,
 * searched **forward from the previous entry's end**. The cursor is what makes duplicates work,
 * and duplicates are the whole point: `session-dedup` preserves the first copy of a block and
 * elides the later ones, so the encoded text deliberately appears more than once and a global
 * "must be unique" rule would decline every payload the Gateway can actually save on. Walking
 * every message in order — replaced or not — keeps position and identity in agreement.
 *
 * A client that escaped a character differently (`A` for `A`) yields a string equal after
 * parsing but absent from the raw bytes. Then this **declines**: the caller's bytes are
 * forwarded unchanged and the saving is lost.
 *
 * That direction is deliberate and follows invariant 3. Losing a saving costs tokens; corrupting
 * a request field costs correctness, and only one of them is recoverable by the caller.
 */
/** A half-open `[start, end)` range of `rawBody`, holding one JSON value exactly as sent. */
export interface RawSpan {
  readonly start: number;
  readonly end: number;
}

const isWs = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';

function skipWs(source: string, index: number): number {
  let i = index;
  while (i < source.length && isWs(source[i] as string)) i += 1;
  return i;
}

/** Index just past the closing quote of the JSON string starting at `index`, or -1. */
function scanString(source: string, index: number): number {
  let i = index + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    i += 1;
  }
  return -1;
}

/** Index just past the JSON value starting at `index` (leading whitespace skipped), or -1. */
function scanValue(source: string, index: number): number {
  const start = skipWs(source, index);
  const first = source[start];
  if (first === undefined) return -1;
  if (first === '"') return scanString(source, start);

  if (first === '{' || first === '[') {
    // Only the outer bracket type is counted. Inner brackets of the *other* type are balanced
    // within, so they cannot affect this depth, and strings are stepped over whole so a bracket
    // inside one is never seen.
    const close = first === '{' ? '}' : ']';
    let depth = 0;
    let i = start;
    while (i < source.length) {
      const c = source[i] as string;
      if (c === '"') {
        const after = scanString(source, i);
        if (after === -1) return -1;
        i = after;
        continue;
      }
      if (c === first) depth += 1;
      else if (c === close) {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
      i += 1;
    }
    return -1;
  }

  // A primitive: number, `true`, `false`, `null`. Ends at the first structural character.
  let i = start;
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ',' || c === '}' || c === ']' || isWs(c)) break;
    i += 1;
  }
  return i === start ? -1 : i;
}

/** The span of `key`'s value inside the JSON object beginning at `objectStart`, or undefined. */
function findMemberValue(source: string, objectStart: number, key: string): RawSpan | undefined {
  let i = skipWs(source, objectStart);
  if (source[i] !== '{') return undefined;
  i += 1;

  for (;;) {
    i = skipWs(source, i);
    if (source[i] === '}') return undefined;
    if (source[i] !== '"') return undefined;

    const keyEnd = scanString(source, i);
    if (keyEnd === -1) return undefined;
    const name = source.slice(i + 1, keyEnd - 1);

    i = skipWs(source, keyEnd);
    if (source[i] !== ':') return undefined;

    const valueStart = skipWs(source, i + 1);
    const valueEnd = scanValue(source, valueStart);
    if (valueEnd === -1) return undefined;

    if (name === key) return { start: valueStart, end: valueEnd };

    i = skipWs(source, valueEnd);
    if (source[i] === ',') {
      i += 1;
      continue;
    }
    if (source[i] === '}') return undefined;
    return undefined;
  }
}

/**
 * Where each spliceable slot's value actually sits in the caller's bytes — audit OX-H4.
 *
 * The splice used to locate every message by searching for `JSON.stringify(text)`, where `text`
 * came from `flattenMessageContent` — which sends every **non-string** content through
 * `JSON.stringify`. For `content: null` that produces the four-character string `null`, so the
 * search string is `"null"` *with quotes*, which does not occur where the body holds a bare
 * `null`. `spliceIntoRawBody` returns `undefined` on the first miss, so **one unmatchable message
 * discarded the replacements for every other message in the payload.**
 *
 * `content: null` is the standard OpenAI shape for an assistant turn that calls a tool, so
 * essentially every agentic OpenAI conversation carries one. Measured on a payload with a
 * three-times-repeated block that the Gateway does save on: with one such message present, bytes
 * forwarded equalled bytes received exactly — the entire saving, gone. Array content (multimodal
 * parts) failed the same way, which is why this is a span scan rather than the `null` special-case
 * the audit suggested: that would have fixed one shape and left the other.
 *
 * Returning spans instead of search strings removes the question. A span is where the value *is*,
 * so it is correct for every content shape, and duplicate blocks need no cursor to disambiguate.
 *
 * Declines — returns `undefined` — on anything it does not fully understand, and the caller then
 * falls back to the value search. Losing a saving costs tokens; corrupting a request field costs
 * correctness, and only one of those is recoverable by the caller (invariant 3).
 */
export function scanContentSpans(
  rawBody: string,
  options: { readonly includeSystem: boolean },
): ReadonlyArray<RawSpan> | undefined {
  const rootStart = skipWs(rawBody, 0);
  if (rawBody[rootStart] !== '{') return undefined;

  const spans: RawSpan[] = [];

  if (options.includeSystem) {
    const system = findMemberValue(rawBody, rootStart, 'system');
    if (!system) return undefined;
    spans.push(system);
  }

  const messages = findMemberValue(rawBody, rootStart, 'messages');
  if (!messages || rawBody[messages.start] !== '[') return undefined;

  let i = skipWs(rawBody, messages.start + 1);
  if (rawBody[i] === ']') return spans;

  for (;;) {
    const elementStart = skipWs(rawBody, i);
    const elementEnd = scanValue(rawBody, elementStart);
    if (elementEnd === -1) return undefined;

    // A message that is not an object, or carries no `content` key, has no span to splice. The
    // entry list still holds a slot for it, so alignment would break — decline instead.
    const content = findMemberValue(rawBody, elementStart, 'content');
    if (!content) return undefined;
    spans.push(content);

    i = skipWs(rawBody, elementEnd);
    if (rawBody[i] === ',') {
      i += 1;
      continue;
    }
    if (rawBody[i] === ']') return spans;
    return undefined;
  }
}

/**
 * Replaces each entry's value in place, using the span where that value actually sits.
 *
 * No cursor and no searching: a span is a position, so repeated blocks — the case
 * `session-dedup` exists for — need nothing to disambiguate them.
 */
function spliceBySpans(
  rawBody: string,
  entries: ReadonlyArray<{ readonly from: string; readonly to?: string }>,
  spans: ReadonlyArray<RawSpan>,
): string | undefined {
  // Alignment is the whole safety argument: span *k* must be the value that entry *k* describes.
  // Both are built in payload order, but a mismatch would splice a replacement over an unrelated
  // field, so it is checked rather than assumed.
  if (spans.length !== entries.length) return undefined;

  let out = '';
  let cursor = 0;

  for (let k = 0; k < entries.length; k += 1) {
    const entry = entries[k] as { readonly from: string; readonly to?: string };
    const span = spans[k] as RawSpan;
    if (entry.to === undefined) continue;

    // Spans are ascending by construction; a violation means the scan and the entry list
    // disagree about order, and splicing on that would corrupt the payload.
    if (span.start < cursor) return undefined;

    out += rawBody.slice(cursor, span.start) + JSON.stringify(entry.to);
    cursor = span.end;
  }

  return out + rawBody.slice(cursor);
}

function spliceIntoRawBody(
  rawBody: string,
  entries: ReadonlyArray<{ readonly from: string; readonly to?: string }>,
): string | undefined {
  let out = '';
  let cursor = 0;

  for (const entry of entries) {
    const encodedFrom = JSON.stringify(entry.from);
    const at = rawBody.indexOf(encodedFrom, cursor);
    if (at === -1) {
      return undefined;
    }
    out += rawBody.slice(cursor, at) + (entry.to === undefined ? encodedFrom : JSON.stringify(entry.to));
    cursor = at + encodedFrom.length;
  }

  return out + rawBody.slice(cursor);
}

/**
 * The body to forward, given the caller's bytes and the replacements the optimizer produced.
 *
 * Refuses to grow the request. Nothing asserted that before (audit M7's third consequence), and
 * a proxy that makes a request *more* expensive than the one it received has inverted its own
 * purpose — so if the spliced body is not smaller, the caller's bytes go out untouched.
 */
/**
 * What the turn actually cost and saved, measured on the bytes that leave the process.
 *
 * The other half of audit M7. `rawTokens` and `optimizedTokens` came from
 * `summary.tokenEstimate` — a token estimate over the *bundle render*, which is items joined for
 * a human or a model, not the JSON a provider is billed for. Measured on the one payload shape
 * the Gateway saves on, the render reported a **48.5%** saving where the wire saw **47.1%**; the
 * gap is the JSON structural overhead — keys, braces, escaping — that the render never sees and
 * the provider always charges for.
 *
 * Still counted in **tokens**, and still through `estimateBundleTokens`, because a saving
 * denominated in bytes and compared against a budget denominated in tokens is the two-estimator
 * defect DECISIONS §19 exists to prevent. What changes is the artefact measured, not the unit.
 */
function wireTokenMetrics(
  rawBody: string,
  finalBody: string,
): { rawTokens: number; optimizedTokens: number; tokensSaved: number; dedupRatio: number } {
  const asItem = (content: string) => ({ content }) as unknown as ContextItem;
  const rawTokens = estimateBundleTokens([asItem(rawBody)]);
  const optimizedTokens = estimateBundleTokens([asItem(finalBody)]);
  const tokensSaved = Math.max(0, rawTokens - optimizedTokens);

  return {
    rawTokens,
    optimizedTokens,
    tokensSaved,
    dedupRatio: rawTokens > 0 ? tokensSaved / rawTokens : 0,
  };
}

function forwardableBody(
  rawBody: string,
  entries: ReadonlyArray<{ readonly from: string; readonly to?: string }>,
  options: { readonly includeSystem: boolean },
): string {
  if (!entries.some((entry) => entry.to !== undefined)) {
    return rawBody;
  }

  // Spans first, value search second (audit OX-H4). The span scan is correct for every content
  // shape; the value search only works when the content is a string whose canonical encoding
  // happens to be the caller's own bytes. Keeping the search as a fallback means this change can
  // only add savings — a payload the scan declines behaves exactly as it did before.
  const spans = scanContentSpans(rawBody, options);
  const spliced =
    (spans ? spliceBySpans(rawBody, entries, spans) : undefined) ?? spliceIntoRawBody(rawBody, entries);

  if (spliced === undefined || Buffer.byteLength(spliced, 'utf8') >= Buffer.byteLength(rawBody, 'utf8')) {
    return rawBody;
  }
  return spliced;
}

function processOpenAiRequest(
  rawBody: string,
  session: ReturnType<GatewaySessionStore['getOrCreateSession']>,
  options: ProxyHandlerOptions,
): ProxyRequestResult {
  let parsedPayload: OpenAiChatPayload;

  try {
    parsedPayload = JSON.parse(rawBody) as OpenAiChatPayload;
  } catch {
    return {
      statusCode: 400,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid OpenAI JSON payload' }),
      session,
    };
  }

  const items: ContextItem[] = [];

  const messages = parsedPayload.messages || [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    const { text: textContent, shape } = flattenMessageContent(msg.content);
    const kind: ContextItemKind = msg.role === 'system' ? 'prompt' : 'conversation';
    const metadata = freeze({
      messageIndex: i,
      role: msg.role,
      [CONTENT_SHAPE_METADATA_KEY]: shape,
      [PAYLOAD_SLOT_KEY]: `messages[${i}]`,
    });

    const contentHash = hashContent({
      role: msg.role,
      content: textContent,
    });

    items.push(
      createContextItem({
        id: `msg-${i}-${contentHash.slice(0, 8)}`,
        kind,
        // Classified, not hardcoded — see the note above `classifyGatewayContent`.
        ...classifyGatewayContent(textContent),
        content: textContent,
        origin: `openai:messages[${i}]`,
        contentHash,
        role: msg.role,
        metadata,
      }),
    );
  }

  // Derived from the items rather than hand-rolled. The previous literal asserted
  // `text: items.length`, which was only ever consistent with the hardcoded tag it
  // accompanied; with items now classified it would be a second, contradicting answer.
  const statistics = createBundleStatistics(items);

  const bundleHash = hashContent({ items: items.map((i) => i.contentHash) });
  const initialBundle: ContextBundle = freeze({
    id: bundleHash,
    bundleId: bundleHash,
    source: 'text',
    items: freeze(items),
    summary: freeze({
      itemCount: items.length,
      // `estimateBundleTokens`, not `ceil(totalCharacters / 4)`. The latter omits the
      // N-1 newlines the bundle render inserts between items, so the input side counted
      // a different string than every stage's output side measured.
      tokenEstimate: estimateBundleTokens(items),
      preview: rawBody.slice(0, 80),
    }),
    statistics: freeze(statistics),
    contentHash: bundleHash,
  });
  const contentEntries: SessionContentEntry[] = items.map((item) => ({
    hash: item.contentHash,
    content: item.content,
  }));

  const outcome = runGatewayOptimization(rawBody, initialBundle, session, options);

  const bySlot = indexBySlot(outcome.finalBundle.items);
  // Every message, in payload order — not only the changed ones. The splice walks a forward
  // cursor, so an unchanged message still has to be stepped over for the next one to be found
  // at the right occurrence (audit M7).
  const entries = messages.map((msg, idx) => {
    const original = msg ? flattenMessageContent(msg.content).text : '';
    const replacement = msg ? replacementFor(bySlot.get(`messages[${idx}]`), original) : undefined;
    return replacement === undefined ? { from: original } : { from: original, to: replacement };
  });

  // Spliced into the caller's bytes rather than re-serialized around them (audit M7).
  const finalBody = forwardableBody(rawBody, entries, { includeSystem: false });

  options.sessionStore.recordTurn(
    session.sessionId,
    {
      ...wireTokenMetrics(rawBody, finalBody),
      fallbackUsed: outcome.fallbackUsed,
    },
    contentEntries,
  );

  return {
    statusCode: 200,
    headers: localResponseHeaders(),
    body: finalBody,
    session,
  };
}

function processAnthropicRequest(
  rawBody: string,
  session: ReturnType<GatewaySessionStore['getOrCreateSession']>,
  options: ProxyHandlerOptions,
): ProxyRequestResult {
  let parsedPayload: AnthropicMessagesPayload;

  try {
    parsedPayload = JSON.parse(rawBody) as AnthropicMessagesPayload;
  } catch {
    return {
      statusCode: 400,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid Anthropic JSON payload' }),
      session,
    };
  }

  const items: ContextItem[] = [];

  if (parsedPayload.system) {
    const { text: systemText, shape } = flattenMessageContent(parsedPayload.system);
    const contentHash = hashContent({ role: 'system', content: systemText });
    items.push(
      createContextItem({
        id: `sys-${contentHash.slice(0, 8)}`,
        kind: 'prompt',
        ...classifyGatewayContent(systemText),
        content: systemText,
        origin: 'anthropic:system',
        contentHash,
        role: 'system',
        metadata: freeze({
          role: 'system',
          [CONTENT_SHAPE_METADATA_KEY]: shape,
          [PAYLOAD_SLOT_KEY]: SYSTEM_SLOT,
        }),
      }),
    );
  }

  const messages = parsedPayload.messages || [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    const { text: textContent, shape } = flattenMessageContent(msg.content);
    const contentHash = hashContent({ role: msg.role, content: textContent });

    items.push(
      createContextItem({
        id: `msg-${i}-${contentHash.slice(0, 8)}`,
        kind: 'conversation',
        ...classifyGatewayContent(textContent),
        content: textContent,
        origin: `anthropic:messages[${i}]`,
        contentHash,
        role: msg.role,
        metadata: freeze({
          messageIndex: i,
          role: msg.role,
          [CONTENT_SHAPE_METADATA_KEY]: shape,
          [PAYLOAD_SLOT_KEY]: `messages[${i}]`,
        }),
      }),
    );
  }

  const statistics = createBundleStatistics(items);

  const bundleHash = hashContent({ items: items.map((i) => i.contentHash) });
  const initialBundle: ContextBundle = freeze({
    id: bundleHash,
    bundleId: bundleHash,
    source: 'text',
    items: freeze(items),
    summary: freeze({
      itemCount: items.length,
      // `estimateBundleTokens`, not `ceil(totalCharacters / 4)`. The latter omits the
      // N-1 newlines the bundle render inserts between items, so the input side counted
      // a different string than every stage's output side measured.
      tokenEstimate: estimateBundleTokens(items),
      preview: rawBody.slice(0, 80),
    }),
    statistics: freeze(statistics),
    contentHash: bundleHash,
  });
  const contentEntries: SessionContentEntry[] = items.map((item) => ({
    hash: item.contentHash,
    content: item.content,
  }));

  const outcome = runGatewayOptimization(rawBody, initialBundle, session, options);

  const bySlot = indexBySlot(outcome.finalBundle.items);
  // Every message, in payload order — see the OpenAI path: the splice walks a forward cursor.
  const entries: Array<{ from: string; to?: string }> = [];

  // The system prompt is mapped back too.
  //
  // It was ingested as `items[0]` and the egress map started at `itemOffset`, so a change to it
  // was silently dropped from `finalBody` — while `optimizedTokens`, and therefore the reported
  // `tokensSaved` and `dedupRatio`, still counted it as saved. The turn's metrics described a
  // saving that never reached the wire (audit C4).
  //
  // `system` is listed first because Anthropic payloads carry it ahead of `messages`. If a
  // caller orders it the other way the forward cursor will not find the messages after it, the
  // splice declines, and the caller's bytes go out unchanged — a lost saving, not a corruption.
  if (parsedPayload.system) {
    const originalSystem = flattenMessageContent(parsedPayload.system).text;
    const updatedSystem = replacementFor(bySlot.get(SYSTEM_SLOT), originalSystem);
    entries.push(updatedSystem === undefined ? { from: originalSystem } : { from: originalSystem, to: updatedSystem });
  }

  messages.forEach((msg, idx) => {
    const original = msg ? flattenMessageContent(msg.content).text : '';
    const replacement = msg ? replacementFor(bySlot.get(`messages[${idx}]`), original) : undefined;
    entries.push(replacement === undefined ? { from: original } : { from: original, to: replacement });
  });

  // Spliced into the caller's bytes rather than re-serialized around them (audit M7).
  const finalBody = forwardableBody(rawBody, entries, { includeSystem: Boolean(parsedPayload.system) });

  options.sessionStore.recordTurn(
    session.sessionId,
    {
      ...wireTokenMetrics(rawBody, finalBody),
      fallbackUsed: outcome.fallbackUsed,
    },
    contentEntries,
  );

  return {
    statusCode: 200,
    headers: localResponseHeaders(),
    body: finalBody,
    session,
  };
}
