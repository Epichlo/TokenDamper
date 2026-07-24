import { randomUUID } from 'node:crypto';
import type {
  ContextBundle,
  ContextItem,
  OptimizationRequest,
  OptimizationResult,
  ResolvedConfig,
} from '../../core/model';

/**
 * The adapter name used by the frozen Milestone 1 CLI integration.
 */
export const CLI_ADAPTER_NAME = 'cli';

/**
 * The adapter version used by the frozen Milestone 1 CLI integration.
 */
export const CLI_ADAPTER_VERSION = '0.1.0';

/**
 * Parses raw text input into the normalized optimization request contract.
 */
export function parse(
  rawInput: string,
  config: ResolvedConfig,
  options: { readonly requestId?: string; readonly sourcePath?: string } = {},
): OptimizationRequest {
  const requestId = options.requestId ?? randomUUID();
  const bundle = createBundle(rawInput, options.sourcePath);

  return {
    requestId,
    rawInput,
    bundle,
    budget: config.budget,
    config,
    adapterName: CLI_ADAPTER_NAME,
    adapterVersion: CLI_ADAPTER_VERSION,
  };
}

/**
 * Formats the engine result into the final CLI output string.
 */
export function format(result: OptimizationResult): string {
  return result.emittedOutput;
}

function createBundle(rawInput: string, sourcePath?: string): ContextBundle {
  const item: ContextItem = {
    itemId: 'context-0',
    kind: sourcePath ? 'file' : 'prompt',
    content: rawInput,
    origin: sourcePath ?? CLI_ADAPTER_NAME,
    metadata: {},
    ...(sourcePath ? { path: sourcePath } : {}),
  };

  return {
    bundleId: randomUUID(),
    source: 'cli',
    items: [item],
    summary: {
      itemCount: 1,
      tokenEstimate: estimateTokens(rawInput),
      preview: rawInput.slice(0, 80),
    },
    contentHash: createContentHash(rawInput),
  };
}

function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  return Math.max(1, Math.ceil(text.length / 4));
}

function createContentHash(text: string): string {
  let hash = 0;

  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }

  return hash.toString(16).padStart(8, '0');
}
