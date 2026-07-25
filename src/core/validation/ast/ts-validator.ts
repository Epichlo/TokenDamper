import type { AstIssue, AstValidator, AstValidatorOptions, AstValidatorResult, TargetLanguage } from './types';

interface BracketStackItem {
  readonly char: string;
  readonly line: number;
  readonly column: number;
}

/**
 * Fast bracket/quote stack validator for TypeScript and JavaScript code.
 * Validates syntax structure within <5ms SLA.
 */
export class TypeScriptValidator implements AstValidator {
  readonly language: TargetLanguage = 'typescript';

  validate(content: string, _options?: AstValidatorOptions): AstValidatorResult {
    const startTime = performance.now();
    const issues: AstIssue[] = [];

    let line = 1;
    let column = 0;
    const stack: BracketStackItem[] = [];

    // State management:
    // null | "'" | '"' | '`' | '//' | '/*'
    let stringQuote: string | null = null;
    let isComment: '//' | '/*' | null = null;
    // Template literal interpolation nesting stack (counts bracket depth inside ${ ... })
    const templateInterpolationStack: number[] = [];

    const len = content.length;
    let i = 0;

    while (i < len) {
      const char = content[i];
      column++;

      if (char === '\n') {
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
            i += 2;
            column++;
            continue;
          }
          if (char === '`') {
            stringQuote = null;
            i++;
            continue;
          }
        } else if (char === stringQuote) {
          stringQuote = null;
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
          isComment = '//';
          i += 2;
          column++;
          continue;
        }
        if (nextChar === '*') {
          isComment = '/*';
          i += 2;
          column++;
          continue;
        }
      }

      // Check for string starts
      if (char === "'" || char === '"' || char === '`') {
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
