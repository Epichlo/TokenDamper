#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CLI_ADAPTER_NAME, CLI_ADAPTER_VERSION, format as formatCliOutput, parse } from '../adapters/cli';
import { createMultiItemRequest } from '../core/model/constructors';
import { ITEM_DELIMITER_PREFIX, ITEM_DELIMITER_SUFFIX } from '../core/render';
import { ingestPaths, type IngestedFile } from './ingest';
import { loadConfig } from '../config';
import { declarableLanguages, normalizeLanguage } from '../core/model';
import type { ContextBundle } from '../core/model/types';
import { optimize } from '../core/engine';
import { runExecCommand } from '../gateway/exec';
import { renderTerminalDiff } from './diff-renderer';
import { generateHtmlReport } from './html-reporter';
import { loadBenchmarkFixtures, BenchmarkRunner } from '../bench';
import { renderBenchTable } from './bench-table-renderer';
import { startMcpServer } from '../adapters/mcp';
import type { BenchmarkRunnerConfig } from '../bench/types';
import type { ConfigOverrides } from '../config';

/**
 * Runs the TokenDamper CLI with the provided arguments and IO streams.
 *
 * Returns `number` for every command except `exec`, which returns `Promise<number>` because its
 * exit code belongs to a child process that has not finished yet (audit OX-H1). The union is
 * deliberate: making the whole function `async` would turn a synchronous `number` into a promise
 * for `optimize`, `bench` and `mcp`, none of which need one, and every existing caller reads the
 * result directly. `await` handles both, so a caller that does not care which it got is correct
 * either way.
 */
export function runCli(
  argv: readonly string[],
  io: { readonly stdout: NodeJS.WritableStream; readonly stderr: NodeJS.WritableStream } = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
  cwd: string = process.cwd(),
): number | Promise<number> {
  try {
    const parsed = parseArguments(argv, cwd);

    if (parsed.command === 'mcp') {
      const config = loadConfig({
        cwd,
        ...(parsed.configPath ? { configPath: parsed.configPath } : {}),
        ...(parsed.configOverrides ? { cliOverrides: parsed.configOverrides } : {}),
      });
      const server = startMcpServer({
        input: process.stdin,
        output: io.stdout as NodeJS.WritableStream,
        log: io.stderr as NodeJS.WritableStream,
        config,
      });

      const shutdown = () => {
        server.stop();
        process.removeListener('SIGINT', shutdown);
        process.removeListener('SIGTERM', shutdown);
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      return 0;
    }

    if (parsed.command === 'exec') {
      // Returned, not fired and forgotten. `runExecCommand` always resolved the child's real exit
      // code; this branch used to drop it on the floor and hand back a synchronous `0`, which
      // `main()` had assigned to `process.exitCode` long before the child finished (audit OX-H1).
      // `tokendamper exec -- some-tool && next-step` therefore ran `next-step` after a failure.
      return runExecCommand(parsed.execArgs, { io }).catch((err: Error) => {
        io.stderr.write(`Exec process error: ${err.message}\n`);
        // Reached only when the child could not be spawned at all. A command that simply does not
        // exist does not land here — `shell: true` means the shell starts, diagnoses it, and
        // exits with its own code (127 on sh, 1 on cmd.exe), which arrives through `close`.
        return 1;
      });
    }

    if (parsed.command === 'bench') {
      // No default path. It used to fall back to the literal `test/fixtures/bench`, which
      // exists only in a checkout of this repository — for an installed user that resolved to
      // nothing and `bench` threw before running a fixture (audit M10). Absent, the loader
      // uses the datasets bundled with the package, which is what the repo path resolved to
      // anyway.
      const rawDatasetPath = parsed.datasetPath || (parsed.inputPath !== '-' ? parsed.inputPath : undefined);
      let loadArg: string | undefined = rawDatasetPath;

      // Resolved against `cwd` rather than `process.cwd()`: `runCli` takes its working
      // directory as a parameter, and the loader's own directory check cannot see it.
      if (rawDatasetPath !== undefined) {
        const resolvedPath = resolve(cwd, rawDatasetPath);
        if (existsSync(resolvedPath) && statSync(resolvedPath).isDirectory()) {
          loadArg = undefined;
        }
      }

      const fixtures = loadBenchmarkFixtures(loadArg);
      const config = loadConfig({
        cwd,
        ...(parsed.configPath ? { configPath: parsed.configPath } : {}),
        ...(parsed.configOverrides ? { cliOverrides: parsed.configOverrides } : {}),
      });

      const runnerConfig: BenchmarkRunnerConfig = {
        baseConfig: config,
        sweeps: [
          {
            sweepId: 'cli-sweep',
            budget: config.budget,
          },
        ],
      };

      const report = BenchmarkRunner.run(fixtures, runnerConfig);

      if (!parsed.quiet) {
        const tableOutput = renderBenchTable(report);
        io.stdout.write(`${tableOutput}\n`);
      }

      if (parsed.reportJsonPath) {
        const reportPath = resolve(cwd, parsed.reportJsonPath);
        writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
      }

      return 0;
    }

    if (parsed.command !== 'optimize') {
      io.stderr.write(
        'Usage: tokendamper optimize <input-file|-> | tokendamper bench [dataset-path] | tokendamper exec -- <command> | tokendamper mcp\n',
      );
      return 1;
    }

    const isStdin = parsed.inputPath === '-';

    // Multi-file ingestion — the route that makes the 0/1 knapsack reachable (audit H5).
    //
    // Entered only when the caller named more than one path, or named a directory. A single
    // file and stdin fall through to the original code below **unchanged**: that route carries
    // the byte-identity guarantee of DECISIONS §35, and the cheapest way to keep it is not to
    // touch it.
    const extraPaths = parsed.extraInputPaths ?? [];
    const namesDirectory =
      !isStdin && existsSync(resolve(cwd, parsed.inputPath)) && statSync(resolve(cwd, parsed.inputPath)).isDirectory();

    if (!isStdin && (extraPaths.length > 0 || namesDirectory)) {
      if (parsed.language !== undefined) {
        // Refused rather than applied to every file (audit OX-M3). `--language` exists for input
        // with no filename to classify by; a directory walk and a list of paths both have one per
        // file, so a blanket declaration can only *overwrite* a correct answer with a single
        // wrong one — declaration outranks extension by design (`constructors.ts`).
        //
        // Measured on a three-file tree at `--language python`: `languageSupport` went from
        // "1 unsupported (json)" to "3 supported, 0 unsupported", `astCoverage` still read
        // `unchecked: 0` because the Python validator genuinely did look at the JSON, and the run
        // fell back entirely. So the cost is not merely a mislabel — it is a coverage report that
        // lies and a guaranteed 0% behind it.
        throw new Error(
          '--language applies to stdin or a single file; a directory or multiple paths are classified per file by extension. ' +
            'Declaring one language for all of them would override every file’s own type. Optimize the files individually to declare a language.',
        );
      }

      return runMultiFileOptimize(parsed, [parsed.inputPath, ...extraPaths], io, cwd);
    }

    const inputPath = isStdin ? undefined : resolve(cwd, parsed.inputPath);

    // Read bytes, decode second, and keep the bytes.
    //
    // This used to be `readFileSync(path, 'utf8')`, which is lossy before the pipeline starts:
    // any byte that is not valid UTF-8 becomes U+FFFD, and U+FFFD re-encodes to three bytes.
    // The fallback path returns `request.rawInput`, so "fail-open hands the caller their input
    // back" was true only for input that happened to be valid UTF-8. Measured on a frozen
    // corpus, `vimspell.sh` — Latin-1, containing "Fernández-Sanguino_Peña" — came back
    // 1,462 -> 1,466 bytes with `fallbackUsed: true`. That is invariant 3 failing quietly.
    const rawBuffer = inputPath ? readFileSync(inputPath) : readFileSync(0);
    const rawInput = rawBuffer.toString('utf8');
    // Round-trip, not a BOM or charset sniff: the only question that matters is whether these
    // exact bytes survive the string model the whole pipeline is built on.
    const inputSurvivesDecoding = Buffer.from(rawInput, 'utf8').equals(rawBuffer);
    const config = loadConfig({
      cwd,
      ...(parsed.configPath ? { configPath: parsed.configPath } : {}),
      ...(parsed.configOverrides ? { cliOverrides: parsed.configOverrides } : {}),
    });
    // `--input-name` is a declared name, not a location: it is never resolved against `cwd`
    // and never opened. Resolving it would put a fabricated absolute path on `item.path` and
    // into the `filepath:` marker, asserting that a file exists where none does.
    const declaredPath = inputPath ?? parsed.inputName;
    const request = parse(rawInput, config, {
      sourceKind: isStdin ? 'stdin' : 'file',
      ...(declaredPath ? { sourcePath: declaredPath } : {}),
      ...(parsed.language ? { language: parsed.language } : {}),
    });

    // Input the string model cannot represent forces a fallback rather than short-circuiting.
    //
    // Falling back is the honest outcome, not a conservative one: every stage, validator and
    // token estimate downstream operates on the decoded string, so for these bytes they would
    // all be reasoning about content the caller never sent, and a "reduction" measured against
    // corrupted input is worse than none. It goes through the engine so the run still produces
    // a trace — returning early here emitted no trace at all, which a consumer cannot tell
    // apart from a silent crash.
    const result = optimize(request, {
      ...(parsed.maxDebt !== undefined ? { maxDebtThreshold: parsed.maxDebt } : {}),
      ...(parsed.maxDrift !== undefined ? { maxDriftThreshold: parsed.maxDrift } : {}),
      ...(parsed.keepDocstrings ? { keepDocstrings: true } : {}),
      ...(inputSurvivesDecoding
        ? {}
        : {
            inputNotRepresentable: `Input is not valid UTF-8 (${rawBuffer.length} bytes); it cannot be represented losslessly as a string, so no stage output can be trusted against it. Emitted verbatim.`,
          }),
    });

    // On fallback, write the bytes that were read rather than the string that was decoded from
    // them. `resolveFallback` returns `request.rawInput`, so for valid UTF-8 this is the same
    // output byte for byte; for anything else it is the difference between the caller's file
    // and a lossy re-encoding of it. The guard above means this branch is currently reached
    // only by round-trippable input — it is here so the guarantee does not depend on that.
    if (result.fallbackUsed) {
      io.stdout.write(rawBuffer);
    } else {
      io.stdout.write(formatCliOutput(result));
    }

    if (parsed.diff) {
      const diffStr = renderTerminalDiff(request.bundle, result.finalBundle);
      io.stdout.write(`\n${diffStr}\n`);
    }

    if (parsed.diffHtmlPath) {
      const htmlPath = resolve(cwd, parsed.diffHtmlPath);
      generateHtmlReport(result, request.bundle, { outputPath: htmlPath });
    }

    io.stderr.write(`${JSON.stringify(result.trace, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown TokenDamper error';
    io.stderr.write(`${message}\n`);
    return 1;
  }
}

/**
 * `optimize` over more than one file.
 *
 * This is the ingestion path audit H5 asked for. Until it existed, `createContextBundle` produced
 * exactly one item for every shipping entry point, so `applyCacheAwarePrefixLocking` pinned item
 * 0, `solve01Knapsack` always selected it, `itemsPruned` was always 0, and roughly a thousand
 * lines — the knapsack solver, cache-aware prefix locking, topology scoring, the dependency graph,
 * the git inspector — could not affect any output the product was able to produce. Measured on a
 * six-file bundle from this repository at `maxInputTokens: 5000`, the pruner now removes 3 items
 * and saves 897 tokens.
 *
 * Two properties are load-bearing, and are asserted in `test/integration/cli-multi-file.test.ts`:
 *
 *   - **Fail-open is per file.** Each file's original *bytes* are written back inside the
 *     envelope, not a re-encoding of the decoded string, so a file that is not valid UTF-8
 *     survives exactly as the single-file route guarantees (DECISIONS §35). What is *not*
 *     byte-identical is the stream as a whole, because the headers are TokenDamper's and were
 *     never in any input file.
 *   - **Order is deterministic.** `expandPath` sorts, because prefix locking pins the first
 *     ~1,024 tokens and therefore decides which files bypass the knapsack entirely
 *     (invariants 6 and 7).
 */
function runMultiFileOptimize(
  parsed: ParsedArguments,
  paths: readonly string[],
  io: { readonly stdout: NodeJS.WritableStream; readonly stderr: NodeJS.WritableStream },
  cwd: string,
): number {
  const files = ingestPaths(paths, cwd);
  if (files.length === 0) {
    io.stderr.write('No ingestible files found for the given path(s).\n');
    return 1;
  }

  const config = loadConfig({
    cwd,
    ...(parsed.configPath ? { configPath: parsed.configPath } : {}),
    ...(parsed.configOverrides ? { cliOverrides: parsed.configOverrides } : {}),
  });

  const request = createMultiItemRequest(
    files.map((file) => ({
      path: file.path,
      content: file.content,
      ...(parsed.language ? { language: parsed.language } : {}),
    })),
    config,
    {
      requestId: randomUUID(),
      adapterName: CLI_ADAPTER_NAME,
      adapterVersion: CLI_ADAPTER_VERSION,
      source: 'file',
    },
  );

  const unrepresentable = files.filter((file) => !file.representable);
  const result = optimize(request, {
    ...(parsed.maxDebt !== undefined ? { maxDebtThreshold: parsed.maxDebt } : {}),
    ...(parsed.maxDrift !== undefined ? { maxDriftThreshold: parsed.maxDrift } : {}),
    ...(parsed.keepDocstrings ? { keepDocstrings: true } : {}),
    ...(unrepresentable.length === 0
      ? {}
      : {
          inputNotRepresentable: `${unrepresentable.length} of ${files.length} input file(s) are not valid UTF-8 and cannot be represented losslessly as a string, so no stage output can be trusted against them. Emitted verbatim.`,
        }),
  });

  if (result.fallbackUsed) {
    // Original bytes per file, under the same headers `renderItemsOutput` produces. Writing
    // `result.emittedOutput` here would re-encode, which is exactly what DECISIONS §35
    // established loses the caller's data for input the string model cannot represent.
    io.stdout.write(renderFallbackBytes(files));
  } else {
    io.stdout.write(result.emittedOutput);
  }

  warnAboutDroppedFiles(request.bundle, result.finalBundle, io.stderr);

  if (parsed.diff) {
    // Rendered here too (audit OX-M2). This branch handled `--diff-html` and dropped `--diff`,
    // so a caller asking for a terminal diff over a directory paid for the flag and got nothing
    // — the accepted-then-ignored shape `SUPPORTED_FLAGS` exists to prevent. `renderTerminalDiff`
    // already takes a whole `ContextBundle`, so no per-file variant is needed.
    io.stdout.write(`\n${renderTerminalDiff(request.bundle, result.finalBundle)}\n`);
  }

  if (parsed.diffHtmlPath) {
    generateHtmlReport(result, request.bundle, { outputPath: resolve(cwd, parsed.diffHtmlPath) });
  }

  io.stderr.write(`${JSON.stringify(result.trace, null, 2)}\n`);
  return 0;
}

/**
 * Says out loud when the knapsack removed whole files from the output.
 *
 * `pruning:topology-pruner` drops entire items to meet the token budget, which is a different
 * operation from elision: elision leaves a marker saying what it took, and pruning leaves
 * nothing at all. On a directory run the file simply is not in stdout, and a caller piping that
 * to a model has no way to notice — the model will not report a file it was never shown, it
 * will infer an API and be confidently wrong about it.
 *
 * The trace already carried `itemsPruned`, so this is not new information; it is the same
 * information somewhere a person reading a terminal will actually see. Measured on a 7-file
 * project at `--target-reduction-ratio 0.3`, two modules were dropped silently.
 *
 * Derived by diffing the bundles rather than by reading the stage's metric, because the metric
 * is a count and the useful part is *which* files. The fallback path returns the original
 * bundle, so nothing is reported there — correctly, since nothing was dropped.
 */
function warnAboutDroppedFiles(
  before: ContextBundle,
  after: ContextBundle,
  stderr: NodeJS.WritableStream,
): void {
  const survived = new Set(after.items.map((item) => item.id));
  const dropped = before.items.filter((item) => !survived.has(item.id));
  if (dropped.length === 0) {
    return;
  }

  const names = dropped.map((item) => item.path ?? item.origin ?? item.id);
  stderr.write(
    `Warning: ${dropped.length} of ${before.items.length} file(s) were removed entirely to meet the token budget, ` +
      `not elided — their contents are absent from the output with no marker:\n` +
      names.map((name) => `  - ${name}\n`).join('') +
      `Lower --target-reduction-ratio (e.g. 0.3 -> 0.1), raise --max-input-tokens, or optimize files individually to keep them.\n`,
  );
}

/** The fallback stream: each file's original bytes, under the header the renderer emits. */
function renderFallbackBytes(files: ReadonlyArray<IngestedFile>): Buffer {
  if (files.length === 1) {
    return files[0]!.bytes;
  }

  const parts: Buffer[] = [];
  files.forEach((file, index) => {
    if (index > 0) parts.push(Buffer.from('\n', 'utf8'));
    parts.push(Buffer.from(`${ITEM_DELIMITER_PREFIX}${file.path}${ITEM_DELIMITER_SUFFIX}\n`, 'utf8'));
    parts.push(file.bytes);
  });
  return Buffer.concat(parts);
}

/**
 * Entry point used by the executable wrapper and compiled CLI binary.
 */
export function main(): void {
  const exitCode = runCli(process.argv.slice(2));

  if (typeof exitCode === 'number') {
    process.exitCode = exitCode;
    return;
  }

  // `exec` is the one command whose code is not known yet (audit OX-H1). Assigning it on
  // settlement is sufficient and does not need an explicit `process.exit`: the spawned child
  // inherits this process's stdio, so the event loop cannot drain while it is still running, and
  // forcing an exit here would risk truncating whatever the child last wrote.
  void exitCode.then((code) => {
    process.exitCode = code;
  });
}

export interface ParsedArguments {
  readonly command: 'optimize' | 'exec' | 'bench' | 'mcp' | 'unknown';
  readonly inputPath: string;
  /**
   * Additional positional paths for `optimize`. Empty for the single-file and stdin routes,
   * which stay byte-for-byte what they were (audit H5).
   */
  readonly extraInputPaths?: readonly string[];
  readonly datasetPath?: string;
  readonly reportJsonPath?: string;
  readonly quiet?: boolean;
  readonly execArgs: readonly string[];
  readonly configPath?: string;
  readonly configOverrides?: Partial<ConfigOverrides>;
  readonly diff?: boolean;
  readonly diffHtmlPath?: string;
  readonly maxDebt?: number;
  readonly maxDrift?: number;
  /** `--keep-docstrings`: keep leading docstrings outside elided regions (Python only). */
  readonly keepDocstrings?: boolean;
  /** `--language`: what the content is, declared by the caller. */
  readonly language?: string;
  /** `--input-name`: the filename stdin content would have had. Never opened. */
  readonly inputName?: string;
}

/**
 * The flags each command actually reads, keyed by what `runCli` consumes — not by what the
 * parse loop happens to recognize.
 *
 * The two used to be different, silently. Every flag below was accepted by the loop for every
 * command and then dropped by the command that had no field for it: `bench --diff`,
 * `optimize --report-json`, and worst of all `mcp --config`, which the MCP branch *reads*
 * (`parsed.configPath`) while the parser returned before ever setting it — so pointing the
 * server at a config file silently ran it on defaults. Each exited 0 and looked configured.
 *
 * That is the shape DECISIONS §29 rejects for `--language`, and it was never specific to
 * `--language`. An unsupported flag is now an error naming where it *is* supported.
 */
/**
 * Three flags are absent from this list on purpose, and their absence is the fix.
 *
 * `--max-output-tokens` and `--max-latency-ms` were parsed, range-validated, merged into the
 * budget — and then read by nothing at all, anywhere in the pipeline. `--risk-tolerance` was
 * read by exactly one thing, `bench-table-renderer.ts`, which prints it in a column; no stage,
 * validator or planner consults it, so setting it changed a label and nothing else.
 *
 * They are removed from the *surface*, not from `OptimizationBudget`, which `ARCHITECTURE.md`
 * pins as a frozen model. A field awaiting an implementation is a different thing from a
 * command-line dial that reports success and does nothing (audit H4).
 *
 * **`--trace-output` was withdrawn later, on the same grounds — audit OX-H5, DECISIONS §62.** It
 * survived the H4 sweep because it is not a budget field: it was parsed, validated and stored on
 * `ResolvedConfig`, where nothing read it. The trace goes out through a literal
 * `io.stderr.write(...)`, so `--trace-output stdout` reported success and changed nothing, and a
 * caller redirecting it to capture a trace in a pipe concluded the tool had ignored them. It had.
 * `--mode` lost its `explain` value in the same change, for the same reason; `bench` and
 * `optimize` stay because `bench` routes to the bench command.
 *
 * `--target-reduction-ratio` was called out here as "nearly as inert — the planner reads it only
 * as `> 0`". **That has not been true since DECISIONS §48**, which resolved it against the input
 * into an absolute token ceiling that both `pruning:topology-pruner` and
 * `compression:token-hashing` respect. It is a real target now, adhered to partially rather than
 * exactly, and §50 narrowed the gap further with sub-region elision. It stays because it works.
 */
const COMMON_FLAGS = [
  '--config',
  '--mode',
  '--planner-mode',
  '--minimum-confidence',
  '--log-level',
  '--max-input-tokens',
  '--target-reduction-ratio',
  '--preserve-kinds',
] as const;

export const SUPPORTED_FLAGS: Readonly<Record<'optimize' | 'bench' | 'mcp', ReadonlySet<string>>> = {
  optimize: new Set([
    ...COMMON_FLAGS,
    '--diff',
    '--diff-html',
    '--max-debt',
    '--max-drift',
    '--keep-docstrings',
    '--language',
    '--input-name',
  ]),
  bench: new Set([...COMMON_FLAGS, '--report-json', '--quiet']),
  mcp: new Set(COMMON_FLAGS),
};

function rejectUnsupportedFlags(command: 'optimize' | 'bench' | 'mcp', seen: ReadonlySet<string>): void {
  const unsupported = [...seen].filter((flag) => !SUPPORTED_FLAGS[command].has(flag));
  if (unsupported.length === 0) {
    return;
  }

  const detail = unsupported
    .map((flag) => {
      const elsewhere = (Object.keys(SUPPORTED_FLAGS) as Array<keyof typeof SUPPORTED_FLAGS>)
        .filter((other) => SUPPORTED_FLAGS[other].has(flag))
        .join(', ');
      return elsewhere ? `${flag} (applies to: ${elsewhere})` : flag;
    })
    .join('; ');

  throw new Error(`Unsupported for \`tokendamper ${command}\`: ${detail}.`);
}

/**
 * Exported for `test/unit/cli/flag-support.test.ts`, which checks the flag table against the
 * parse loop it governs. A parser is testable directly; asserting on it through `runCli` would
 * mean starting an MCP server to find out whether `--config` was read.
 */
export function parseArguments(argv: readonly string[], cwd: string): ParsedArguments {
  void cwd;

  const args = [...argv];
  let command = args.shift();

  if (command === 'exec') {
    // Drop optional '--' separator if present. Everything after it belongs to the child
    // process, so `exec` is deliberately outside the flag table above — it forwards rather
    // than consumes.
    if (args[0] === '--') {
      args.shift();
    }
    return {
      command: 'exec',
      inputPath: '',
      execArgs: args,
    };
  }

  let inputPath = '';
  const extraInputPaths: string[] = [];
  let datasetPath: string | undefined;

  if (command === 'bench') {
    if (args.length > 0 && args[0] !== undefined && !args[0].startsWith('-')) {
      datasetPath = args.shift();
    }
  } else if (command === 'optimize') {
    if (args.length > 0 && args[0] !== undefined && (args[0] === '-' || !args[0].startsWith('-'))) {
      inputPath = args.shift()!;
    } else {
      throw new Error('Missing input file path.');
    }
    // Additional positional paths, so `optimize a.ts b.ts` and a shell glob both work. Collected
    // here rather than after flag parsing because a path is any non-flag token, and stopping at
    // the first flag keeps `optimize a.ts b.ts --target-reduction-ratio 0.3` unambiguous.
    while (args.length > 0 && args[0] !== undefined && !args[0].startsWith('-')) {
      extraInputPaths.push(args.shift()!);
    }
  } else if (command !== 'mcp') {
    return {
      command: 'unknown',
      inputPath: '',
      execArgs: [],
    };
  }

  let configPath: string | undefined;
  const configOverrides: Partial<ConfigOverrides> = {};
  let minimumConfidence: number | undefined;
  let budgetOverrides: NonNullable<Partial<ConfigOverrides>['budget']> | undefined;
  let diff = false;
  let diffHtmlPath: string | undefined;
  let maxDebt: number | undefined;
  let maxDrift: number | undefined;
  let keepDocstrings = false;
  let reportJsonPath: string | undefined;
  let quiet = false;
  let language: string | undefined;
  let inputName: string | undefined;
  // Recorded as encountered, checked against the command once parsing is done — `--mode bench`
  // can still change `command` from inside this loop, so the verdict cannot be reached early.
  const seenFlags = new Set<string>();

  while (args.length > 0) {
    const flag = args.shift();
    if (flag !== undefined) {
      seenFlags.add(flag);
    }
    if (flag === '--config') {
      configPath = args.shift();
      if (!configPath) {
        throw new Error('Missing value for --config.');
      }
      continue;
    }

    if (flag === '--mode') {
      const value = args.shift();
      // `explain` was accepted here and nothing anywhere branched on it — audit OX-H5. Only
      // `bench` has an effect at all (it routes to the bench command); `optimize` is the identity.
      if (value === 'optimize' || value === 'bench') {
        configOverrides.appMode = value;
        if (value === 'bench') {
          command = 'bench';
        }
        continue;
      }
      throw new Error('Invalid value for --mode. Accepted values: optimize, bench.');
    }

    if (flag === '--report-json') {
      const value = args.shift();
      if (!value) {
        throw new Error('Missing value for --report-json.');
      }
      reportJsonPath = value;
      continue;
    }

    if (flag === '--quiet') {
      quiet = true;
      continue;
    }

    if (flag === '--planner-mode') {
      const value = args.shift();
      if (value === 'pass_through') {
        configOverrides.plannerMode = value;
        continue;
      }
      throw new Error('Invalid value for --planner-mode.');
    }

    if (flag === '--minimum-confidence') {
      const value = args.shift();
      if (!value) {
        throw new Error('Missing value for --minimum-confidence.');
      }
      minimumConfidence = Number(value);
      if (!Number.isFinite(minimumConfidence)) {
        throw new Error('Invalid value for --minimum-confidence.');
      }
      continue;
    }

    if (flag === '--log-level') {
      const value = args.shift();
      if (value === 'silent' || value === 'error' || value === 'warn' || value === 'info' || value === 'debug') {
        configOverrides.logLevel = value;
        continue;
      }
      throw new Error('Invalid value for --log-level.');
    }

    if (flag === '--max-input-tokens') {
      const value = args.shift();
      const parsedValue = parseBudgetNumber(value, '--max-input-tokens');
      budgetOverrides = {
        ...(budgetOverrides ?? {}),
        maxInputTokens: parsedValue,
      };
      continue;
    }

    if (flag === '--target-reduction-ratio') {
      const value = args.shift();
      const parsedValue = parseBudgetRatio(value);
      budgetOverrides = {
        ...(budgetOverrides ?? {}),
        targetReductionRatio: parsedValue,
      };
      continue;
    }

    if (flag === '--preserve-kinds') {
      const value = args.shift();
      if (!value) {
        throw new Error('Missing value for --preserve-kinds.');
      }
      const preserveKinds = value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry): entry is 'prompt' | 'file' | 'diff' | 'conversation' | 'note' =>
          entry === 'prompt' ||
          entry === 'file' ||
          entry === 'diff' ||
          entry === 'conversation' ||
          entry === 'note',
        );
      if (preserveKinds.length === 0) {
        throw new Error('Invalid value for --preserve-kinds.');
      }
      budgetOverrides = {
        ...(budgetOverrides ?? {}),
        preserveKinds,
      };
      continue;
    }

    if (flag === '--diff') {
      diff = true;
      continue;
    }

    if (flag === '--keep-docstrings') {
      keepDocstrings = true;
      continue;
    }

    if (flag === '--diff-html') {
      const value = args.shift();
      if (!value) {
        throw new Error('Missing value for --diff-html.');
      }
      diffHtmlPath = value;
      continue;
    }

    if (flag === '--max-debt') {
      const value = args.shift();
      if (!value) {
        throw new Error('Missing value for --max-debt.');
      }
      const parsedVal = Number(value);
      if (!Number.isFinite(parsedVal) || parsedVal < 0 || parsedVal > 100) {
        throw new Error('Invalid value for --max-debt.');
      }
      maxDebt = parsedVal;
      continue;
    }

    if (flag === '--max-drift') {
      const value = args.shift();
      if (!value) {
        throw new Error('Missing value for --max-drift.');
      }
      const parsedVal = Number(value);
      if (!Number.isFinite(parsedVal) || parsedVal < 0 || parsedVal > 1) {
        throw new Error('Invalid value for --max-drift.');
      }
      maxDrift = parsedVal;
      continue;
    }

    if (flag === '--language') {
      const value = args.shift();
      if (!value) {
        throw new Error('Missing value for --language.');
      }
      // Rejected here rather than dropped in the model. An unrecognized declaration that
      // silently does nothing produces a run that looks declared, validates nothing, and
      // reports a clean trace — invariant 10's shape.
      if (!normalizeLanguage(value)) {
        throw new Error(
          `Invalid value for --language: ${value}. Accepted: ${declarableLanguages().join(', ')}.`,
        );
      }
      language = value;
      continue;
    }

    if (flag === '--input-name') {
      const value = args.shift();
      if (!value) {
        throw new Error('Missing value for --input-name.');
      }
      inputName = value;
      continue;
    }

    throw new Error(`Unknown argument: ${flag ?? ''}`);
  }

  const resolvedOverrides: Partial<ConfigOverrides> =
    minimumConfidence === undefined && budgetOverrides === undefined
      ? configOverrides
      : {
          ...configOverrides,
          ...(minimumConfidence === undefined ? {} : { minimumConfidence }),
          ...(budgetOverrides === undefined ? {} : { budget: budgetOverrides }),
        };

  if (command === 'mcp') {
    rejectUnsupportedFlags('mcp', seenFlags);
    return {
      command: 'mcp',
      inputPath: '',
      execArgs: [],
      // Populated, at last. The MCP branch of `runCli` has always read these two; the parser
      // returned before the loop that sets them, so `mcp --config custom.json` ran on defaults.
      ...(configPath ? { configPath } : {}),
      configOverrides: resolvedOverrides,
    };
  }

  if (command === 'bench') {
    rejectUnsupportedFlags('bench', seenFlags);
    return {
      command: 'bench',
      inputPath: inputPath || datasetPath || '',
      ...(datasetPath || inputPath ? { datasetPath: datasetPath || inputPath } : {}),
      ...(reportJsonPath ? { reportJsonPath } : {}),
      ...(quiet ? { quiet } : {}),
      execArgs: [],
      ...(configPath ? { configPath } : {}),
      configOverrides: resolvedOverrides,
    };
  }

  rejectUnsupportedFlags('optimize', seenFlags);

  if (inputName !== undefined && inputPath !== '-') {
    // Not merged, and not silently ignored: with a real file argument there are two
    // candidate names for one item, and picking either leaves the other as a lie in the
    // trace. The caller has to say which one they meant.
    throw new Error('--input-name applies to stdin input only; pass `-` as the input file.');
  }

  return {
    command: 'optimize',
    inputPath,
    ...(extraInputPaths.length > 0 ? { extraInputPaths: Object.freeze([...extraInputPaths]) } : {}),
    execArgs: [],
    ...(language ? { language } : {}),
    ...(inputName ? { inputName } : {}),
    ...(configPath ? { configPath } : {}),
    ...(diff ? { diff } : {}),
    ...(diffHtmlPath ? { diffHtmlPath } : {}),
    ...(maxDebt !== undefined ? { maxDebt } : {}),
    ...(maxDrift !== undefined ? { maxDrift } : {}),
    ...(keepDocstrings ? { keepDocstrings } : {}),
    configOverrides: resolvedOverrides,
  };
}

function parseBudgetNumber(value: string | undefined, flagName: string): number {
  if (!value) {
    throw new Error(`Missing value for ${flagName}.`);
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid value for ${flagName}.`);
  }

  return parsed;
}

function parseBudgetRatio(value: string | undefined): number {
  if (!value) {
    throw new Error('Missing value for --target-reduction-ratio.');
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error('Invalid value for --target-reduction-ratio.');
  }

  return parsed;
}


// Delegates rather than repeating `main()`'s body. This block *is* the shipped entry point —
// `package.json`'s `bin` points at `dist/src/cli/main.js`, so this is what runs, and `main()` is
// what tests and the wrapper call. They had drifted into two copies of the same logic, and the
// copy here carried a `typeof exitCode === 'number'` guard that was dead while `runCli` always
// returned a number. Once `exec` started returning a promise (audit OX-H1) that guard would have
// silently dropped it on the floor, leaving the shipped binary exiting 0 with a full green suite
// behind it — the fix tested through `main()`, the product running this.
if (require.main === module) {
  main();
}