import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from '../../src/adapters/cli';
import { loadConfig } from '../../src/config/load';
import { optimize } from '../../src/core/engine';
import { DriftTracker } from '../../src/core/ledger/drift-tracker';
import {
  classifyContent,
  classifyContentShape,
  createContextBundle,
} from '../../src/core/model/constructors';
import { PythonValidator } from '../../src/core/validation/ast/python-validator';
import { selectValidator, validateItemAst } from '../../src/core/validation/ast';

/**
 * Phase 4b.2 — a Python-only content probe.
 *
 * 4b.1 gave the caller a way to say what pathless content is. This is the other half: two of
 * the three entry modes cannot always say. An MCP client can, a piped file can, but a Gateway
 * message is a provider payload with no language field anywhere in its schema, so for the
 * traffic the proxy actually carries a probe is the only route that exists.
 *
 * Scoped to Python deliberately. `docs/phase-4b-pathless-code-scope.md` §4 measured
 * TypeScript positives at 0.283–1.000 against prose negatives reaching 0.333 — overlapping
 * ranges, no threshold orders them — because this repository's prose is documentation *about*
 * TypeScript, dense with fenced TypeScript. A TypeScript probe is not proposed, now or later.
 */
const ROOT = resolve(process.cwd());

const PYTHON = [
  'import os',
  'from sys import argv',
  '',
  'def run(items):',
  '    total = 0',
  '    for item in items:',
  '        total += item',
  '    return total',
  '',
].join('\n');

describe('the probe identifies Python and says so in both fields', () => {
  it('sets contentType and language together', () => {
    expect(classifyContentShape(PYTHON, 'stdin')).toEqual({
      contentType: 'code',
      language: 'python',
    });
  });

  it('routes detected Python to the Python validator, not the TypeScript one', () => {
    const item = createContextBundle(PYTHON, 'stdin').items[0]!;

    expect(item.contentType).toBe('code');
    expect(item.language).toBe('python');
    // Without the language half, `CONTENT_TYPE_VALIDATORS.code` would send this to TypeScript.
    expect(selectValidator(item)?.language).toBe('python');
    expect(validateItemAst(item).validated).toBe(true);
  });

  it('stops the marker fabrication that made D2 worth fixing before enabling elision', () => {
    // `docs/phase-4b-pathless-code-scope.md` §2: pathless Python classified `text` or
    // `markdown`, both on `MARKDOWN_MARKER_TYPES`, so `# NOTE: …` comment leaders were
    // harvested as structural markers — 1,025 of them across 43 files — and the next elision
    // then "destroyed" them. §3 measured that fixing the language *without* the content type
    // pushes drift up on 14 of 20 files and over the gate on one.
    const tracker = new DriftTracker();
    const commented = [
      '# alpha',
      '# beta',
      'import os',
      '',
      'def run():',
      '    return os',
      '',
    ].join('\n');

    const bundle = createContextBundle(commented, 'stdin');
    expect(bundle.items[0]?.contentType).toBe('code');

    const headings = [...tracker.extractMarkers(bundle)].filter((m) => m.startsWith('heading:'));
    expect(headings).toHaveLength(0);
  });

  it('keeps classifyContent answering exactly what the shape does', () => {
    // `classifyContent` is now a wrapper. If the two ever disagree, every caller that reads
    // only the type — the evaluator, the tests below — silently sees a different answer.
    for (const sample of [PYTHON, '# just prose\n', '{"a": 1}', 'a: 1\nb: 2\n']) {
      expect(classifyContent(sample, 'stdin')).toBe(
        classifyContentShape(sample, 'stdin').contentType,
      );
    }
  });
});

describe('the probe proposes, the parser confirms', () => {
  const validator = new PythonValidator();

  // Each of these clears the structural rule — two or more strong signals, dense enough,
  // nothing disqualifying — and is then rejected because it does not parse. That is the
  // disposal of §6 risk 2: a fragment cannot introduce a validation failure, because a
  // detected item is one the validator has already accepted.
  const malformed: ReadonlyArray<readonly [string, string]> = [
    [
      'bad indent',
      'import os\nfrom sys import argv\n\ndef run(items):\n    total = 0\n      for item in items:\n        total += item\n    return total\n',
    ],
    [
      'unterminated string',
      'import os\nfrom sys import argv\n\ndef run(items):\n    label = "oops\n    return label\n',
    ],
    [
      'truncated mid-call',
      'import os\nfrom sys import argv\n\ndef run(items):\n    return sorted(items, key=lambda x: (x.a,\n',
    ],
  ];

  it('rejects structurally-Python content that does not parse', () => {
    for (const [name, source] of malformed) {
      // Invariant 10: assert the confirmation is what rejected it. If the structural rule had
      // already said no, this would pass while proving nothing about the parser step.
      expect(validator.validate(source).valid, `${name} unexpectedly parses`).toBe(false);
      expect(
        classifyContentShape(source, 'stdin').language,
        `${name} was detected`,
      ).toBeUndefined();
    }
  });

  it('leaves rejected content exactly where it was before the probe existed', () => {
    // "Misses fail to today's behaviour, which is the safe direction" (§4).
    for (const [name, source] of malformed) {
      const shape = classifyContentShape(source, 'stdin');
      expect(['text', 'markdown'], `${name} landed on ${shape.contentType}`).toContain(
        shape.contentType,
      );
    }
  });

  it('accepts the same content once it parses', () => {
    const fixed =
      'import os\nfrom sys import argv\n\ndef run(items):\n    total = 0\n    for item in items:\n        total += item\n    return total\n';

    expect(validator.validate(fixed).valid).toBe(true);
    expect(classifyContentShape(fixed, 'stdin').language).toBe('python');
  });
});

describe('the probe does not fire on anything else', () => {
  const walk = (dir: string, ext: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'dist', 'venv', '__pycache__'].includes(entry.name)) continue;
        walk(full, ext, out);
      } else if (entry.name.endsWith(ext)) {
        out.push(full);
      }
    }
    return out;
  };

  // The negative set is this repository, read **pathless** — which is the only way the probe
  // ever sees anything, since an extension short-circuits classification long before it.
  it('never claims one of this repository’s TypeScript sources', () => {
    const files = walk(resolve(ROOT, 'src'), '.ts');
    expect(files.length, 'no TypeScript sources found').toBeGreaterThan(40);

    const claimed = files.filter(
      (file) => classifyContentShape(readFileSync(file, 'utf8'), 'stdin').language === 'python',
    );
    expect(claimed).toEqual([]);
  });

  it('never claims one of this repository’s markdown documents', () => {
    const files = walk(resolve(ROOT, 'docs'), '.md');
    expect(files.length, 'no markdown documents found').toBeGreaterThan(0);

    const claimed = files.filter(
      (file) => classifyContentShape(readFileSync(file, 'utf8'), 'stdin').language === 'python',
    );
    expect(claimed).toEqual([]);
  });

  it('leaves JSON to the check that runs before it', () => {
    // §4: a JSON tool result scored 0.67 on a brace-and-semicolon code signal and was saved
    // only by `looksLikeJson` standing first. Probe order is load-bearing.
    const payload = JSON.stringify({ stage_3: { retry_count: 5, status: 'degraded' } }, null, 2);

    expect(classifyContentShape(payload, 'stdin')).toEqual({ contentType: 'json' });
  });

  it('leaves logs and YAML to the checks that run before it', () => {
    const logs = [
      '2026-07-30T19:00:12.144Z [WARN] Stage 3 circuit breaker opened',
      '2026-07-30T19:00:13.201Z [ERROR] Stage 3 retry budget exhausted',
      '2026-07-30T19:00:14.500Z [INFO] Stage 3 recovered',
    ].join('\n');
    const yaml = ['name: ci', 'on:', '  push:', '    branches: [main]'].join('\n');

    expect(classifyContentShape(logs, 'stdin').contentType).toBe('logs');
    expect(classifyContentShape(yaml, 'stdin').contentType).toBe('yaml');
  });

  it('needs more than one lonely signal', () => {
    // `strong >= 2` — one import in a paragraph of English is not a Python file.
    const prose = [
      'The deployment guide says to import the configuration before starting.',
      'Once that is done the service will pick up the new settings automatically.',
      'import os',
      '',
    ].join('\n');

    expect(classifyContentShape(prose, 'stdin').language).toBeUndefined();
  });
});

describe('end to end: a pathless Python file now reduces', () => {
  const config = loadConfig();

  it('reaches the file-argument route without a declaration', () => {
    const content = [
      'import os',
      '',
      'def collect(paths):',
      '    results = []',
      '    for path in paths:',
      '        stat = os.stat(path)',
      '        results.append((path, stat.st_size, stat.st_mtime))',
      '    results.sort(key=lambda entry: entry[1])',
      '    return results',
      '',
      'def summarize(paths):',
      '    collected = collect(paths)',
      '    total = sum(entry[1] for entry in collected)',
      '    largest = collected[-1] if collected else None',
      '    return {"count": len(collected), "total": total, "largest": largest}',
      '',
    ].join('\n');

    const withBudget = (request: ReturnType<typeof parse>) =>
      optimize({ ...request, budget: { ...request.budget, targetReductionRatio: 0.3 } });

    const probed = withBudget(parse(content, config, { sourceKind: 'stdin' }));
    const viaPath = withBudget(
      parse(content, config, { sourceKind: 'file', sourcePath: 'collect.py' }),
    );

    expect(probed.trace.astCoverage).toEqual({
      checked: 1,
      unchecked: 0,
      uncheckedContentTypes: [],
    });
    expect(probed.fallbackUsed).toBe(false);
    expect(probed.trace.tokenAfter).toBeLessThan(probed.trace.tokenBefore);
    expect(probed.emittedOutput).toBe(viaPath.emittedOutput);
  });

  it('is deterministic — the probe is a pure function of the bytes', () => {
    const content = PYTHON.repeat(3);
    const run = () =>
      optimize({
        ...parse(content, config, { sourceKind: 'stdin' }),
        budget: { ...loadConfig().budget, targetReductionRatio: 0.3 },
      }).emittedOutput;

    const outputs = new Set([run(), run(), run(), run()]);
    expect(outputs.size).toBe(1);
  });
});
