const IMPERATIVE_KEYWORD_SOURCE =
  String.raw`\b(?:must(?:\s+not)?|never|always|only\s+if|do\s+not|required|except\s+when|make\s+sure\s+to|critical)\b`;

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
