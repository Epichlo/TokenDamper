import type { ContextBundle, ParserCoverage } from '../model/types';
import { selectValidator } from '../validation/ast';
import { registeredParserLanguages, resolveParserBackend } from './registry';
import type { EngineMode } from './types';

/**
 * Computed from the *Fast-resolved* language, which is the same key `selectValidator` uses to
 * find a backend — so a language with no registered backend is reported as answered by Fast
 * rather than silently counted as covered.
 */
export function parserCoverage(bundle: ContextBundle, mode: EngineMode): ParserCoverage {
  let backendAnswered = 0;
  let fastAnswered = 0;

  for (const item of bundle.items) {
    const language = selectValidator(item, 'fast')?.language;
    const covered = mode === 'deep' && language !== undefined && resolveParserBackend(language) !== undefined;
    if (covered) backendAnswered += 1;
    else fastAnswered += 1;
  }

  return Object.freeze({
    mode,
    registeredLanguages: registeredParserLanguages(),
    backendAnswered,
    fastAnswered,
  });
}
