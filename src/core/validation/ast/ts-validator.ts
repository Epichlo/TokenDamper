import type { AstCheckResult, AstIssue, AstValidator, AstValidatorOptions, TargetLanguage } from './types';

interface BracketStackItem {
  readonly char: string;
  readonly line: number;
  readonly column: number;
}

/**
 * Punctuation after which a `/` begins a regular expression rather than a division.
 *
 * Deliberately the same set `scanBraceSpans` uses in `src/core/elision/regions.ts`. That
 * scanner had to learn regex literals first, precisely because this validator could not be
 * relied on to catch a boundary it got wrong inside one; the two must not now disagree about
 * where a literal starts.
 */
const REGEX_MAY_FOLLOW_PUNCT = '(,=:[!&|?{};+-*%~^<>';

/**
 * Reserved words after which a `/` begins a regular expression.
 *
 * Every member is a reserved word, which is what makes the rule safe: a reserved word can
 * never be the end of an expression, so the `/` after one cannot be division. `in` and `of`
 * are deliberately absent — both are legal identifiers in enough positions that `of / 2`
 * is expressible, and a wrong guess here turns real code into a swallowed literal.
 */
const REGEX_MAY_FOLLOW_WORDS: ReadonlySet<string> = new Set([
  'return',
  'typeof',
  'instanceof',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'throw',
]);

function isIdentifierChar(char: string): boolean {
  return (
    (char >= 'a' && char <= 'z') ||
    (char >= 'A' && char <= 'Z') ||
    (char >= '0' && char <= '9') ||
    char === '_' ||
    char === '$'
  );
}

function regexMayFollow(lastToken: string): boolean {
  if (lastToken === '') {
    return true;
  }
  if (lastToken.length === 1) {
    return REGEX_MAY_FOLLOW_PUNCT.includes(lastToken);
  }
  return REGEX_MAY_FOLLOW_WORDS.has(lastToken);
}

/**
 * Fast bracket/quote stack validator for TypeScript and JavaScript code.
 * Validates syntax structure within <5ms SLA.
 */
export class TypeScriptValidator implements AstValidator {
  readonly language: TargetLanguage = 'typescript';

  validate(content: string, _options?: AstValidatorOptions): AstCheckResult {
    const startTime = performance.now();
    const issues: AstIssue[] = [];

    let line = 1;
    let column = 0;
    const stack: BracketStackItem[] = [];

    // State management:
    // null | "'" | '"' | '`' | '//' | '/*'
    let stringQuote: string | null = null;
    let isComment: '//' | '/*' | null = null;
    // Regex literal state. `inRegexClass` matters because an unescaped `/` inside `[...]`
    // does not end the literal.
    let inRegex = false;
    let inRegexClass = false;
    // The token immediately before the cursor, used only to tell `/` as regex-start from `/`
    // as division. A pending identifier is held separately until it is complete.
    let lastToken = '';
    let pendingWord = '';
    // Template literal interpolation nesting stack (counts bracket depth inside ${ ... })
    const templateInterpolationStack: number[] = [];

    /** Completes a pending identifier so `lastToken` names the token that just ended. */
    const flushWord = (): void => {
      if (pendingWord !== '') {
        lastToken = pendingWord;
        pendingWord = '';
      }
    };

    const len = content.length;
    let i = 0;

    while (i < len) {
      const char = content[i];
      column++;

      if (char === '\n') {
        if (inRegex) {
          // A regex literal cannot span a line. Reaching a newline means the `/` was not a
          // literal after all, so drop the state rather than swallow the rest of the input.
          inRegex = false;
          inRegexClass = false;
        }
        if (isComment === '//') {
          isComment = null;
        } else if (stringQuote === "'" || stringQuote === '"') {
          // Multiline single/double quoted strings without escape are invalid in JS/TS
          if (i > 0 && content[i - 1] !== '\\') {
            issues.push({
              line,
              column,
              message: `Unterminated string literal at line ${line}, column ${column}`,
              code: 'AST_UNTERMINATED_STRING',
            });
            stringQuote = null;
          }
        }
        line++;
        column = 0;
        i++;
        continue;
      }

      // Handle comment mode
      if (isComment === '//') {
        i++;
        continue;
      }

      if (isComment === '/*') {
        if (char === '*' && i + 1 < len && content[i + 1] === '/') {
          isComment = null;
          i += 2;
          column++;
          continue;
        }
        i++;
        continue;
      }

      // Handle regex literal mode
      if (inRegex) {
        if (char === '\\') {
          i += 2;
          column++;
          continue;
        }
        if (char === '[') {
          inRegexClass = true;
        } else if (char === ']') {
          inRegexClass = false;
        } else if (char === '/' && !inRegexClass) {
          inRegex = false;
          lastToken = '/';
        }
        i++;
        continue;
      }

      // Handle string quote mode
      if (stringQuote !== null) {
        if (char === '\\') {
          // Escaped character, skip next char
          i += 2;
          column++;
          continue;
        }

        if (stringQuote === '`') {
          // Check for template interpolation `${`
          if (char === '$' && i + 1 < len && content[i + 1] === '{') {
            stack.push({ char: '${', line, column });
            templateInterpolationStack.push(stack.length);
            stringQuote = null;
            lastToken = '{';
            i += 2;
            column++;
            continue;
          }
          if (char === '`') {
            stringQuote = null;
            lastToken = char;
            i++;
            continue;
          }
        } else if (char === stringQuote) {
          stringQuote = null;
          lastToken = char;
          i++;
          continue;
        }

        i++;
        continue;
      }

      // Normal mode (outside comments and strings)
      // Check for comments start
      if (char === '/' && i + 1 < len) {
        const nextChar = content[i + 1];
        if (nextChar === '/') {
          flushWord();
          isComment = '//';
          i += 2;
          column++;
          continue;
        }
        if (nextChar === '*') {
          flushWord();
          isComment = '/*';
          i += 2;
          column++;
          continue;
        }
      }

      // Check for a regex literal start. This must come after the comment checks, so `//`
      // and `/*` are still comments, and before everything else, because the bracket and
      // quote characters inside a literal are not brackets and quotes.
      if (char === '/') {
        flushWord();
        if (regexMayFollow(lastToken)) {
          inRegex = true;
          inRegexClass = false;
          i++;
          continue;
        }
      }

      // Check for string starts
      if (char === "'" || char === '"' || char === '`') {
        flushWord();
        stringQuote = char;
        i++;
        continue;
      }

      // Bracket handling
      if (char === '(' || char === '[' || char === '{') {
        stack.push({ char, line, column });
      } else if (char === ')' || char === ']' || char === '}') {
        if (stack.length === 0) {
          issues.push({
            line,
            column,
            message: `Unexpected closing bracket '${char}' at line ${line}, column ${column}`,
            code: 'AST_UNBALANCED_BRACKET',
          });
        } else {
          const top = stack[stack.length - 1]!;
          let matches = false;
          if (char === ')' && top.char === '(') matches = true;
          if (char === ']' && top.char === '[') matches = true;
          if (char === '}' && (top.char === '{' || top.char === '${')) matches = true;

          if (matches) {
            const popped = stack.pop()!;
            if (popped.char === '${') {
              templateInterpolationStack.pop();
              stringQuote = '`';
            }
          } else {
            issues.push({
              line,
              column,
              message: `Mismatched closing bracket '${char}' at line ${line}, column ${column}; expected match for '${top.char}' from line ${top.line}, column ${top.column}`,
              code: 'AST_UNBALANCED_BRACKET',
            });
            stack.pop();
          }
        }
      }

      // Track the token boundary the regex-start test reads. An identifier is held until it
      // ends, so `return` is seen whole rather than as its last letter.
      const significant = char!;
      if (isIdentifierChar(significant)) {
        pendingWord += significant;
      } else {
        flushWord();
        if (significant !== ' ' && significant !== '\t' && significant !== '\r') {
          lastToken = significant;
        }
      }

      i++;
    }

    // EOF checks
    if (isComment === '/*') {
      issues.push({
        line,
        column,
        message: 'Unterminated block comment at end of input',
        code: 'AST_UNTERMINATED_COMMENT',
      });
    }

    if (stringQuote !== null) {
      issues.push({
        line,
        column,
        message: `Unterminated string literal ('${stringQuote}') at end of input`,
        code: 'AST_UNTERMINATED_STRING',
      });
    }

    while (stack.length > 0) {
      const top = stack.pop()!;
      issues.push({
        line: top.line,
        column: top.column,
        message: `Unclosed bracket '${top.char}' opened at line ${top.line}, column ${top.column}`,
        code: 'AST_UNBALANCED_BRACKET',
      });
    }

    const durationMs = performance.now() - startTime;
    return {
      valid: issues.length === 0,
      issues: Object.freeze(issues),
      durationMs,
    };
  }
}
