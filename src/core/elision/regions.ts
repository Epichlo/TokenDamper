import type { ContextItem } from '../model/types';
import { selectValidator } from '../validation/ast';
import { ELISION_MARKER_BYTES } from './marker';

/**
 * A half-open byte range within `item.content` that may be replaced by an elision marker.
 */
export interface ElisionRegion {
  readonly start: number;
  readonly end: number;
}

/**
 * The byte budget a marker occupies. A region smaller than this cannot save anything.
 *
 * Re-exported from `ELISION_MARKER_BYTES` under its historical name. It used to be the
 * fixed width of `<BLOCK_HASH:` + 64 hex + `>`; markers are now variable-length and
 * self-describing, and 80 is the derived budget for the size range where the question is
 * close (see `marker.ts`).
 *
 * This is a pre-filter, not a correctness dependency: `elideRegions` measures the actual
 * rendered replacement against the actual region and refuses any that does not shrink. If
 * the marker format changes, this constant becomes merely a worse heuristic rather than a
 * source of growth.
 */
export const BLOCK_PLACEHOLDER_BYTES = ELISION_MARKER_BYTES;

/**
 * Default floor for an eligible region. The margin over the placeholder exists so a region
 * has to be worth the semantic risk, not merely break even on bytes.
 */
export const MIN_REGION_BYTES = BLOCK_PLACEHOLDER_BYTES + 24;

interface BraceSpan {
  readonly start: number;
  readonly end: number;
  readonly header: string;
}

/**
 * A header that introduces a function body: it ends with a parameter list, optionally
 * followed by a return-type annotation, or it is an arrow.
 *
 * Shape-based rather than keyword-based, so it catches functions, methods, constructors,
 * getters, setters and arrows without enumerating modifiers — and, importantly, does *not*
 * match a `class`/`interface`/`enum` header, which has no parameter list. That distinction
 * is the whole point: eliding a class body destroys every method signature inside it, which
 * is exactly the symbol loss the drift gate refuses.
 */
const FUNCTION_HEADER = /\)\s*(?::\s*[^{;=]+)?$|=>$/;

/**
 * Control-flow headers also end in `)`, so the shape test alone would match them.
 *
 * Excluding them costs nothing measurable — a control-flow block sits *inside* a function
 * body, so eliding the enclosing body already subsumes it — and it keeps the rule honest
 * about what it claims to select.
 */
const CONTROL_FLOW_HEADER = /\b(?:if|for|while|switch|catch|do|else)\s*\(/;

/**
 * Scans TypeScript/JavaScript for brace spans, tracking the lexical states in which a brace
 * does not mean a brace.
 *
 * Regex literals are tracked here even though `TypeScriptValidator` does not track them.
 * That is deliberate and load-bearing: the validator's blind spot makes it *reject* code
 * containing `/\(/`-style literals, so it cannot be relied on to catch a region boundary
 * this scanner got wrong inside one. Getting the boundary right is this function's job.
 */
function scanBraceSpans(content: string): ReadonlyArray<BraceSpan> {
  const spans: BraceSpan[] = [];
  const stack: number[] = [];
  let quote: string | null = null;
  let comment: '//' | '/*' | null = null;
  let inRegex = false;
  // Last significant character, used to disambiguate `/` as regex-start vs. division.
  let prevSignificant = '';

  for (let i = 0; i < content.length; i++) {
    const char = content[i]!;

    if (comment === '//') {
      if (char === '\n') comment = null;
      continue;
    }
    if (comment === '/*') {
      if (char === '*' && content[i + 1] === '/') {
        comment = null;
        i++;
      }
      continue;
    }
    if (inRegex) {
      if (char === '\\') {
        i++;
      } else if (char === '/') {
        inRegex = false;
        prevSignificant = '/';
      } else if (char === '\n') {
        // An unterminated regex literal is not a regex; bail out rather than swallow code.
        inRegex = false;
      }
      continue;
    }
    if (quote !== null) {
      if (char === '\\') {
        i++;
      } else if (char === quote) {
        quote = null;
        prevSignificant = char;
      }
      continue;
    }

    if (char === '/' && content[i + 1] === '/') {
      comment = '//';
      i++;
      continue;
    }
    if (char === '/' && content[i + 1] === '*') {
      comment = '/*';
      i++;
      continue;
    }
    if (char === '/') {
      // A `/` begins a regex only where a value may begin. After an identifier, a literal
      // or a closing bracket it is division.
      if (prevSignificant === '' || '(,=:[!&|?{};+-*%~^<>'.includes(prevSignificant)) {
        inRegex = true;
        continue;
      }
      prevSignificant = char;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') {
      stack.push(i);
      prevSignificant = char;
      continue;
    }
    if (char === '}') {
      const open = stack.pop();
      prevSignificant = char;
      if (open === undefined) {
        continue;
      }
      const headerStart = content.lastIndexOf('\n', open) + 1;
      spans.push({ start: open + 1, end: i, header: content.slice(headerStart, open).trim() });
      continue;
    }

    if (!/\s/.test(char)) {
      prevSignificant = char;
    }
  }

  return spans;
}

/**
 * Finds the body block under each Python `def` header.
 *
 * `class` headers are deliberately not included: a class block contains its methods' `def`
 * lines, so eliding it destroys their signatures — the same loss the TypeScript rule avoids
 * by refusing class bodies.
 *
 * The returned region begins **after** the first body line's indentation. That is not a
 * detail: the marker has to inherit that column or `PythonValidator` reports
 * `AST_INDENTATION_ERROR`, and the indentation has to stay outside the hashed bytes or the
 * rehydrated text is not byte-identical. Those two requirements are only jointly satisfiable
 * at this boundary.
 */
function scanPythonDefBodies(content: string): ReadonlyArray<ElisionRegion> {
  const regions: ElisionRegion[] = [];
  const lineStarts: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') lineStarts.push(i + 1);
  }

  const lineAt = (index: number): { text: string; start: number; end: number } => {
    const start = lineStarts[index]!;
    const next = lineStarts[index + 1];
    const end = next === undefined ? content.length : next - 1;
    return { text: content.slice(start, end), start, end };
  };

  const indentOf = (text: string): number => text.length - text.trimStart().length;

  for (let i = 0; i < lineStarts.length; i++) {
    const line = lineAt(i);
    const stripped = line.text.replace(/\r$/, '');
    if (!/^\s*def\s.*:\s*$/.test(stripped)) {
      continue;
    }
    const headIndent = indentOf(stripped);

    let last = i;
    for (let j = i + 1; j < lineStarts.length; j++) {
      const candidate = lineAt(j).text.replace(/\r$/, '');
      if (candidate.trim().length === 0) {
        continue;
      }
      if (indentOf(candidate) <= headIndent) {
        break;
      }
      last = j;
    }
    if (last === i) {
      continue;
    }

    const firstBody = lineAt(i + 1);
    const bodyIndent = indentOf(firstBody.text.replace(/\r$/, ''));
    regions.push({ start: firstBody.start + bodyIndent, end: lineAt(last).end });
  }

  return regions;
}

/**
 * Drops regions that overlap an earlier one, keeping the outer/earlier region.
 *
 * A nested function body is therefore subsumed by its enclosing body rather than elided
 * twice, and the result is a disjoint ascending list — the shape `elideRegions` requires.
 */
function dropOverlapping(regions: ReadonlyArray<ElisionRegion>): ElisionRegion[] {
  const sorted = [...regions].sort((a, b) => (a.start - b.start) || (b.end - a.end));
  const kept: ElisionRegion[] = [];
  let cursor = -1;
  for (const region of sorted) {
    if (region.start < cursor) {
      continue;
    }
    kept.push(region);
    cursor = region.end;
  }
  return kept;
}

/**
 * Whether a region contains anything other than comments, string literals and whitespace.
 *
 * **This is the Phase 1d precondition (design §8, option b), and it is the only thing
 * standing between this stage and a measured failure.** `HumanEval/0` elides to a 55.66%
 * reduction with `S_k = 0.0000`, AST-valid and byte-reversible — and the region removed is
 * the function's docstring, which is the entire specification of the task. Drift scores it
 * perfect because docstrings contain no symbols, and `R_struct` is a constant for code
 * (DECISIONS.md §18), so nothing in the metric notices.
 *
 * Be precise about what this buys: it defends against **that case**, not against the class.
 * Any other high-information symbol-free content — a SQL literal, a config block, a worked
 * example — is still invisible to the drift metric. The real fix is making `R_struct` do
 * work for code; this is the guard that makes shipping possible before that lands.
 */
export function isSubstantiveRegion(text: string, language: 'typescript' | 'python'): boolean {
  const stripped = language === 'python' ? stripPython(text) : stripTypeScript(text);
  return /\S/.test(stripped);
}

function stripTypeScript(text: string): string {
  let out = '';
  let quote: string | null = null;
  let comment: '//' | '/*' | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (comment === '//') {
      if (char === '\n') {
        comment = null;
        out += char;
      }
      continue;
    }
    if (comment === '/*') {
      if (char === '*' && text[i + 1] === '/') {
        comment = null;
        i++;
      }
      continue;
    }
    if (quote !== null) {
      if (char === '\\') i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && text[i + 1] === '/') {
      comment = '//';
      i++;
      continue;
    }
    if (char === '/' && text[i + 1] === '*') {
      comment = '/*';
      i++;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    out += char;
  }
  return out;
}

function stripPython(text: string): string {
  let out = '';
  let quote: string | null = null;
  let comment = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (comment) {
      if (char === '\n') {
        comment = false;
        out += char;
      }
      continue;
    }
    if (quote !== null) {
      if (char === '\\') {
        i++;
        continue;
      }
      if (text.startsWith(quote, i)) {
        i += quote.length - 1;
        quote = null;
      }
      continue;
    }
    if (char === '#') {
      comment = true;
      continue;
    }
    if (char === '"' || char === "'") {
      const triple = text.slice(i, i + 3);
      if (triple === '"""' || triple === "'''") {
        quote = triple;
        i += 2;
      } else {
        quote = char;
      }
      continue;
    }
    out += char;
  }
  return out;
}

export interface SelectRegionsOptions {
  readonly minRegionBytes?: number;
}

/**
 * The languages `selectElisionRegions` can select sub-item regions for.
 *
 * Exported so the language-support report is derived from the gate rather than restating it.
 * The two used to be the same fact written twice in different files, which is how audit M5b's
 * marker formats drifted apart; this list and the check below must not repeat that.
 */
export type RegionElisionLanguage = 'typescript' | 'python';

export const REGION_ELISION_LANGUAGES: ReadonlyArray<RegionElisionLanguage> = Object.freeze([
  'typescript',
  'python',
]);

/**
 * The region-selectable language for this item, or `undefined` if there is none.
 *
 * The first of the two gates behind audit H2, and the narrowing `selectElisionRegions` needs —
 * one function rather than a predicate plus a second membership test that could disagree with it.
 * An item that yields `undefined` can only be elided *whole*, which then has to survive the
 * measurement gate; for a language whose symbols the drift tracker cannot see, that is refused
 * by construction.
 */
export function regionElisionLanguage(item: ContextItem): RegionElisionLanguage | undefined {
  const language = selectValidator(item)?.language;
  return language !== undefined && (REGION_ELISION_LANGUAGES as ReadonlyArray<string>).includes(language)
    ? (language as RegionElisionLanguage)
    : undefined;
}

/** Whether sub-item elision is available for this item's language. */
export function supportsRegionElision(item: ContextItem): boolean {
  return regionElisionLanguage(item) !== undefined;
}

/**
 * Selects the sub-item regions of `item` that may be elided.
 *
 * Deterministic: the result is a pure function of `item.content` and the language
 * `selectValidator` resolves for the item — the same authority `resolveElisionSyntax` uses,
 * so the selector and the checker cannot disagree about what the content is.
 *
 * Returns an empty list for anything that is not TypeScript/JavaScript or Python. JSON is
 * excluded on purpose and must stay excluded: the `{"__td_block__":…}` wrapper is not
 * composable at sub-item granularity, because `TokenHasher.rehydrateText` unwraps only when
 * the *whole* item is a wrapped marker and otherwise substitutes the stored content inside
 * the wrapper, producing text that is neither the original nor valid JSON.
 */
export function selectElisionRegions(
  item: ContextItem,
  options?: SelectRegionsOptions,
): ReadonlyArray<ElisionRegion> {
  const language = regionElisionLanguage(item);
  if (language === undefined) {
    return [];
  }

  const minBytes = options?.minRegionBytes ?? MIN_REGION_BYTES;
  const content = item.content;

  const candidates: ElisionRegion[] =
    language === 'python'
      ? [...scanPythonDefBodies(content)]
      : scanBraceSpans(content)
          .filter((span) => FUNCTION_HEADER.test(span.header) && !CONTROL_FLOW_HEADER.test(span.header))
          .map((span) => ({ start: span.start, end: span.end }));

  return Object.freeze(
    dropOverlapping(candidates).filter((region) => {
      const text = content.slice(region.start, region.end);
      return text.length >= minBytes && isSubstantiveRegion(text, language);
    }),
  );
}
