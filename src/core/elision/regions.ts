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

    // The *first non-blank* body line, not `lineAt(i + 1)` — audit L7.
    //
    // A blank line between `def foo():` and the first statement is ordinary Python style, and
    // reading the indent off it gave `indentOf('') === 0`. The region then began at column 0
    // of the blank line, the marker inherited column 0, `PythonValidator` reported
    // `AST_INDENTATION_ERROR`, and `elideRegions` skipped the region as
    // `post_condition_rejected`. The audit rated that "fails safe (skip) but silently loses
    // the region"; measured end-to-end it loses the whole file, because a one-region file has
    // nothing else to elide. Two otherwise identical functions: 434 -> 96 bytes without the
    // blank line, 436 -> 436 with it.
    //
    // The `last` scan above already skipped blanks; only this line did not, which is why the
    // two disagreed.
    let firstBodyIndex = i + 1;
    while (firstBodyIndex < last && lineAt(firstBodyIndex).text.trim().length === 0) {
      firstBodyIndex++;
    }

    const firstBody = lineAt(firstBodyIndex);
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

/**
 * How much of a region its usable statements must still cover for the division to be used.
 *
 * **Swept over the frozen corpus at target 0.3, 576 rows, against the pre-division engine.**
 * Recorded in full because it does not show a flat optimum — it shows a trade, and this value
 * resolves that trade in a direction someone may later want to revisit:
 *
 * | coverage | rows >50% | new fallbacks | fallbacks fixed | closer to 0.3 | further |
 * |---|---|---|---|---|---|
 * | 0.25 (≈ no guard) | **8** | 2 | 9 | 48 | 23 |
 * | 0.50 | 12 | 2 | 4 | 44 | 21 |
 * | **0.75** | 18 | **0** | 4 | 39 | **11** |
 * | 0.90 | 33 | 0 | 5 | 13 | 3 |
 *
 * Dividing aggressively controls overshoot best — 8 rows above 50% against a baseline of 34 —
 * but it converts **2 rows that were reducing into fallbacks**. A finer span is likelier to
 * contain a comment carrying an imperative, and `cleanup:constraint-preservation` refuses to
 * lose one; on a single-item bundle Phase 1c has no other item to keep, so that refusal is a
 * whole-file fallback and 34.1% becomes 0%.
 *
 * **0.75 is chosen because it regresses nothing.** Zero new fallbacks, the >50% population still
 * nearly halved (34 → 18), and the fewest files pushed away from target of any dividing setting.
 * Buying a better headline with two working files is the trade this project keeps un-making.
 *
 * Revisit on multi-item bundles, where a constraint failure names its item and Phase 1c reverts
 * only that one — there 0.25 may cost nothing, and its overshoot number is much better.
 */
const MIN_DIVISION_COVERAGE = 0.75;

/**
 * Divides one region into the statement spans it is made of.
 *
 * **The unit of elision was a whole region, and that is what makes `--target-reduction-ratio`
 * overshoot.** A region is usually one function body, files typically have one dominant region
 * — 58%, 61%, 83% measured — and a body cannot be taken in part, so a modest target either
 * misses it or blows past it. Measured over the frozen corpus at target 0.3, whole-region
 * granularity puts **36 of 99** files above 50% achieved; statement granularity puts **12**
 * there and moves the mean from 45.8% to 30.8% against a 30% target.
 *
 * ### A span must be independently removable, which is stricter than "a line"
 *
 * Every span this returns is balanced: it opens no bracket it does not close and starts no
 * string it does not finish. `elideRegions` refuses anything that raises the item's AST issue
 * count, so an unbalanced span would be silently skipped rather than shipped — but a *skip* is
 * a 0% run, and the point of the exercise is adherence. The boundaries are therefore taken at
 * depth 0 only:
 *
 *  - **TypeScript/JavaScript:** a `;` at depth 0, or the `}` that returns depth to 0. Strings,
 *    template literals, comments and regex literals are tracked, because a brace inside one is
 *    not a brace. A nested `if`/`try` block is one span, not several — its inner statements are
 *    at depth 1.
 *  - **Python:** a non-blank line at the body's base indentation, provided no bracket is open
 *    and no triple-quoted string is in progress. A continuation line sits at base indent
 *    surprisingly often (a closing `)` of a multi-line call), and splitting there would cut a
 *    statement in half.
 *
 * ### Two boundary rules inherited from the region scanners, both load-bearing
 *
 * **Python spans start after the line's indentation.** `scanPythonDefBodies` documents why: the
 * marker has to inherit the body's column or `PythonValidator` reports `AST_INDENTATION_ERROR`,
 * and that indentation has to stay outside the replaced bytes or rehydration is not
 * byte-identical. A sub-span is subject to the same two requirements, which are again only
 * jointly satisfiable at that boundary.
 *
 * **The first line of a Python region is already dedented**, because the region begins after
 * the enclosing body's first indentation. Base indent therefore comes from lines 2+, and line 1
 * is at base by construction. A probe that took the minimum indent across all lines scored 44
 * of 44 real Python files as indivisible, and passed a self-test that used a fixture with a
 * leading newline — which does not have the shape the scanner actually emits.
 *
 * ### Each span is filtered exactly as a whole region is
 *
 * `isSubstantiveRegion` runs per span, not per region. A body can be substantive overall while
 * one of its statements is nothing but a docstring, and eliding *that* span alone is precisely
 * the `HumanEval/0` failure the guard exists to prevent — the specification of the task removed,
 * `S_k = 0.0000`, every gate green. The size floor applies per span too: a span shorter than the
 * marker cannot pay for itself.
 *
 * Returns absolute offsets into `item.content`, ascending and disjoint. Returns an empty list
 * when the region does not divide into more than one usable span, which lets the caller keep
 * the whole region rather than treat "did not divide" as "nothing to elide".
 */
export function splitRegionIntoStatements(
  item: ContextItem,
  region: ElisionRegion,
  options?: SelectRegionsOptions,
): ReadonlyArray<ElisionRegion> {
  const language = regionElisionLanguage(item);
  if (language === undefined) {
    return [];
  }

  const minBytes = options?.minRegionBytes ?? MIN_REGION_BYTES;
  const text = item.content.slice(region.start, region.end);
  const spans = language === 'python' ? splitPythonStatements(text) : splitTypeScriptStatements(text);
  if (spans.length <= 1) {
    return [];
  }

  const usable = spans
    .map((span) => ({ start: region.start + span.start, end: region.start + span.end }))
    .filter((span) => {
      const body = item.content.slice(span.start, span.end);
      return body.length >= minBytes && isSubstantiveRegion(body, language);
    });

  if (usable.length <= 1) {
    return [];
  }

  // **A division that throws most of the region away is worse than no division.**
  //
  // Statements below the marker floor are dropped, and in a body of many short lines that can be
  // nearly all of them. The caller then has only the survivors to work with and cannot reach for
  // the region as a whole, so a file that used to land at 38.9% against a 30% target landed at
  // **6.6%** — measured on `pip/_internal/cli/main.py` in the corpus A/B. Undershooting by 23
  // points is not an improvement on overshooting by 9.
  //
  // So the division only stands if what survives still represents most of the region. Below
  // that, `[]` is returned and the caller keeps the whole region, which is exactly the
  // behaviour that was there before this function existed.
  const covered = usable.reduce((sum, span) => sum + (span.end - span.start), 0);
  if (covered < (region.end - region.start) * MIN_DIVISION_COVERAGE) {
    return [];
  }

  return Object.freeze(usable);
}

/**
 * Statement boundaries in a TypeScript/JavaScript body, as offsets into `text`.
 *
 * The lexical states mirror `scanBraceSpans`; see its note on why regex literals are tracked
 * here even though `TypeScriptValidator` does not track them.
 */
function splitTypeScriptStatements(text: string): ReadonlyArray<ElisionRegion> {
  const spans: ElisionRegion[] = [];
  let depth = 0;
  let quote: string | null = null;
  let comment: '//' | '/*' | null = null;
  let inRegex = false;
  let prevSignificant = '';
  let start = 0;

  const push = (end: number): number => {
    if (text.slice(start, end).trim().length > 0) {
      spans.push({ start, end });
    }
    start = end;
    return end;
  };

  /** Absorbs the statement terminator and the rest of its line, so a span is whole lines. */
  const throughLineEnd = (from: number): number => {
    let end = from;
    while (end < text.length && (text[end] === ';' || text[end] === ',')) end++;
    while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
    if (text[end] === '\r') end++;
    if (text[end] === '\n') end++;
    return end;
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;

    if (comment === '//') {
      if (char === '\n') comment = null;
      continue;
    }
    if (comment === '/*') {
      if (char === '*' && text[i + 1] === '/') {
        comment = null;
        i++;
      }
      continue;
    }
    if (inRegex) {
      if (char === '\\') i++;
      else if (char === '/') {
        inRegex = false;
        prevSignificant = '/';
      } else if (char === '\n') inRegex = false;
      continue;
    }
    if (quote !== null) {
      if (char === '\\') i++;
      else if (char === quote) {
        quote = null;
        prevSignificant = char;
      }
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
    if (char === '/') {
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

    if (char === '{' || char === '(' || char === '[') {
      depth++;
      prevSignificant = char;
      continue;
    }
    if (char === '}' || char === ')' || char === ']') {
      depth--;
      prevSignificant = char;
      if (depth === 0 && char === '}') {
        i = throughLineEnd(i + 1) - 1;
        push(i + 1);
      }
      continue;
    }
    if (char === ';' && depth === 0) {
      i = throughLineEnd(i + 1) - 1;
      push(i + 1);
      continue;
    }

    if (!/\s/.test(char)) {
      prevSignificant = char;
    }
  }

  push(text.length);
  return spans;
}

/**
 * Statement boundaries in a Python body, as offsets into `text`.
 *
 * Spans begin after the line's indentation and end at the last non-blank line's end, excluding
 * its newline — the boundary `scanPythonDefBodies` establishes and documents.
 */
function splitPythonStatements(text: string): ReadonlyArray<ElisionRegion> {
  const lines = text.split('\n');
  const indentOf = (line: string): number => line.length - line.trimStart().length;

  // Line 1 is dedented by construction, so it cannot vote on the base indent.
  let base: number | null = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    const indent = indentOf(line);
    if (base === null || indent < base) base = indent;
  }
  if (base === null) {
    return [];
  }

  const spans: ElisionRegion[] = [];
  let offset = 0;
  let start: number | null = null;
  let lastEnd = 0;
  let depth = 0;
  let triple: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineEnd = offset + line.length + 1;
    const blank = line.trim().length === 0;
    const continues = depth > 0 || triple !== null;

    if (!blank && !continues && (i === 0 || indentOf(line) === base)) {
      if (start !== null) spans.push({ start, end: lastEnd });
      // After the indentation, so the marker inherits the column (see the doc comment).
      start = i === 0 ? offset : offset + indentOf(line);
    }
    if (!blank) {
      lastEnd = Math.min(offset + line.length, text.length);
    }

    for (let j = 0; j < line.length; j++) {
      const char = line[j]!;
      if (triple !== null) {
        if (line.startsWith(triple, j)) {
          j += 2;
          triple = null;
        }
        continue;
      }
      if (char === '#') break;
      if ((char === '"' || char === "'") && line.startsWith(char.repeat(3), j)) {
        triple = char.repeat(3);
        j += 2;
        continue;
      }
      if (char === '"' || char === "'") {
        const q = char;
        j++;
        while (j < line.length && line[j] !== q) {
          if (line[j] === '\\') j++;
          j++;
        }
        continue;
      }
      if (char === '(' || char === '[' || char === '{') depth++;
      else if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1);
    }

    offset = lineEnd;
  }
  if (start !== null) spans.push({ start, end: lastEnd });

  return spans.filter((span) => text.slice(span.start, span.end).trim().length > 0);
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
