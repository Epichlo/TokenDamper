import { describe, expect, it } from 'vitest';
import {
  isSubstantiveRegion,
  selectElisionRegions,
  splitRegionIntoStatements,
} from '../../src/core/elision/regions';
import { createContextItem } from '../../src/core/model/constructors';
import { validateItemAst } from '../../src/core/validation/ast';

function item(content: string, path: string) {
  return createContextItem({
    id: 'sub-region-item',
    kind: 'file',
    contentType: 'code',
    content,
    origin: 'test',
    path,
    language: path.endsWith('.py') ? 'python' : 'typescript',
  });
}

/** The dominant region of an item, which is the one the ceiling path has to divide. */
function dominantRegion(content: string, path: string) {
  const target = item(content, path);
  const regions = selectElisionRegions(target);
  expect(regions.length).toBeGreaterThan(0);
  return regions.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
}

/**
 * Balanced in the sense `elideRegions` requires: removing the span must not change the item's
 * bracket or quote state. Written independently of the splitter so it is a check rather than a
 * restatement.
 */
function bracketBalanced(text: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  let comment: '//' | '/*' | null = null;
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
    if (char === '{' || char === '(' || char === '[') depth++;
    if (char === '}' || char === ')' || char === ']') depth--;
  }
  return depth === 0 && quote === null;
}

const TS_SOURCE = `export function handle(input: string): string {
  const trimmed = input.trim();
  const parts = trimmed.split(',').map((piece) => piece.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error('nothing to handle at all, which is a problem for the caller');
  }
  const matcher = /a;b[^;]+/g;
  const label = \`count is \${parts.length}; ok\`;
  const joined = parts.join('; ') + label + String(matcher);
  return joined.toUpperCase().padEnd(120, '.').slice(0, 200) + 'done';
}
`;

const PY_SOURCE = `def handle(raw):
    trimmed = raw.strip()
    parts = [
        piece.strip()
        for piece in trimmed.split(",")
    ]
    if not parts:
        raise ValueError("nothing to handle at all, which is a problem for the caller")
    label = "count is %d; ok" % len(parts)
    joined = "; ".join(parts) + label
    return joined.upper().ljust(120, ".")[:200] + "done"
`;

describe('a region divides into the statements it is made of', () => {
  it('divides a TypeScript body at depth-0 boundaries', () => {
    const region = dominantRegion(TS_SOURCE, 'handler.ts');
    const spans = splitRegionIntoStatements(item(TS_SOURCE, 'handler.ts'), region, {
      minRegionBytes: 1,
    });
    expect(spans.length).toBeGreaterThan(1);
  });

  it('divides a Python body at base-indent lines', () => {
    const region = dominantRegion(PY_SOURCE, 'handler.py');
    const spans = splitRegionIntoStatements(item(PY_SOURCE, 'handler.py'), region, {
      minRegionBytes: 1,
    });
    expect(spans.length).toBeGreaterThan(1);
  });

  it('emits ascending, disjoint spans inside the region — the shape elideRegions requires', () => {
    for (const [source, path] of [
      [TS_SOURCE, 'handler.ts'],
      [PY_SOURCE, 'handler.py'],
    ] as const) {
      const target = item(source, path);
      const region = dominantRegion(source, path);
      const spans = splitRegionIntoStatements(target, region, { minRegionBytes: 1 });
      let cursor = region.start;
      for (const span of spans) {
        expect(span.start).toBeGreaterThanOrEqual(cursor);
        expect(span.end).toBeGreaterThan(span.start);
        expect(span.end).toBeLessThanOrEqual(region.end);
        cursor = span.end;
      }
    }
  });

  it('never cuts a statement in half: every TypeScript span is bracket- and quote-balanced', () => {
    const target = item(TS_SOURCE, 'handler.ts');
    const region = dominantRegion(TS_SOURCE, 'handler.ts');
    const spans = splitRegionIntoStatements(target, region, { minRegionBytes: 1 });
    expect(spans.length).toBeGreaterThan(1);
    for (const span of spans) {
      expect(bracketBalanced(TS_SOURCE.slice(span.start, span.end))).toBe(true);
    }
  });

  it('keeps a nested control-flow block whole rather than splitting its inner statements', () => {
    const target = item(TS_SOURCE, 'handler.ts');
    const region = dominantRegion(TS_SOURCE, 'handler.ts');
    const spans = splitRegionIntoStatements(target, region, { minRegionBytes: 1 });
    const throwing = spans.filter((span) => TS_SOURCE.slice(span.start, span.end).includes('throw new Error'));
    expect(throwing).toHaveLength(1);
    // The whole `if (...) { ... }` travels together, so the span carries its own braces.
    expect(bracketBalanced(TS_SOURCE.slice(throwing[0]!.start, throwing[0]!.end))).toBe(true);
  });

  it('does not split on a semicolon inside a string, template literal or regex literal', () => {
    const target = item(TS_SOURCE, 'handler.ts');
    const region = dominantRegion(TS_SOURCE, 'handler.ts');
    const spans = splitRegionIntoStatements(target, region, { minRegionBytes: 1 });
    for (const span of spans) {
      const text = TS_SOURCE.slice(span.start, span.end);
      // Each of these literals contains a `;`. If the splitter cut inside one, the span holding
      // it would be unbalanced on quotes, which `bracketBalanced` reports.
      expect(bracketBalanced(text)).toBe(true);
    }
    const joined = spans.map((s) => TS_SOURCE.slice(s.start, s.end)).join('');
    expect(joined).toContain('/a;b[^;]+/g');
    expect(joined).toContain('count is ${parts.length}; ok');
  });

  it('keeps Python continuation lines with their statement', () => {
    const target = item(PY_SOURCE, 'handler.py');
    const region = dominantRegion(PY_SOURCE, 'handler.py');
    const spans = splitRegionIntoStatements(target, region, { minRegionBytes: 1 });
    const listComp = spans.filter((span) => PY_SOURCE.slice(span.start, span.end).includes('piece.strip()'));
    expect(listComp).toHaveLength(1);
    // The closing `]` sits at base indentation and would start a new statement if bracket depth
    // were not carried across lines.
    expect(PY_SOURCE.slice(listComp[0]!.start, listComp[0]!.end)).toContain(']');
  });

  it('starts a Python span after the line indentation, so the marker inherits the column', () => {
    const target = item(PY_SOURCE, 'handler.py');
    const region = dominantRegion(PY_SOURCE, 'handler.py');
    const spans = splitRegionIntoStatements(target, region, { minRegionBytes: 1 });
    for (const span of spans) {
      const text = PY_SOURCE.slice(span.start, span.end);
      expect(text.startsWith(' ')).toBe(false);
    }
  });

  it('filters a docstring-only span, which is the HumanEval/0 failure at finer granularity', () => {
    // The docstring is deliberately a small share of the body: the coverage guard suppresses a
    // division that drops most of its region, so a fixture that is mostly docstring tests the
    // guard rather than the substantive-span filter this case is about.
    const source = `def handle(raw):
    """Return the handled value."""
    trimmed = raw.strip().replace(",", ";").replace("  ", " ").casefold().title()
    parts = [piece for piece in trimmed.split(";") if piece and not piece.isspace()]
    counted = {piece: parts.count(piece) for piece in parts if len(piece) > 2}
    ordered = sorted(counted.items(), key=lambda pair: (-pair[1], pair[0]))[:24]
    rendered = ["%s=%d" % (name, hits) for name, hits in ordered if hits > 0]
    return "; ".join(rendered).ljust(120, ".")[:200] + "done"
`;
    const target = item(source, 'doc.py');
    const region = dominantRegion(source, 'doc.py');
    const spans = splitRegionIntoStatements(target, region, { minRegionBytes: 1 });

    // Asserted before the loop: a filtered-to-one-span result returns [], and a `for` over an
    // empty list is a check that never ran — which this codebase has shipped ten times.
    expect(spans.length).toBeGreaterThan(1);
    for (const span of spans) {
      expect(isSubstantiveRegion(source.slice(span.start, span.end), 'python')).toBe(true);
    }
    const joined = spans.map((s) => source.slice(s.start, s.end)).join('\n');
    expect(joined).not.toContain('entire specification');
  });

  it('returns nothing for a body that does not divide, so the caller keeps the whole region', () => {
    const source = `export function one(seed: number): number {
  return Number.parseInt(String(Math.floor(seed / 1000)).padStart(24, '0').slice(0, 12).concat('42').replace('0', '9'), 10);
}
`;
    const target = item(source, 'one.ts');
    const region = dominantRegion(source, 'one.ts');
    // One statement, comfortably over the region floor: it is the indivisibility that is being
    // tested, not the size filter.
    expect(region.end - region.start).toBeGreaterThan(104);
    expect(splitRegionIntoStatements(target, region, { minRegionBytes: 1 })).toHaveLength(0);
  });

  it('refuses a division that would throw most of the region away', () => {
    // Many short statements, each under the marker floor. Dividing here leaves the caller only
    // the survivors and no way to reach for the region as a whole, which measured as 38.9% ->
    // 6.6% on `pip/_internal/cli/main.py` before the coverage guard existed. Undershooting by
    // 23 points is not an improvement on overshooting by 9.
    const source = `export function tiny(): void {
  a();
  b();
  c();
  d();
  e();
  f();
  g();
  h();
  const wide = 'a padding statement long enough to clear the region floor on its own here';
}
`;
    const target = item(source, 'tiny.ts');
    const region = dominantRegion(source, 'tiny.ts');
    // The default floor is what makes the short statements unusable; this asserts the guard,
    // not the floor, so the floor is left at its real value.
    expect(splitRegionIntoStatements(target, region)).toHaveLength(0);
  });

  it('returns nothing for a language with no region selector', () => {
    // No `language` declared: `rust` is not a `DeclaredLanguage`, and passing it selects the
    // overload that requires an explicit `id` — which vitest would run happily and `tsc` would
    // reject. The path is what makes this Rust, and `selectValidator` returns nothing for it.
    const target = createContextItem({
      id: 'rust-item',
      kind: 'file',
      contentType: 'code',
      content: 'fn main() { let x = 1; let y = 2; println!("{}", x + y); }',
      origin: 'test',
      path: 'main.rs',
    });
    expect(splitRegionIntoStatements(target, { start: 0, end: 40 })).toHaveLength(0);
  });

  it('is deterministic: the same input yields the same spans', () => {
    const target = item(TS_SOURCE, 'handler.ts');
    const region = dominantRegion(TS_SOURCE, 'handler.ts');
    const first = splitRegionIntoStatements(target, region, { minRegionBytes: 1 });
    const second = splitRegionIntoStatements(target, region, { minRegionBytes: 1 });
    expect(second).toEqual(first);
  });
});

describe('splicing the spans back is safe', () => {
  it('removing any single span introduces no new AST issues', () => {
    for (const [source, path] of [
      [TS_SOURCE, 'handler.ts'],
      [PY_SOURCE, 'handler.py'],
    ] as const) {
      const target = item(source, path);
      const baseline = validateItemAst(target).issues.length;
      const region = dominantRegion(source, path);
      const spans = splitRegionIntoStatements(target, region, { minRegionBytes: 1 });
      expect(spans.length).toBeGreaterThan(1);

      for (const span of spans) {
        const marker = '[TokenDamper Elided: test]';
        const spliced = source.slice(0, span.start) + marker + source.slice(span.end);
        const candidate = item(spliced, path);
        expect(validateItemAst(candidate).issues.length).toBeLessThanOrEqual(baseline);
      }
    }
  });
});
