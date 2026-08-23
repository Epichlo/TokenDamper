import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from '../../src/adapters/cli';
import { handleToolCall, TOOL_DEFINITIONS } from '../../src/adapters/mcp/tools';
import {
  fixtureToOptimizationRequest,
  loadBenchmarkFixtures,
} from '../../src/bench/fixtures/loader';
import type { BenchmarkFixture } from '../../src/bench/fixtures/types';
import { loadConfig } from '../../src/config/load';
import { runCli } from '../../src/cli/main';
import { optimize } from '../../src/core/engine';
import { TokenHasher } from '../../src/core/hashing/token-hasher';
import { DriftTracker } from '../../src/core/ledger/drift-tracker';
import {
  contentTypeForLanguage,
  createBundleFromItems,
  createContextBundle,
  createContextItem,
  createOptimizationBudget,
  declarableLanguages,
  normalizeLanguage,
  type DeclaredLanguage,
} from '../../src/core/model/constructors';
import { GatewaySessionStore } from '../../src/gateway/session-store';
import { selectValidator, validateItemAst } from '../../src/core/validation/ast';

/**
 * Phase 4b.1 — the caller declares what the content is.
 *
 * Two of the three entry modes are pathless by construction (`optimize -` has no filename,
 * an MCP `optimize_context` call is a string in a JSON-RPC frame), and `createContextBundle`
 * derived everything from `sourcePath` plus a content probe. With no path, TypeScript
 * classified as `text`/`html`, `selectValidator` returned null, `selectElisionRegions` found
 * no language, and the item fell to whole-item hashing where `S_k` pins at 0.60 and the
 * pipeline falls back. Measured over two frozen corpora, the stdin route saved 0.07% (repo
 * TypeScript) and 0.02% (pip Python) against 19.27% and 12.34% for the same bytes passed as
 * a file argument.
 *
 * `item.language` already existed, was already first in `selectValidator`'s precedence, and
 * was populated by no adapter at all.
 */
const PY = [
  'import os',
  '',
  'def load(path):',
  '    # read it',
  '    return os.stat(path)',
  '',
].join('\n');

const TS = [
  'export function beta(items: Array<string>): string {',
  '  const label = items.join(",");',
  '  return label;',
  '}',
  '',
].join('\n');

const BROKEN_TS = [
  'export function beta(items: Array<string>): string {',
  '  const label = "unterminated;',
  '  return label;',
  '}',
].join('\n');

describe('normalizeLanguage', () => {
  it('canonicalizes aliases, case and surrounding space', () => {
    expect(normalizeLanguage('py')).toBe('python');
    expect(normalizeLanguage('Python')).toBe('python');
    expect(normalizeLanguage('  PY  ')).toBe('python');
    expect(normalizeLanguage('ts')).toBe('typescript');
    expect(normalizeLanguage('tsx')).toBe('typescript');
    expect(normalizeLanguage('c++')).toBe('cpp');
    expect(normalizeLanguage('yml')).toBe('yaml');
  });

  it('returns undefined for an unrecognized declaration rather than a guess', () => {
    expect(normalizeLanguage('kotlin')).toBeUndefined();
    expect(normalizeLanguage('pyton')).toBeUndefined();
    expect(normalizeLanguage('')).toBeUndefined();
    expect(normalizeLanguage(undefined)).toBeUndefined();
  });

  it('maps the h extension spelling to c, in parity with the .h filename route', () => {
    // Audit L3 recorded this alias rather than removing it: the table accepts extension
    // spellings on purpose, so `--language h` must keep behaving like a `.h` file does —
    // `code`, no validator — and removing one side while keeping the other is the drift the
    // table exists to prevent. If this test ever fails because someone removed the alias,
    // remove the `.h` extension from the filename route in the same change or restore both.
    expect(normalizeLanguage('h')).toBe('c');
  });

  it('accepts every spelling it advertises, and every canonical name is a spelling', () => {
    // Invariant 10: without this the two assertions below could pass over an empty list.
    expect(declarableLanguages().length).toBeGreaterThan(20);

    for (const spelling of declarableLanguages()) {
      const canonical = normalizeLanguage(spelling);
      expect(canonical, `advertised but unrecognized: ${spelling}`).toBeDefined();
      // Canonical names round-trip, so `item.language` is always a value this table knows.
      expect(normalizeLanguage(canonical)).toBe(canonical);
      expect(contentTypeForLanguage(canonical as DeclaredLanguage)).toBeDefined();
    }
  });
});

describe('a declaration sets language and contentType together', () => {
  it('tags pathless Python as code and carries the canonical language', () => {
    const bundle = createContextBundle(PY, 'stdin', undefined, undefined, 'py');
    const item = bundle.items[0]!;

    expect(item.contentType).toBe('code');
    expect(item.language).toBe('python');
  });

  it('sends declared Python to the Python validator, not the TypeScript one', () => {
    const item = createContextBundle(PY, 'stdin', undefined, undefined, 'python').items[0]!;

    expect(selectValidator(item)?.language).toBe('python');
  });

  it('pins why the two fields must move together: contentType alone selects nothing', () => {
    // The hazard changed shape in Phase C; it did not go away, which is why this pin stays.
    //
    // It used to be *wrong* validation: `CONTENT_TYPE_VALIDATORS.code` was the TypeScript
    // validator, so a `code` tag without a language was how Python got checked by the wrong
    // checker — the trap `docs/phase-4b-pathless-code-scope.md` §6.3 named. That mapping is [retired]
    // now `null`, because `code` is a *family*, not a language, and lexing the whole family
    // as TypeScript invented findings rather than weakening them (perl 39/40, tcl 30/40,
    // shell 22/40).
    //
    // So a `code` tag without a language is now *absent* validation instead: the item
    // reports `validated: false` and appears on `trace.astCoverage` rather than arriving as
    // a confident pass (DECISIONS §23). Either way the tag alone is not enough, and the
    // declaration route avoids it by never setting one field without the other.
    const untagged = createContextItem({
      id: 'no-language',
      kind: 'file',
      contentType: 'code',
      content: PY,
    });

    expect(selectValidator(untagged)).toBeNull();
  });

  it('does not harvest Python comments as markdown headings', () => {
    // The other half of the coupling. `text` is in `DriftTracker`'s MARKDOWN_MARKER_TYPES, so
    // declaring only the language would leave `#` comment leaders read as headings — markers
    // invented before the elision, then "destroyed" by it (DECISIONS §18).
    const tracker = new DriftTracker();
    const commented = '# alpha\n# beta\nvalue = 1\n';

    const probed = createBundleFromItems(
      createContextBundle(commented, 'stdin').items.map((item) => item),
      'text',
    );
    const declared = createBundleFromItems(
      createContextBundle(commented, 'stdin', undefined, undefined, 'python').items.map(
        (item) => item,
      ),
      'text',
    );

    // Until Phase A's seam 2 this asserted `markdown` and two fabricated headings: two comment
    // lines were enough for a Python file to be read as a document, because a bare `#` line was
    // sufficient evidence. A `#` line no longer is, so this content — which the Python probe
    // also declines, having only one strong signal — now lands in `text`.
    //
    // The declaration is still what makes the difference that matters: `text` reaches no
    // validator, while `python` reaches `PythonValidator`. What has changed is that failing to
    // declare no longer *invents* structure on top of failing to check.
    expect(probed.items[0]?.contentType).toBe('text');
    expect(
      [...tracker.extractMarkers(probed)].filter((m) => m.startsWith('heading:')),
    ).toHaveLength(0);
    expect(
      [...tracker.extractMarkers(declared)].filter((m) => m.startsWith('heading:')),
    ).toHaveLength(0);
  });
});

describe('precedence: declaration > extension > probe', () => {
  it('outranks a filename extension that says otherwise', () => {
    const bundle = createContextBundle(PY, 'file', 'notes.txt', undefined, 'python');
    const item = bundle.items[0]!;

    expect(item.contentType).toBe('code');
    expect(selectValidator(item)?.language).toBe('python');
  });

  it('outranks the content probe, which is what the pathless route was left with', () => {
    const probed = createContextBundle(TS, 'stdin').items[0]!;
    const declared = createContextBundle(TS, 'stdin', undefined, undefined, 'typescript').items[0]!;

    expect(selectValidator(probed)).toBeNull();
    expect(validateItemAst(probed).validated).toBe(false);

    expect(selectValidator(declared)?.language).toBe('typescript');
    expect(validateItemAst(declared).validated).toBe(true);
  });

  it('makes a broken pathless file fail the check it was previously exempt from', () => {
    const probed = createContextBundle(BROKEN_TS, 'stdin').items[0]!;
    const declared = createContextBundle(BROKEN_TS, 'stdin', undefined, undefined, 'ts').items[0]!;

    // The §23 shape: `valid: true` with `validated: false` is "nothing looked", not a pass.
    expect(validateItemAst(probed).valid).toBe(true);
    expect(validateItemAst(probed).validated).toBe(false);

    const checked = validateItemAst(declared);
    expect(checked.validated).toBe(true);
    expect(checked.valid).toBe(false);
    expect(checked.issues.length).toBeGreaterThan(0);
  });

  it('classifies by extension when a language is declared for a document type', () => {
    const yaml = createContextBundle('a: 1\nb: 2\n', 'stdin', undefined, undefined, 'yaml');
    expect(yaml.items[0]?.contentType).toBe('yaml');
  });
});

describe('an undeclared bundle is unchanged', () => {
  it('produces the same id, content type and shape it did before the parameter existed', () => {
    const bundle = createContextBundle('const answer = 42;\n', 'stdin');

    // Pinned against the pre-change build (dist at 5b19394). The declaration is spread into
    // the item and the hash only when present, so no existing id may move.
    expect(bundle.id).toBe('e620ce492587b2156b3e07db0db1d9384451134e65fba7e6a165adfc0ef1e938');
    expect(bundle.items[0]?.contentType).toBe('text');
    expect('language' in bundle.items[0]!).toBe(false);
  });

  it('ignores an unrecognized declaration rather than half-applying it', () => {
    // The adapters reject this before it gets here (see the CLI and MCP cases below). If one
    // ever stops, the model must not invent a content type from a language it cannot resolve —
    // it must fall through to classification exactly as if nothing had been declared. Since
    // 4b.2 that fall-through may itself detect a language, so the assertion is equality with
    // the undeclared result rather than a literal `text`.
    const declared = createContextBundle(PY, 'stdin', undefined, undefined, 'kotlin');
    const undeclared = createContextBundle(PY, 'stdin');

    expect(declared.items[0]?.contentType).toBe(undeclared.items[0]?.contentType);
    expect(declared.items[0]?.language).toBe(undeclared.items[0]?.language);
    expect(declared.id).toBe(undeclared.id);
    expect(declared.items[0]?.language).not.toBe('kotlin');
  });
});

describe('end to end: the declared route reaches what the file route reaches', () => {
  const config = loadConfig();

  const withBudget = (request: ReturnType<typeof parse>) =>
    optimize({ ...request, budget: { ...request.budget, targetReductionRatio: 0.3 } });

  it('reduces pathless Python, and agrees with the file route byte for byte', () => {
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

    const declared = withBudget(
      parse(content, config, { sourceKind: 'stdin', language: 'python' }),
    );
    const viaPath = withBudget(
      parse(content, config, { sourceKind: 'file', sourcePath: 'collect.py' }),
    );

    expect(declared.trace.astCoverage).toEqual({
      checked: 1,
      unchecked: 0,
      uncheckedContentTypes: [],
    });
    expect(declared.fallbackUsed).toBe(false);
    expect(declared.trace.tokenAfter).toBeLessThan(declared.trace.tokenBefore);

    // The claim 4b.1 is actually making — parity with the one route that works. Measured
    // byte-identical on all 45 files of a frozen pip corpus and all 64 of this repo's.
    expect(declared.emittedOutput).toBe(viaPath.emittedOutput);

    // Since 4b.2 the undeclared route reaches the same place *for Python*, by detection
    // rather than declaration. Declaring is still not redundant — see the TypeScript case.
    const probed = withBudget(parse(content, config, { sourceKind: 'stdin' }));
    expect(probed.emittedOutput).toBe(viaPath.emittedOutput);
  });

  it('still needs the declaration for TypeScript, which is deliberately never probed', () => {
    // §4 of the scope doc: TypeScript positives and prose negatives overlap on this corpus —
    // the repository's own prose is documentation *about* TypeScript, dense with fenced
    // TypeScript — so no threshold orders them and no TS probe is proposed, now or later.
    const content = [
      'export function collect(paths: string[]): Array<[string, number]> {',
      '  const results: Array<[string, number]> = [];',
      '  for (const path of paths) {',
      '    results.push([path, path.length]);',
      '  }',
      '  results.sort((left, right) => left[1] - right[1]);',
      '  return results;',
      '}',
      '',
      'export function summarize(paths: string[]): number {',
      '  const collected = collect(paths);',
      '  let total = 0;',
      '  for (const entry of collected) {',
      '    total += entry[1];',
      '  }',
      '  return total;',
      '}',
      '',
    ].join('\n');

    const probed = withBudget(parse(content, config, { sourceKind: 'stdin' }));
    const declared = withBudget(
      parse(content, config, { sourceKind: 'stdin', language: 'typescript' }),
    );

    expect(probed.trace.astCoverage).toEqual({
      checked: 0,
      unchecked: 1,
      uncheckedContentTypes: ['text'],
    });

    // The outcome this test is named for is unchanged: undeclared TypeScript over stdin gives
    // you your content back, byte for byte, and only the declaration unlocks the reduction.
    //
    // **How it arrives there changed** — audit H5, §43. It used to whole-item elide (no regions
    // are selected for an item classified `text`), be refused by drift, and fall back. Since
    // whole-item elision of a symbol-bearing item can never survive validation, it is no longer
    // attempted, so the content is never transformed and no fallback is needed. Asserting
    // `emittedOutput` rather than `fallbackUsed` states the guarantee that actually matters, and
    // stops the test depending on which of two mechanisms produced an identical result.
    expect(probed.emittedOutput).toBe(content);

    expect(declared.trace.astCoverage).toEqual({
      checked: 1,
      unchecked: 0,
      uncheckedContentTypes: [],
    });
    expect(declared.fallbackUsed).toBe(false);
    expect(declared.trace.tokenAfter).toBeLessThan(declared.trace.tokenBefore);
  });

  it('extends §28 to the pathless route: a barrel is refused instead of deleted', () => {
    // The live instance from `5b19394` arriving by the other door. §28 refused to certify an
    // elision only when an AST validator covered the item — and nothing covers a pathless one,
    // so over stdin the same barrel was still elided whole, unwitnessed, at S_k = 0.00.
    //
    // **Phase A closed the undeclared half too.** The measurement gate no longer keys on
    // validator coverage, so the barrel is refused over stdin whether or not a language is
    // declared. Both arms below now assert a refusal; before Phase A the first asserted the
    // hole. What the declaration still changes is *coverage* — `symbolBearingItems` goes
    // 0 -> 1 — which is what §29 was actually for.
    const content =
      Array.from({ length: 14 }, (_, i) => `export * from './module-number-${i}';`).join('\n') +
      '\n';

    const probed = optimize({
      ...parse(content, config, { sourceKind: 'stdin' }),
      budget: { ...loadConfig().budget, targetReductionRatio: 0.3 },
    });

    expect(probed.trace.stageCount).toBeGreaterThan(0);
    expect(probed.fallbackUsed).toBe(true);
    expect(probed.emittedOutput).toBe(content);
    expect(probed.validation.issues.map((issue) => issue.code)).toContain(
      'SEMANTIC_DRIFT_UNMEASURABLE',
    );
    // Still uncovered — the refusal no longer depends on coverage.
    expect(probed.validation.driftCoverage?.symbolBearingItems).toBe(0);

    const declared = optimize({
      ...parse(content, config, { sourceKind: 'stdin', language: 'typescript' }),
      budget: { ...loadConfig().budget, targetReductionRatio: 0.3 },
    });

    expect(declared.validation.issues.map((issue) => issue.code)).toContain(
      'SEMANTIC_DRIFT_UNMEASURABLE',
    );
    expect(declared.fallbackUsed).toBe(true);
    expect(declared.emittedOutput).toBe(content);
    expect(declared.validation.driftCoverage?.symbolBearingItems).toBe(1);
  });
});

describe('the benchmark loader declares too', () => {
  // The third `createOptimizationRequest` call site, and the last one that was still guessing
  // with the answer in hand: `BenchmarkFixture.language` is a *required* field and
  // `fixtureToOptimizationRequest` dropped it, leaving `classifyContent` to re-derive a type
  // from the filename.
  const budget = createOptimizationBudget({ targetReductionRatio: 0.3, preserveKinds: [] });

  const fixture = (overrides: Partial<BenchmarkFixture>): BenchmarkFixture => ({
    id: 'probe',
    dataset: 'codexglue',
    prompt: PY,
    referenceCompletion: '',
    language: 'python',
    path: 'src/item_probe.txt',
    metadata: {},
    ...overrides,
  });

  it('covers a fixture whose synthesized path hides its language', () => {
    // `codexglue.ts` synthesizes `src/item_<id>.txt` when a fixture carries no path. That
    // classifies `text`, so a Python fixture reached the engine with no validator and a
    // guaranteed fallback — the 4b.1 defect inside the harness that publishes the numbers.
    const content = [
      'import os',
      '',
      'def collect(paths):',
      '    results = []',
      '    for path in paths:',
      '        stat = os.stat(path)',
      '        results.append((path, stat.st_size, stat.st_mtime))',
      '    return results',
      '',
    ].join('\n');

    const request = fixtureToOptimizationRequest(fixture({ prompt: content }), budget);

    expect(request.bundle.items[0]?.language).toBe('python');
    expect(request.bundle.items[0]?.contentType).toBe('code');

    const result = optimize(request);
    expect(result.trace.astCoverage).toEqual({
      checked: 1,
      unchecked: 0,
      uncheckedContentTypes: [],
    });
    expect(result.fallbackUsed).toBe(false);
    expect(result.trace.tokenAfter).toBeLessThan(result.trace.tokenBefore);
  });

  it('agrees with the path on every bundled fixture, so no published number moves', () => {
    // How "zero movement on the bench corpus" is held structurally rather than by a recorded
    // number: for each bundled fixture the validator chosen from the declaration must be the
    // one the extension would have chosen anyway. A fixture whose path and language disagree
    // would change a published result, and this is where that shows up.
    const fixtures = loadBenchmarkFixtures().fixtures;
    expect(fixtures.length, 'no bundled fixtures loaded').toBeGreaterThan(5);

    for (const entry of fixtures) {
      const declared = fixtureToOptimizationRequest(entry, budget).bundle.items[0]!;
      const pathOnly = createContextItem({
        id: declared.id,
        kind: declared.kind,
        contentType: declared.contentType,
        content: declared.content,
        ...(declared.path ? { path: declared.path } : {}),
      });

      // Invariant 10: without this the comparison below is `pathOnly` against `pathOnly` and
      // passes for the very build that does not declare at all.
      expect(declared.language, `${entry.id}: loader dropped the declaration`).toBeDefined();

      expect(
        selectValidator(declared)?.language,
        `${entry.id}: declaration and path disagree`,
      ).toBe(selectValidator(pathOnly)?.language);
    }
  });

  it('fails closed on a false declaration: prose called Python is refused, not mangled', () => {
    // Found by this change breaking `test/integration/bench.test.ts` Test 2, whose fixtures
    // were English prose carrying `language: 'python'`. Believing the declaration is correct
    // behaviour and the fixture was wrong — but the failure mode is worth pinning, because a
    // user will eventually run `--language python` over a README.
    //
    // §28 exempts prose only because *no validator covers it*. A false declaration drags it
    // under one, the extractor finds no Python symbols in English, and drift refuses to
    // certify. The cost is the optimization, never the content.
    const prose =
      'This is a long technical prompt context providing detailed background information, ' +
      'architecture specifications, API schemas, and deployment guidelines.';

    const result = optimize(
      fixtureToOptimizationRequest(
        fixture({ prompt: prose, path: 'bench_context1.txt' }),
        createOptimizationBudget({ maxInputTokens: 50, targetReductionRatio: 0.3 }),
      ),
    );

    expect(result.validation.issues.map((issue) => issue.code)).toContain(
      'SEMANTIC_DRIFT_UNMEASURABLE',
    );
    expect(result.fallbackUsed).toBe(true);
    expect(result.emittedOutput).toBe(prose);
  });
});

describe('CLI', () => {
  const io = () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      stdout,
      stderr,
      streams: {
        stdout: { write: (chunk: unknown) => (stdout.push(String(chunk)), true) } as never,
        stderr: { write: (chunk: unknown) => (stderr.push(String(chunk)), true) } as never,
      },
    };
  };

  it('rejects an unrecognized --language instead of silently ignoring it', () => {
    const sink = io();
    const exitCode = runCli(['optimize', '-', '--language', 'kotlin'], sink.streams, process.cwd());

    expect(exitCode).toBe(1);
    expect(sink.stderr.join('')).toContain('Invalid value for --language: kotlin');
    // The accepted set is printed from the table, not restated beside it.
    expect(sink.stderr.join('')).toContain('python');
    expect(sink.stdout.join('')).toBe('');
  });

  it('requires a value for --language', () => {
    const sink = io();
    expect(runCli(['optimize', '-', '--language'], sink.streams, process.cwd())).toBe(1);
    expect(sink.stderr.join('')).toContain('Missing value for --language.');
  });

  it('refuses --input-name alongside a real file argument', () => {
    const sink = io();
    const exitCode = runCli(
      ['optimize', 'test/fixtures/sample.txt', '--input-name', 'other.py'],
      sink.streams,
      process.cwd(),
    );

    expect(exitCode).toBe(1);
    expect(sink.stderr.join('')).toContain('--input-name applies to stdin input only');
  });

  it('applies --language over the extension of the file it was given', () => {
    // A `.txt` extension is unrecognized by `classifyContent`, so this file is probe-classified
    // and unchecked without the flag — the same hole as stdin, reachable without one.
    //
    // The content is TypeScript on purpose. Python would be *detected* since 4b.2, which would
    // leave this test asserting the probe rather than the precedence rule it is named for.
    const dir = mkdtempSync(join(tmpdir(), 'td-declared-'));
    const file = join(dir, 'snippet.txt');
    writeFileSync(file, TS, 'utf8');

    const probed = io();
    expect(runCli(['optimize', file], probed.streams, process.cwd())).toBe(0);
    expect(JSON.parse(probed.stderr.join('')).astCoverage.checked).toBe(0);

    const declared = io();
    expect(runCli(['optimize', file, '--language', 'ts'], declared.streams, process.cwd())).toBe(0);
    const trace = JSON.parse(declared.stderr.join(''));
    expect(trace.astCoverage).toEqual({ checked: 1, unchecked: 0, uncheckedContentTypes: [] });
  });
});

describe('MCP optimize_context', () => {
  const context = () => ({
    sessionStore: new GatewaySessionStore(),
    tokenHasher: new TokenHasher(),
    config: loadConfig(),
  });

  it('advertises the declaration in its input schema', () => {
    const tool = TOOL_DEFINITIONS.find((definition) => definition.name === 'optimize_context');
    const properties = tool?.inputSchema.properties as Record<string, unknown> | undefined;

    expect(properties?.language).toBeDefined();
    expect(properties?.path).toBeDefined();
  });

  it('rejects an unsupported language', async () => {
    const result = await handleToolCall(
      'optimize_context',
      { rawInput: PY, language: 'kotlin' },
      context(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('unsupported language "kotlin"');
  });

  it('optimizes declared Python that it would otherwise leave untouched', async () => {
    const rawInput = [
      'def render(rows):',
      '    lines = []',
      '    for row in rows:',
      '        lines.append(" | ".join(str(cell) for cell in row))',
      '        lines.append("-" * 40)',
      '    return "\\n".join(lines)',
      '',
    ].join('\n');

    const probed = JSON.parse(
      (await handleToolCall('optimize_context', { rawInput, maxInputTokens: 32 }, context()))
        .content[0]!.text!,
    );
    const declared = JSON.parse(
      (
        await handleToolCall(
          'optimize_context',
          { rawInput, language: 'python', maxInputTokens: 32 },
          context(),
        )
      ).content[0]!.text!,
    );

    expect(probed.fallbackUsed).toBe(true);
    expect(probed.tokensSaved).toBe(0);

    expect(declared.fallbackUsed).toBe(false);
    expect(declared.tokensSaved).toBeGreaterThan(0);
  });
});
