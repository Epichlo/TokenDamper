import type { AstCheckResult, AstIssue, AstValidator, AstValidatorOptions, TargetLanguage } from './types';

interface BracketStackItem {
  readonly char: string;
  readonly line: number;
  readonly column: number;
}

/**
 * Bracket, quote and comment balance for Go — step 2 of three that widen elision to Go
 * (DECISIONS §56, §60).
 *
 * **Why Go does not just use `TypeScriptValidator`.** The two grammars share `//`, `/* *\/` and
 * the three bracket pairs, which is exactly the resemblance that makes the substitution look
 * free. It is not, and the difference is measurable:
 *
 *  - **Raw string literals.** Go's `` ` `` string spans lines, has **no escapes at all**, and
 *    routinely contains `"`, `{`, `}` and `\` — struct tags (`` `json:"name"` ``), SQL, regexes
 *    and templates all live in one. A TS lexer reads `` ` `` as a template literal, honours `\`
 *    as an escape and treats `${` as interpolation that pushes a bracket.
 *  - **Rune literals.** `'x'`, `'\''`, `'\n'` are single characters in Go, not strings, and a
 *    TS lexer's single-quote string rule mostly coincides — until the rune is `'"'`.
 *  - **No regex literals.** The TS lexer's `/`-may-start-a-regex heuristic has nothing to be
 *    right about here, and every wrong guess swallows the rest of a line.
 *
 * That is DECISIONS §17's finding — a verdict decided by quote parity is not validating
 * anything — and it is why `CONTENT_TYPE_VALIDATORS.code` is `null` rather than the TypeScript
 * validator. Measured over 9,181 real Go files (100.8 MB — `cli/cli`, `cobra`, `gin` and
 * `golang/go` `src/`, the stdlib subset hash-verified 5,387/5,387 against §56's manifest), the
 * TypeScript lexer flags **73 files (0.80%)**; this validator flags **1 (0.01%)**, and that one
 * is `cmd/compile/internal/syntax/testdata/issue20789.go`, whose own header says *"Make sure
 * this doesn't crash the compiler"* — a true positive. The 72 files it disagrees on are raw
 * strings: `` strings.Contains(v, `\`) `` in `cmd/go/internal/fips140`, and a 200-line shell
 * template in `cobra/zsh_completions.go`.
 *
 * **0 findings is also what a validator that examines nothing reports** (invariant 10), so the
 * control is the other direction: over a 1,312-file spread of the same corpus, deleting the last
 * column-0 `}` is caught in **1,159 of 1,163** files (99.66%). All four non-catches were checked
 * individually and are mutations that landed inside a raw string or a cgo `/* … *\/` C preamble,
 * where deleting a brace is not a defect. Five other mutation classes run 95–100% on the same
 * sample, and their misses are the same no-op. See §60.
 *
 * **What it checks is balance, not syntax** — the same guarantee the TypeScript validator makes
 * and the same one the README's table states. It is a lexer, it builds no AST, and Go that is
 * balanced but meaningless passes. What it is for is the failure mode step 3 introduces: a
 * brace-span elision that lands inside a raw string, or drops a `}`, is precisely an unbalanced
 * bracket.
 */
export class GoValidator implements AstValidator {
  readonly language: TargetLanguage = 'go';

  validate(content: string, _options?: AstValidatorOptions): AstCheckResult {
    const startTime = performance.now();
    const issues: AstIssue[] = [];

    let line = 1;
    let column = 0;
    const stack: BracketStackItem[] = [];

    // null | '"' (interpreted string) | '`' (raw string) | "'" (rune literal)
    let quote: string | null = null;
    let isComment: '//' | '/*' | null = null;

    const len = content.length;
    let i = 0;

    while (i < len) {
      const char = content[i];

      if (char === '\n') {
        if (isComment === '//') {
          isComment = null;
        } else if (quote === '"' || quote === "'") {
          // Neither an interpreted string nor a rune literal may contain a newline in Go, and
          // unlike JavaScript there is no line-continuation form that makes one legal — so the
          // literal is unterminated rather than continued. Reported and then cleared, so one
          // stray quote costs one issue instead of re-reporting on every line after it.
          issues.push({
            line,
            column,
            message:
              quote === '"'
                ? `Unterminated string literal at line ${line}, column ${column}`
                : `Unterminated rune literal at line ${line}, column ${column}`,
            code: 'AST_UNTERMINATED_STRING',
          });
          quote = null;
        }
        // A raw string may span lines: `quote === '`'` deliberately survives this branch.
        line++;
        column = 0;
        i++;
        continue;
      }

      column++;

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

      if (quote === '`') {
        // No escape processing whatsoever: inside a raw string a backslash is a backslash, and
        // only a closing backtick ends it. Handling `\` here is what makes a TS lexer mis-lex
        // `` `C:\path\` `` and every Windows path or regex in a Go source file.
        if (char === '`') {
          quote = null;
        }
        i++;
        continue;
      }

      if (quote !== null) {
        if (char === '\\') {
          if (content[i + 1] === '\n') {
            // Consume only the backslash. The newline is then seen by the branch above, which
            // reports the literal as unterminated — which is what Go says it is.
            i++;
            continue;
          }
          column++;
          i += 2;
          continue;
        }
        if (char === quote) {
          quote = null;
        }
        i++;
        continue;
      }

      if (char === '/' && i + 1 < len) {
        const next = content[i + 1];
        if (next === '/') {
          isComment = '//';
          i += 2;
          column++;
          continue;
        }
        if (next === '*') {
          isComment = '/*';
          i += 2;
          column++;
          continue;
        }
      }

      // No regex-literal branch, deliberately. In Go a `/` outside a comment is always division
      // or a shift, so there is nothing to disambiguate and nothing to guess wrong.

      if (char === '"' || char === '`' || char === "'") {
        quote = char;
        i++;
        continue;
      }

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
          const matches =
            (char === ')' && top.char === '(') ||
            (char === ']' && top.char === '[') ||
            (char === '}' && top.char === '{');

          if (matches) {
            stack.pop();
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

    if (isComment === '/*') {
      issues.push({
        line,
        column,
        message: 'Unterminated block comment at end of input',
        code: 'AST_UNTERMINATED_COMMENT',
      });
    }

    if (quote !== null) {
      issues.push({
        line,
        column,
        message:
          quote === '`'
            ? 'Unterminated raw string literal at end of input'
            : `Unterminated string literal ('${quote}') at end of input`,
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
