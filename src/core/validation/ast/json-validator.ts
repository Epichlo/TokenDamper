import type { AstCheckResult, AstIssue, AstValidator, AstValidatorOptions, TargetLanguage } from './types';

/**
 * Fast JSON syntax validator using native `JSON.parse` with line/column position mapping.
 */
export class JsonValidator implements AstValidator {
  readonly language: TargetLanguage = 'json';

  validate(content: string, _options?: AstValidatorOptions): AstCheckResult {
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
        message: `JSON Syntax Error: ${describeParseFailure(message)} at line ${line}, column ${column}`,
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

/**
 * What went wrong, said in this file's own words rather than V8's (security review S-03).
 *
 * `JSON.parse`'s message used to be forwarded whole. One of its forms quotes the input:
 * `Unexpected token 'q', ..."Ab9x","r":qq}" is not valid JSON` — roughly fifteen characters
 * either side of the error, and for a document shorter than that window, **all of it**. That
 * string reaches `ValidationIssue.message`, is joined into `reason`, and lands in
 * `trace.fallbackReason`, which the CLI writes to stderr on every run. Measured through the
 * shipped binary on `{"db_password":"hunter2-Ab9x","r":qq}`: the password's tail was in the
 * trace. It is the same defect F-05 fixed for constraint directives, on the same field, arriving
 * through a sibling message nobody looked at.
 *
 * **The returned string is a constant from the table below, never a slice of V8's.** That is the
 * whole safety argument, and it is why this matches on a *prefix* — the payload always appears
 * after one. A form this table does not know degrades to `invalid JSON`, which is uninformative
 * but cannot leak; the alternative, stripping the quoted part out of V8's text with a regex,
 * fails open the day a message changes shape. Enumerated against Node 22 and 26, which produce
 * identical shapes: only the `Unexpected token` form carries input.
 *
 * The offending character goes too. `Unexpected token 'Z'` names a byte taken straight from the
 * payload, and the caller already has `line`/`column` — which identifies it exactly for anyone
 * holding the input, and to nobody else. That is F-05's own reasoning, applied here.
 */
function describeParseFailure(message: string): string {
  for (const [prefix, description] of PARSE_FAILURES) {
    if (message.startsWith(prefix)) return description;
  }
  return 'invalid JSON';
}

/** Prefix of V8's message -> this file's constant. Order matters only where one prefixes another. */
const PARSE_FAILURES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['Unexpected end of JSON input', 'unexpected end of input'],
  ['Unexpected non-whitespace character after JSON', 'unexpected trailing content after the value'],
  ['Unexpected number in JSON', 'unexpected number'],
  ['Unexpected string in JSON', 'unexpected string'],
  ['Unexpected token', 'unexpected token'],
  ["Expected property name or '}'", "expected a property name or '}'"],
  ['Expected double-quoted property name', 'expected a double-quoted property name'],
  ["Expected ':' after property name", "expected ':' after a property name"],
  ["Expected ',' or '}' after property value", "expected ',' or '}' after a property value"],
  ["Expected ',' or ']' after array element", "expected ',' or ']' after an array element"],
  ['Bad control character in string literal', 'a control character in a string literal'],
  ['Bad escaped character', 'a bad escape sequence'],
  ['Bad Unicode escape', 'a bad unicode escape'],
  ['Unterminated string', 'an unterminated string'],
  ['Unterminated fractional number', 'an unterminated fractional number'],
  ['Exponent part is missing a number', 'an exponent with no number'],
  ['No number after minus sign', 'a minus sign with no number'],
] as const);

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
