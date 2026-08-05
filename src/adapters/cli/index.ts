import { randomUUID } from 'node:crypto';
import type {
  OptimizationRequest,
  OptimizationResult,
  ResolvedConfig,
} from '../../core/model';
import { createOptimizationRequest, type NormalizedInputSource } from '../../core/model';
import { TOKENDAMPER_VERSION } from '../../version';

/**
 * The adapter name used by the frozen Milestone 1 CLI integration.
 */
export const CLI_ADAPTER_NAME = 'cli';

/**
 * The adapter version used by the frozen Milestone 1 CLI integration.
 */
export const CLI_ADAPTER_VERSION = TOKENDAMPER_VERSION;

/**
 * Parses raw text input into the normalized optimization request contract.
 */
export function parse(
  rawInput: string,
  config: ResolvedConfig,
  options: {
    readonly requestId?: string;
    readonly sourceKind?: NormalizedInputSource;
    readonly sourcePath?: string;
    /** `--language`. Canonicalized by `createContextBundle`; see its precedence note. */
    readonly language?: string;
  } = {},
): OptimizationRequest {
  const requestId = options.requestId ?? randomUUID();
  return createOptimizationRequest(rawInput, config, {
    requestId,
    adapterName: CLI_ADAPTER_NAME,
    adapterVersion: CLI_ADAPTER_VERSION,
    source: options.sourceKind ?? (options.sourcePath ? 'file' : 'text'),
    ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
    ...(options.language ? { language: options.language } : {}),
  });
}

/**
 * Formats the engine result into the final CLI output string.
 */
export function format(result: OptimizationResult): string {
  return result.emittedOutput;
}
