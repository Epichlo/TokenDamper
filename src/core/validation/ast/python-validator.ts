import type { AstCheckResult, AstIssue, AstValidator, AstValidatorOptions, TargetLanguage } from './types';

interface BracketItem {
  readonly char: string;
  readonly line: number;
  readonly column: number;
}

/**
 * Python syntax checker validating indentation, colon matching, string literals, and bracket closure.
 */
export class PythonValidator implements AstValidator {
  readonly language: TargetLanguage = 'python';

  validate(content: string, _options?: AstValidatorOptions): AstCheckResult {
    const startTime = performance.now();
    const issues: AstIssue[] = [];

    const lines = content.split(/\r?\n/);
    const bracketStack: BracketItem[] = [];

    let activeStringQuote: "'" | '"' | "'''" | '"""' | null = null;
    let stringStartLine = 0;
    let stringStartCol = 0;

    const indentStack: number[] = [0];
    let expectIndent = false;
    let lastColonLine = 0;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const lineNum = lineIndex + 1;
      const rawLine = lines[lineIndex] ?? '';

      // Calculate leading indentation whitespace
      let currentIndent = 0;
      let charIdx = 0;
      while (charIdx < rawLine.length && (rawLine[charIdx] === ' ' || rawLine[charIdx] === '\t')) {
        currentIndent += rawLine[charIdx] === '\t' ? 4 : 1;
        charIdx++;
      }

      const trimmedLine = rawLine.slice(charIdx);
      const isBlankOrCommentLine = trimmedLine.length === 0 || trimmedLine.startsWith('#');

      // Check indentation rules when outside triple quotes and outside open brackets
      if (activeStringQuote === null && bracketStack.length === 0 && !isBlankOrCommentLine) {
        const topIndent = indentStack[indentStack.length - 1] ?? 0;

        if (expectIndent) {
          if (currentIndent <= topIndent) {
            issues.push({
              line: lineNum,
              column: currentIndent + 1,
              message: `Expected an indented block after ':' at line ${lastColonLine}, found indent level ${currentIndent}`,
              code: 'AST_INDENTATION_ERROR',
            });
          } else {
            indentStack.push(currentIndent);
          }
          expectIndent = false;
        } else {
          if (currentIndent > topIndent) {
            issues.push({
              line: lineNum,
              column: currentIndent + 1,
              message: `Unexpected indent level ${currentIndent} at line ${lineNum}`,
              code: 'AST_INDENTATION_ERROR',
            });
          } else if (currentIndent < topIndent) {
            while (indentStack.length > 0 && (indentStack[indentStack.length - 1] ?? 0) > currentIndent) {
              indentStack.pop();
            }
            if ((indentStack[indentStack.length - 1] ?? 0) !== currentIndent) {
              issues.push({
                line: lineNum,
                column: currentIndent + 1,
                message: `Unindent at line ${lineNum} does not match any outer indentation level`,
                code: 'AST_INDENTATION_ERROR',
              });
            }
          }
        }
      }

      // Scan characters across the line for brackets, quotes, comments, colons
      let colNum = charIdx + 1;
      let i = charIdx;
      let lineEndsWithColon = false;

      while (i < rawLine.length) {
        const c = rawLine[i];
        colNum = i + 1;

        if (activeStringQuote !== null) {
          // Inside string literal
          if (c === '\\') {
            i += 2;
            continue;
          }

          if (activeStringQuote === "'''" || activeStringQuote === '"""') {
            const quoteChar = activeStringQuote[0];
            if (c === quoteChar && rawLine.slice(i, i + 3) === activeStringQuote) {
              activeStringQuote = null;
              i += 3;
              continue;
            }
          } else if (c === activeStringQuote) {
            activeStringQuote = null;
            i++;
            continue;
          }
          i++;
          continue;
        }

        // Outside string literal
        if (c === '#') {
          // Comment starts, ignore rest of line
          break;
        }

        // Check triple quotes
        if ((c === "'" || c === '"') && rawLine.slice(i, i + 3) === c.repeat(3)) {
          activeStringQuote = (c + c + c) as "'''" | '"""';
          stringStartLine = lineNum;
          stringStartCol = colNum;
          i += 3;
          continue;
        }

        // Check single quotes
        if (c === "'" || c === '"') {
          activeStringQuote = c;
          stringStartLine = lineNum;
          stringStartCol = colNum;
          i++;
          continue;
        }

        // Bracket matching
        if (c === '(' || c === '[' || c === '{') {
          bracketStack.push({ char: c, line: lineNum, column: colNum });
        } else if (c === ')' || c === ']' || c === '}') {
          if (bracketStack.length === 0) {
            issues.push({
              line: lineNum,
              column: colNum,
              message: `Unexpected closing bracket '${c}' at line ${lineNum}, column ${colNum}`,
              code: 'AST_UNBALANCED_BRACKET',
            });
          } else {
            const top = bracketStack[bracketStack.length - 1]!;
            let match = false;
            if (c === ')' && top.char === '(') match = true;
            if (c === ']' && top.char === '[') match = true;
            if (c === '}' && top.char === '{') match = true;

            if (match) {
              bracketStack.pop();
            } else {
              issues.push({
                line: lineNum,
                column: colNum,
                message: `Mismatched closing bracket '${c}' at line ${lineNum}, column ${colNum}; expected match for '${top.char}' from line ${top.line}, column ${top.column}`,
                code: 'AST_UNBALANCED_BRACKET',
              });
              bracketStack.pop();
            }
          }
        }

        // Colon detection outside brackets and strings
        if (c === ':' && bracketStack.length === 0 && activeStringQuote === null) {
          // Check if rest of line is whitespace or comment
          const rest = rawLine.slice(i + 1).trim();
          if (rest.length === 0 || rest.startsWith('#')) {
            lineEndsWithColon = true;
          }
        }

        i++;
      }

      // If single line string was not closed at end of line (and no escape \ at end of line)
      if (activeStringQuote === "'" || activeStringQuote === '"') {
        if (!rawLine.endsWith('\\')) {
          issues.push({
            line: lineNum,
            column: stringStartCol,
            message: `Unterminated single-line string literal ('${activeStringQuote}') at line ${lineNum}`,
            code: 'AST_UNTERMINATED_STRING',
          });
          activeStringQuote = null;
        }
      }

      if (lineEndsWithColon && activeStringQuote === null && bracketStack.length === 0) {
        expectIndent = true;
        lastColonLine = lineNum;
      }
    }

    // EOF checks
    if (activeStringQuote !== null) {
      issues.push({
        line: stringStartLine,
        column: stringStartCol,
        message: `Unterminated string literal ('${activeStringQuote}') started at line ${stringStartLine}`,
        code: 'AST_UNTERMINATED_STRING',
      });
    }

    if (expectIndent) {
      issues.push({
        line: lastColonLine,
        column: 1,
        message: `Expected an indented block after ':' at line ${lastColonLine}`,
        code: 'AST_COLON_MISMATCH',
      });
    }

    while (bracketStack.length > 0) {
      const top = bracketStack.pop()!;
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
