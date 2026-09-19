import type { ContentType } from '../model/types';

const IMPERATIVE_KEYWORD_SOURCE =
  String.raw`\b(?:must(?:\s+not)?|never|always|only\s+if|do\s+not|required|except\s+when|make\s+sure\s+to|critical)\b`;

/** Content types whose every line is prose, so the whole item is scanned. */
const PROSE_CONTENT_TYPES: ReadonlySet<ContentType> = new Set<ContentType>([
  'text',
  'markdown',
  'logs',
  'unknown',
]);

/**
 * The parts of an item a human instruction can actually live in.
 *
 * The keyword list above is written for natural-language system prompts, and it was applied to
 * raw content of every kind. Applied to source, `required` and `critical` are ordinary
 * identifiers, and the check fired on them — audit H6. Measured over a frozen 293-file corpus at
 * `targetReductionRatio: 0.3`, of the directives that a run reported as dropped:
 *
 *   Python       16 from comments/docstrings, **38 from code** — nearly all `logger.critical(...)`
 *   TypeScript   38 from comments/docstrings, **13 from code** — `readonly required?`, error strings
 *
 * So neither "trust it everywhere" nor the audit's proposed "skip `code` entirely" is right:
 * the first keeps 51 false positives, the second discards 54 genuine constraints. What separates
 * them is not the content *type* but the region — an instruction to a reader lives in a comment
 * or a docstring, never in an expression. `docs/phase-1d-semantic-gate-disposition.md` measured [retired]
 * that this check is what catches Python docstring loss, and that is preserved here precisely
 * because docstrings stay in scope.
 *
 * Deliberately line-oriented and syntax-approximate rather than lexed. It is a *filter on what
 * may raise a constraint*, so over-inclusion costs a false positive (the pre-existing behaviour)
 * and under-inclusion costs a missed constraint. Requiring a comment leader at the **start** of a
 * trimmed line is what excludes `logger.critical(exc)` while keeping `# never call this twice`.
 */
export function extractProseRegions(content: string, contentType: ContentType): string {
  if (PROSE_CONTENT_TYPES.has(contentType)) {
    return content;
  }

  const prose: string[] = [];
  let inBlockComment = false;
  let docstringDelimiter: '"""' | "'''" | null = null;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (docstringDelimiter !== null) {
      prose.push(line);
      if (trimmed.includes(docstringDelimiter)) docstringDelimiter = null;
      continue;
    }

    if (inBlockComment) {
      prose.push(line);
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }

    // A docstring opener that does not also close on the same line.
    const opener = trimmed.startsWith('"""') ? '"""' : trimmed.startsWith("'''") ? "'''" : null;
    if (opener !== null) {
      prose.push(line);
      // `"""one-liner"""` opens and closes; a bare `"""` does not.
      if (trimmed.length < 6 || !trimmed.slice(3).includes(opener)) docstringDelimiter = opener;
      continue;
    }

    if (trimmed.startsWith('/*')) {
      prose.push(line);
      if (!trimmed.includes('*/')) inBlockComment = true;
      continue;
    }

    // Line comments across the families `isCodeExtension` admits: `//` (C family, TS/JS, Go,
    // Rust, Java, Swift, Kotlin), `#` (Python, Ruby, Perl, shell, Tcl), `--` (SQL, Lua), and
    // `*` for JSDoc continuation lines.
    if (
      trimmed.startsWith('//') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('--') ||
      trimmed.startsWith('*')
    ) {
      prose.push(line);
    }
  }

  return prose.join('\n');
}

/**
 * Case-insensitive pattern for natural-language imperative constraints.
 */
export const IMPERATIVE_DIRECTIVE_REGEX = new RegExp(IMPERATIVE_KEYWORD_SOURCE, 'i');

/**
 * `never` and `always` in a **narrative** construction — a report about what happened, not an
 * instruction about what must happen.
 *
 * H6 (§42) scoped this check by *region*: an instruction lives in a comment, never in an
 * expression. This scopes it by *mood* within that region, because a comment is also where a
 * codebase explains itself. Measured over the code buckets of the frozen corpus, **29 of 29**
 * fallbacks are `CONSTRAINT_DIRECTIVE_LOST`, and inspecting the matched text, roughly 12 are
 * sentences like these:
 *
 *   "The MCP branch of `runCli` has always read these two"
 *   "It never did: this branch bypassed pruning entirely"
 *   "`HTTP_PROXY` ... could never have worked"
 *   "a saving that never reached the wire (audit C4)"
 *
 * Losing one of those costs a reader some history. Losing "never hash items matching
 * preserveKinds" costs a caller a rule. The gate cannot tell them apart by keyword, and it
 * currently refuses the whole file for either.
 *
 * ### Deliberately narrow, in the safe direction
 *
 * Applied **only to `never` and `always`** — the two keywords that are as comfortable describing
 * as instructing. `must`, `must not`, `do not`, `required`, `critical`, `only if`, `except when`
 * and `make sure to` are untouched, because "must have been called before" is a requirement
 * about a past state, not a narrative. Excluding those on a perfect-tense test would drop real
 * constraints, which is the failure this must not have.
 *
 * And only for *perfect or past* constructions, which are provable from the words present:
 * a preceding `have`/`has`/`had`, or a following past-tense verb. `"is always deterministic"`
 * and `"do not support"` are descriptive too, and are deliberately **left firing** — the line
 * between describing a constraint and stating one is blurry there, and a wrong call silently
 * deletes a real directive. Under-narrowing costs reduction; over-narrowing costs content.
 */

/** Irregular past tenses that no `-ed` rule will catch. */
const PAST_TENSE_IRREGULARS = String.raw`(?:did|was|were|had|got|made|took|ran|read|said|meant|came|went|saw|knew|found|left|felt|kept|held|told|became|began|broke|brought|built|chose|drew|drove|fell|flew|gave|grew|hit|kept|knew|lay|led|lost|met|paid|put|sent|set|shot|shut|sold|spent|stood|struck|swore|threw|understood|withdrew|wrote|worked|wanted|needed|existed|reached|shipped|fired|failed|passed|stopped|started|used|meant)`;

/**
 * Verbs with no agent, so no imperative form to be confused with.
 *
 * You cannot instruct something not to `happen`. These are unaccusative: the subject is not
 * doing anything, so `never happen` can only be a description. That is the same standard §52
 * set — provable from the words present rather than inferred from tone — and it is what exempts
 * `// Should never happen, but we ...`, the shape recorded as dominating Go's fallbacks.
 *
 * Deliberately short. Every addition is a verb somebody could turn out to use imperatively, and
 * this gate protects content.
 */
const NON_AGENTIVE_VERBS = String.raw`(?:happen|occur|exist|arise|matter)`;

/** `have`/`has`/`had` within two words before the keyword: `has always read`. */
const PERFECT_BEFORE = new RegExp(String.raw`\b(?:have|has|had)\s+(?:\w+\s+){0,2}$`, 'i');

/** A copula within two words before: `is always deterministic`, `are never exact`. Axis A. */
const COPULA_BEFORE = new RegExp(
  String.raw`\b(?:is|are|isn't|aren't|was|were|wasn't|weren't)\s+(?:\w+\s+){0,2}$`,
  'i',
);

/** `never have`, `never had`. */
const PERFECT_AFTER = /^\s+(?:have|has|had)\b/i;

/** `never reached`, `never did` — §52's past-tense test, applied to one occurrence. */
const PAST_AFTER = new RegExp(String.raw`^\s+(?:\w+ed|${PAST_TENSE_IRREGULARS})\b`, 'i');

/**
 * A third-person `-s` verb: `never returns`, `always expires`. Axis A, and the largest group —
 * 99 of 322 unexempted occurrences on the frozen corpus.
 *
 * **An English imperative is a bare infinitive and cannot take `-s`.** So the `-s` is a proof of
 * mood rather than a guess at one, which is why the imperative form of the same verb keeps
 * firing: `never return a placeholder` instructs, `never returns a placeholder` describes.
 *
 * `is`/`as`/`has`/`was` are excluded because they are not this pattern — `never is` is a copula
 * construction and `never has` is the perfect, both handled above.
 *
 * **The `[^s]s` is load-bearing and a failing negative control put it there.** A naive `\w+s`
 * also matches bare verbs that merely end in `s`, and the first version of this rule exempted
 * `always pass the ledger explicitly, or turn 2 falls back` — a real instruction, taken
 * verbatim from this repository's own source. A third-person form is stem + `s` where the stem
 * does not itself end in `s`, which keeps `pass`, `miss`, `cross`, `discuss`, `address` and
 * `express` firing. `focus` is the one common single-`s` imperative that passes the shape
 * test, so it is named.
 */
const THIRD_PERSON_AFTER = /^\s+(?!is\b|as\b|has\b|was\b|its\b|this\b|focus\b)\w*[^s\W]s\b/i;

/** `never happen`, `never occur` — bare, because there is no imperative to collide with. */
const NON_AGENTIVE_AFTER = new RegExp(String.raw`^\s+${NON_AGENTIVE_VERBS}\b`, 'i');

/** Whether one `never`/`always` occurrence is narrative, judged from its own neighbourhood. */
function isNarrativeOccurrence(before: string, after: string): boolean {
  return (
    PERFECT_BEFORE.test(before) ||
    COPULA_BEFORE.test(before) ||
    PERFECT_AFTER.test(after) ||
    PAST_AFTER.test(after) ||
    THIRD_PERSON_AFTER.test(after) ||
    NON_AGENTIVE_AFTER.test(after)
  );
}

/**
 * Whether **every** `never`/`always` in this segment is narrative rather than imperative.
 *
 * Exported so the characterization tests can assert the boundary directly rather than inferring
 * it from a reduction figure two layers away.
 *
 * **Per occurrence, and unanimous — this is a correction to §52, not only an extension of it.**
 * §52 tested the whole segment, so one narrative construction anywhere exempted everything in it.
 * That was already live rather than theoretical: `the value is always set, so always check it
 * first` lost its instruction, because `set` is a past-tense irregular. Axis A matches far more
 * shapes, which would have turned a latent hazard into a common one.
 *
 * Unanimity is the same rule `extractImperativeDirectives` already applies across *keywords* —
 * one `must` keeps the segment — now applied within the two keywords that can do both jobs. The
 * mixed case resolves toward firing, which is the direction that cannot delete content.
 */
export function isNarrativeUse(segment: string): boolean {
  const matches = Array.from(segment.matchAll(/\b(?:never|always)\b/gi));
  if (matches.length === 0) {
    return false;
  }

  return matches.every((match) => {
    const index = match.index ?? 0;
    return isNarrativeOccurrence(segment.slice(0, index), segment.slice(index + match[0].length));
  });
}

/**
 * Returns whether content contains a natural-language imperative constraint.
 */
export function containsImperativeDirective(content: string): boolean {
  return IMPERATIVE_DIRECTIVE_REGEX.test(content);
}

/**
 * Extracts the sentence or semicolon-delimited clause containing imperative constraints.
 */
export function extractImperativeDirectives(content: string): {
  readonly directives: ReadonlyArray<string>;
  readonly keywords: ReadonlyArray<string>;
} {
  const directives: string[] = [];
  const keywordsSet = new Set<string>();
  const keywordRegex = new RegExp(IMPERATIVE_KEYWORD_SOURCE, 'gi');

  for (const line of content.split(/\r?\n/)) {
    for (const segment of extractSentenceOrClauseSegments(line)) {
      const matches = Array.from(segment.matchAll(keywordRegex));
      if (matches.length === 0) {
        continue;
      }

      // A segment is narrative only if **every** keyword in it is one of the two that can
      // describe as well as instruct, and the construction is perfect or past. One `must`
      // anywhere keeps the whole segment, so "this has always been true, so you must call it
      // first" is still a directive. Requiring unanimity is what makes the narrowing safe:
      // the mixed case resolves toward firing.
      const allNarrativeCapable = matches.every((match) => /^(?:never|always)$/i.test(match[0]));
      if (allNarrativeCapable && isNarrativeUse(segment)) {
        continue;
      }

      directives.push(segment);
      for (const match of matches) {
        const keyword = normalizeKeyword(match[0]);
        keywordsSet.add(keyword);
        if (keyword.toUpperCase().startsWith('MUST ')) {
          keywordsSet.add(match[0].match(/^[A-Z]/) ? 'MUST' : 'must');
        }
      }
    }
  }

  return {
    directives: Object.freeze(directives),
    keywords: Object.freeze(Array.from(keywordsSet)),
  };
}

function extractSentenceOrClauseSegments(line: string): string[] {
  const trimmedLine = line.trim();
  if (!trimmedLine) {
    return [];
  }

  const segments = trimmedLine.match(/[^.!?;]+[.!?;]?/g) ?? [trimmedLine];
  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

function normalizeKeyword(keyword: string): string {
  return keyword.replace(/\s+/g, ' ').trim();
}
