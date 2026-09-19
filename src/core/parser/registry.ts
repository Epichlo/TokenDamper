import type { ParserAdapter } from './types';

/**
 * The parser backends registered for this process, keyed by lower-cased language.
 *
 * Module-level and mutable, which is the same shape `DEFAULT_TOKENIZER` has and for the same
 * reason: a backend is a process-wide capability, not per-request state. Registration is the
 * one place async setup is allowed (`ParserAdapter` is otherwise sync), so it happens once at
 * startup and the pipeline sees a populated map or an empty one.
 *
 * **An empty map is the shipped configuration.** Nothing in core registers anything, and
 * `fast` mode never reads this at all.
 */
const backends = new Map<string, ParserAdapter>();

/**
 * Registers a backend for its declared language, replacing any previous one.
 *
 * Replacement rather than refusal because registration is startup wiring: a host that loads
 * a newer backend over an older one is configuring itself, not making an error, and throwing
 * here would sit upstream of the fail-open path for no safety gain.
 */
export function registerParserBackend(adapter: ParserAdapter): void {
  backends.set(adapter.language.toLowerCase(), adapter);
}

/**
 * The backend covering `language`, or `undefined`.
 *
 * Case-insensitive because `selectValidator` already lower-cases `item.language` before
 * dispatching, and a registry that disagreed with it about `TypeScript` vs `typescript`
 * would make Deep silently fall back to Fast — a green result from a path that never ran.
 */
export function resolveParserBackend(language: string): ParserAdapter | undefined {
  return backends.get(language.toLowerCase());
}

/**
 * The languages currently covered, sorted.
 *
 * Sorted because this feeds reporting, and an insertion-ordered list would make two runs
 * that registered the same backends in a different order look like different configurations.
 */
export function registeredParserLanguages(): ReadonlyArray<string> {
  return Object.freeze([...backends.keys()].sort());
}

/**
 * Empties the registry.
 *
 * Exists for tests, which must not leak a backend into a later file's `fast`-mode
 * assertions, and for a host reconfiguring itself. It is not a pipeline operation.
 */
export function clearParserBackends(): void {
  backends.clear();
}
