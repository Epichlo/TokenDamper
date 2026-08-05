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
import { estimateBundleTokens } from '../core/hashing/tokenizer';
import { ConfidenceLedger } from '../core/ledger/confidence-ledger';
import { TOKENDAMPER_VERSION } from '../version';
import { GatewaySessionStore } from './session-store';
import type { AnthropicMessagesPayload, OpenAiChatPayload, ProxyHandlerOptions, ProxyRequestResult, SessionContentEntry } from './types';

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
    const optimized = processOpenAiRequest(rawBody, cleanHeaders, session, options);
    if (optimized.statusCode !== 200 || shouldUseMockUpstream()) {
      return optimized;
    }
    if (!hasAuthHeaders(cleanHeaders)) {
      if (process.env.NODE_ENV === 'test') {
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
      incomingHeaders: cleanHeaders,
      streamRequested: isStreamRequested(optimized.body),
      session: optimized.session,
      options,
    });
  }

  // Handle Anthropic API endpoint
  if (routePath === '/v1/messages') {
    const optimized = processAnthropicRequest(rawBody, cleanHeaders, session, options);
    if (optimized.statusCode !== 200 || shouldUseMockUpstream()) {
      return optimized;
    }
    if (!hasAuthHeaders(cleanHeaders)) {
      if (process.env.NODE_ENV === 'test') {
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
      body: params.body,
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

function shouldUseMockUpstream(): boolean {
  return process.env.TOKENDAMPER_MOCK_UPSTREAM === 'true';
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

interface GatewayOptimizationOutcome {
  readonly finalBundle: ContextBundle;
  readonly fallbackUsed: boolean;
  readonly rawTokens: number;
  readonly optimizedTokens: number;
  readonly tokensSaved: number;
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
  // blocker on widening this list. See docs/phase-1-stabilization-summary.md (§5.3, §7).
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

  const rawTokens = initialBundle.summary.tokenEstimate;
  const optimizedTokens = result.finalBundle.summary.tokenEstimate;

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
    rawTokens,
    optimizedTokens,
    tokensSaved: Math.max(0, rawTokens - optimizedTokens),
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
 * `docs/issue-2-content-type-contract-design.md` §2.2.
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

function processOpenAiRequest(
  rawBody: string,
  headers: Record<string, string>,
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

    const textContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    const kind: ContextItemKind = msg.role === 'system' ? 'prompt' : 'conversation';
    const metadata = freeze({
      messageIndex: i,
      role: msg.role,
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

  let finalBody = rawBody;
  const updatedMessages = messages.map((msg, idx) => {
    const updatedItem = outcome.finalBundle.items[idx];
    if (updatedItem && msg && updatedItem.content !== (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content))) {
      return {
        ...msg,
        content: updatedItem.content,
      };
    }
    return msg;
  });

  if (updatedMessages.some((msg, idx) => msg !== messages[idx])) {
    finalBody = JSON.stringify({
      ...parsedPayload,
      messages: updatedMessages,
    });
  }

  options.sessionStore.recordTurn(
    session.sessionId,
    {
      rawTokens: outcome.rawTokens,
      optimizedTokens: outcome.optimizedTokens,
      tokensSaved: outcome.tokensSaved,
      dedupRatio: outcome.rawTokens > 0 ? outcome.tokensSaved / outcome.rawTokens : 0,
      fallbackUsed: outcome.fallbackUsed,
    },
    contentEntries,
  );

  return {
    statusCode: 200,
    headers: { ...headers, 'content-type': 'application/json' },
    body: finalBody,
    session,
  };
}

function processAnthropicRequest(
  rawBody: string,
  headers: Record<string, string>,
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
    const systemText = typeof parsedPayload.system === 'string' ? parsedPayload.system : JSON.stringify(parsedPayload.system);
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
        metadata: freeze({ role: 'system' }),
      }),
    );
  }

  const messages = parsedPayload.messages || [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    const textContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
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
        metadata: freeze({ messageIndex: i, role: msg.role }),
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

  let finalBody = rawBody;
  const itemOffset = parsedPayload.system ? 1 : 0;
  const updatedMessages = messages.map((msg, idx) => {
    const updatedItem = outcome.finalBundle.items[idx + itemOffset];
    if (updatedItem && msg && updatedItem.content !== (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content))) {
      return {
        ...msg,
        content: updatedItem.content,
      };
    }
    return msg;
  });

  if (updatedMessages.some((msg, idx) => msg !== messages[idx])) {
    finalBody = JSON.stringify({
      ...parsedPayload,
      messages: updatedMessages,
    });
  }

  options.sessionStore.recordTurn(
    session.sessionId,
    {
      rawTokens: outcome.rawTokens,
      optimizedTokens: outcome.optimizedTokens,
      tokensSaved: outcome.tokensSaved,
      dedupRatio: outcome.rawTokens > 0 ? outcome.tokensSaved / outcome.rawTokens : 0,
      fallbackUsed: outcome.fallbackUsed,
    },
    contentEntries,
  );

  return {
    statusCode: 200,
    headers: { ...headers, 'content-type': 'application/json' },
    body: finalBody,
    session,
  };
}
