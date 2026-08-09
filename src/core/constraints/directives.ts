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
 * or a docstring, never in an expression. `docs/phase-1d-semantic-gate-disposition.md` measured
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
