import type { IncomingHttpHeaders } from 'node:http';
import { loadConfig } from '../config';
import { createContextItem, createOptimizationBudget, freeze, hashContent } from '../core/model/constructors';
import type { ContextBundle, ContextItem, ContextItemKind } from '../core/model/types';
import { runSessionDedupStage } from '../stages/cleanup/session-dedup';
import { GatewaySessionStore } from './session-store';
import type { AnthropicMessagesPayload, OpenAiChatPayload, ProxyHandlerOptions, ProxyRequestResult } from './types';

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
  const sessionId = getSessionIdFromHeaders(headers, rawBody);
  const session = options.sessionStore.getOrCreateSession(sessionId);

  const cleanHeaders: Record<string, string> = {};
  for (const [key, val] of Object.entries(headers)) {
    if (val !== undefined && key.toLowerCase() !== 'host' && key.toLowerCase() !== 'content-length') {
      cleanHeaders[key] = Array.isArray(val) ? val.join(', ') : val;
    }
  }

  // Handle OpenAI API endpoint
  if (urlPath === '/v1/chat/completions') {
    return processOpenAiRequest(rawBody, cleanHeaders, session, options);
  }

  // Handle Anthropic API endpoint
  if (urlPath === '/v1/messages') {
    return processAnthropicRequest(rawBody, cleanHeaders, session, options);
  }

  // Fallback pass-through for unknown endpoints
  return {
    statusCode: 404,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: `Unknown gateway endpoint: ${urlPath}` }),
    session,
  };
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
  const itemHashes: string[] = [];

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

    itemHashes.push(contentHash);

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

  const stageResult = runSessionDedupStage(initialBundle, budget, {
    previousBlockHashes: session.seenBlockHashes,
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
    itemHashes,
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
  const itemHashes: string[] = [];

  if (parsedPayload.system) {
    const systemText = typeof parsedPayload.system === 'string' ? parsedPayload.system : JSON.stringify(parsedPayload.system);
    const contentHash = hashContent({ role: 'system', content: systemText });
    itemHashes.push(contentHash);
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
    itemHashes.push(contentHash);

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

  const stageResult = runSessionDedupStage(initialBundle, budget, {
    previousBlockHashes: session.seenBlockHashes,
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
    itemHashes,
  );

  return {
    statusCode: 200,
    headers: { ...headers, 'content-type': 'application/json' },
    body: finalBody,
    session,
  };
}
