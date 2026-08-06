#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { format as formatCliOutput, parse } from '../adapters/cli';
import { loadConfig } from '../config';
import { declarableLanguages, normalizeLanguage } from '../core/model';
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
 */
export function runCli(
  argv: readonly string[],
  io: { readonly stdout: NodeJS.WritableStream; readonly stderr: NodeJS.WritableStream } = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
  cwd: string = process.cwd(),
): number {
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
      // Async exec command runner handled synchronously or spawned
      runExecCommand(parsed.execArgs, { io }).catch((err) => {
        io.stderr.write(`Exec process error: ${err.message}\n`);
      });
      return 0;
    }

    if (parsed.command === 'bench') {
      const rawDatasetPath = parsed.datasetPath || (parsed.inputPath !== '-' ? parsed.inputPath : undefined) || 'test/fixtures/bench';
      const resolvedPath = resolve(cwd, rawDatasetPath);
      let loadArg: string | undefined = rawDatasetPath;

      if (existsSync(resolvedPath) && statSync(resolvedPath).isDirectory()) {
        loadArg = undefined;
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
 * Entry point used by the executable wrapper and compiled CLI binary.
 */
export function main(): void {
  const exitCode = runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}

export interface ParsedArguments {
  readonly command: 'optimize' | 'exec' | 'bench' | 'mcp' | 'unknown';
  readonly inputPath: string;
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
const COMMON_FLAGS = [
  '--config',
  '--mode',
  '--trace-output',
  '--planner-mode',
  '--minimum-confidence',
  '--log-level',
  '--max-input-tokens',
  '--max-output-tokens',
  '--target-reduction-ratio',
  '--max-latency-ms',
  '--risk-tolerance',
  '--preserve-kinds',
] as const;

export const SUPPORTED_FLAGS: Readonly<Record<'optimize' | 'bench' | 'mcp', ReadonlySet<string>>> = {
  optimize: new Set([
    ...COMMON_FLAGS,
    '--diff',
    '--diff-html',
    '--max-debt',
    '--max-drift',
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
      if (value === 'optimize' || value === 'explain' || value === 'bench') {
        configOverrides.appMode = value;
        if (value === 'bench') {
          command = 'bench';
        }
        continue;
      }
      throw new Error('Invalid value for --mode.');
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

    if (flag === '--trace-output') {
      const value = args.shift();
      if (value === 'stderr' || value === 'stdout') {
        configOverrides.traceOutput = value;
        continue;
      }
      throw new Error('Invalid value for --trace-output.');
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

    if (flag === '--max-output-tokens') {
      const value = args.shift();
      const parsedValue = parseBudgetNumber(value, '--max-output-tokens');
      budgetOverrides = {
        ...(budgetOverrides ?? {}),
        maxOutputTokens: parsedValue,
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

    if (flag === '--max-latency-ms') {
      const value = args.shift();
      const parsedValue = parseBudgetNumber(value, '--max-latency-ms');
      budgetOverrides = {
        ...(budgetOverrides ?? {}),
        maxLatencyMs: parsedValue,
      };
      continue;
    }

    if (flag === '--risk-tolerance') {
      const value = args.shift();
      if (value === 'low' || value === 'medium' || value === 'high') {
        budgetOverrides = {
          ...(budgetOverrides ?? {}),
          riskTolerance: value,
        };
        continue;
      }
      throw new Error('Invalid value for --risk-tolerance.');
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
    execArgs: [],
    ...(language ? { language } : {}),
    ...(inputName ? { inputName } : {}),
    ...(configPath ? { configPath } : {}),
    ...(diff ? { diff } : {}),
    ...(diffHtmlPath ? { diffHtmlPath } : {}),
    ...(maxDebt !== undefined ? { maxDebt } : {}),
    ...(maxDrift !== undefined ? { maxDrift } : {}),
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


if (require.main === module) {
  const exitCode = runCli(process.argv.slice(2));
  if (typeof exitCode === 'number') {
    process.exitCode = exitCode;
  }
}