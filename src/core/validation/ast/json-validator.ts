import type { AstIssue, AstValidator, AstValidatorOptions, AstValidatorResult, TargetLanguage } from './types';

/**
 * Fast JSON syntax validator using native `JSON.parse` with line/column position mapping.
 */
export class JsonValidator implements AstValidator {
  readonly language: TargetLanguage = 'json';

  validate(content: string, _options?: AstValidatorOptions): AstValidatorResult {
    const startTime = performance.now();
    const issues: AstIssue[] = [];

    const trimmed = content.trim();
    if (trimmed.length === 0) {
      const durationMs = performance.now() - startTime;
      return {
        valid: false,
        issues: Object.freeze([
          {
            line: 1,
            column: 1,
            message: 'JSON content is empty',
            code: 'JSON_SYNTAX_ERROR',
          },
        ]),
        durationMs,
      };
    }

    try {
      JSON.parse(content);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const posMatch = message.match(/\bposition\s+(\d+)\b/i);
      const lineColMatch = message.match(/\bline\s+(\d+)\s+column\s+(\d+)\b/i);

      let line = 1;
      let column = 1;

      if (lineColMatch && lineColMatch[1] && lineColMatch[2]) {
        line = parseInt(lineColMatch[1], 10);
        column = parseInt(lineColMatch[2], 10);
      } else if (posMatch && posMatch[1]) {
        const rawPos = parseInt(posMatch[1], 10);
        const loc = indexToLineColumn(content, rawPos);
        line = loc.line;
        column = loc.column;
      } else {
        // Default fallback to end of content location
        const loc = indexToLineColumn(content, content.length);
        line = loc.line;
        column = loc.column;
      }

      issues.push({
        line,
        column,
        message: `JSON Syntax Error: ${message}`,
        code: 'JSON_SYNTAX_ERROR',
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

function indexToLineColumn(text: string, index: number): { line: number; column: number } {
  const safeIndex = Math.min(Math.max(0, index), text.length);
  let line = 1;
  let lastLineBreak = -1;
  for (let i = 0; i < safeIndex; i++) {
    if (text[i] === '\n') {
      line++;
      lastLineBreak = i;
    }
  }
  const column = safeIndex - lastLineBreak;
  return { line, column };
}
