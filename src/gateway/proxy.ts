import type { IncomingHttpHeaders } from 'node:http';
import { loadConfig } from '../config';
import { createContextItem, createOptimizationBudget, freeze, hashContent } from '../core/model/constructors';
import type { ContextBundle, ContextItem, ContextItemKind } from '../core/model/types';
import { runSessionDedupStage } from '../stages/cleanup/session-dedup';
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
        contentType: 'text',
        content: textContent,
        origin: `openai:messages[${i}]`,
        contentHash,
        role: msg.role,
        metadata,
      }),
    );
  }

  const config = loadConfig();
  const budget = createOptimizationBudget(config.budget);

  const statistics = {
    itemCount: items.length,
    contentTypeCounts: { text: items.length, markdown: 0, code: 0, html: 0, json: 0, yaml: 0, logs: 0, unknown: 0 },
    kindCounts: { prompt: items.filter((i) => i.kind === 'prompt').length, file: 0, diff: 0, conversation: items.filter((i) => i.kind === 'conversation').length, note: 0 },
    totalCharacters: items.reduce((acc, curr) => acc + curr.content.length, 0),
  };

  const bundleHash = hashContent({ items: items.map((i) => i.contentHash) });
  const initialBundle: ContextBundle = freeze({
    id: bundleHash,
    bundleId: bundleHash,
    source: 'text',
    items: freeze(items),
    summary: freeze({
      itemCount: items.length,
      tokenEstimate: Math.ceil(statistics.totalCharacters / 4),
      preview: rawBody.slice(0, 80),
    }),
    statistics: freeze(statistics),
    contentHash: bundleHash,
  });
  const contentEntries: SessionContentEntry[] = items.map((item) => ({
    hash: item.contentHash,
    content: item.content,
  }));

  const stageResult = runSessionDedupStage(initialBundle, budget, {
    previousBlockHashes: session.seenBlockHashes,
    storeContent: (hash, content) => options.sessionStore.storeContent(session.sessionId, hash, content),
    getContent: (hashOrRef) => options.sessionStore.getContent(session.sessionId, hashOrRef),
  });

  let finalBody = rawBody;
  if (stageResult.changed) {
    const updatedMessages = messages.map((msg, idx) => {
      const updatedItem = stageResult.bundle.items[idx];
      if (updatedItem && msg && updatedItem.content !== (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content))) {
        return {
          ...msg,
          content: updatedItem.content,
        };
      }
      return msg;
    });

    finalBody = JSON.stringify({
      ...parsedPayload,
      messages: updatedMessages,
    });
  }

  const rawTokens = initialBundle.summary.tokenEstimate;
  const optimizedTokens = stageResult.bundle.summary.tokenEstimate;

  options.sessionStore.recordTurn(
    session.sessionId,
    {
      rawTokens,
      optimizedTokens,
      tokensSaved: stageResult.metrics.tokenEstimateSaved || 0,
      dedupRatio: rawTokens > 0 ? (stageResult.metrics.tokenEstimateSaved || 0) / rawTokens : 0,
      fallbackUsed: false,
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
        contentType: 'text',
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
        contentType: 'text',
        content: textContent,
        origin: `anthropic:messages[${i}]`,
        contentHash,
        role: msg.role,
        metadata: freeze({ messageIndex: i, role: msg.role }),
      }),
    );
  }

  const config = loadConfig();
  const budget = createOptimizationBudget(config.budget);

  const statistics = {
    itemCount: items.length,
    contentTypeCounts: { text: items.length, markdown: 0, code: 0, html: 0, json: 0, yaml: 0, logs: 0, unknown: 0 },
    kindCounts: { prompt: items.filter((i) => i.kind === 'prompt').length, file: 0, diff: 0, conversation: items.filter((i) => i.kind === 'conversation').length, note: 0 },
    totalCharacters: items.reduce((acc, curr) => acc + curr.content.length, 0),
  };

  const bundleHash = hashContent({ items: items.map((i) => i.contentHash) });
  const initialBundle: ContextBundle = freeze({
    id: bundleHash,
    bundleId: bundleHash,
    source: 'text',
    items: freeze(items),
    summary: freeze({
      itemCount: items.length,
      tokenEstimate: Math.ceil(statistics.totalCharacters / 4),
      preview: rawBody.slice(0, 80),
    }),
    statistics: freeze(statistics),
    contentHash: bundleHash,
  });
  const contentEntries: SessionContentEntry[] = items.map((item) => ({
    hash: item.contentHash,
    content: item.content,
  }));

  const stageResult = runSessionDedupStage(initialBundle, budget, {
    previousBlockHashes: session.seenBlockHashes,
    storeContent: (hash, content) => options.sessionStore.storeContent(session.sessionId, hash, content),
    getContent: (hashOrRef) => options.sessionStore.getContent(session.sessionId, hashOrRef),
  });

  let finalBody = rawBody;
  if (stageResult.changed) {
    const itemOffset = parsedPayload.system ? 1 : 0;
    const updatedMessages = messages.map((msg, idx) => {
      const updatedItem = stageResult.bundle.items[idx + itemOffset];
      if (updatedItem && msg && updatedItem.content !== (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content))) {
        return {
          ...msg,
          content: updatedItem.content,
        };
      }
      return msg;
    });

    finalBody = JSON.stringify({
      ...parsedPayload,
      messages: updatedMessages,
    });
  }

  const rawTokens = initialBundle.summary.tokenEstimate;
  const optimizedTokens = stageResult.bundle.summary.tokenEstimate;

  options.sessionStore.recordTurn(
    session.sessionId,
    {
      rawTokens,
      optimizedTokens,
      tokensSaved: stageResult.metrics.tokenEstimateSaved || 0,
      dedupRatio: rawTokens > 0 ? (stageResult.metrics.tokenEstimateSaved || 0) / rawTokens : 0,
      fallbackUsed: false,
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
