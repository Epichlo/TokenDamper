import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { format as formatCliOutput, parse } from '../adapters/cli';
import { loadConfig } from '../config';
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
    const rawInput = inputPath ? readFileSync(inputPath, 'utf8') : readFileSync(0, 'utf8');
    const config = loadConfig({
      cwd,
      ...(parsed.configPath ? { configPath: parsed.configPath } : {}),
      ...(parsed.configOverrides ? { cliOverrides: parsed.configOverrides } : {}),
    });
    const request = parse(rawInput, config, {
      sourceKind: isStdin ? 'stdin' : 'file',
      ...(inputPath ? { sourcePath: inputPath } : {}),
    });

    const result = optimize(request, {
      ...(parsed.maxDebt !== undefined ? { maxDebtThreshold: parsed.maxDebt } : {}),
      ...(parsed.maxDrift !== undefined ? { maxDriftThreshold: parsed.maxDrift } : {}),
    });

    const output = formatCliOutput(result);
    io.stdout.write(output);

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
}

function parseArguments(argv: readonly string[], cwd: string): ParsedArguments {
  void cwd;

  const args = [...argv];
  let command = args.shift();

  if (command === 'mcp') {
    return {
      command: 'mcp',
      inputPath: '',
      execArgs: [],
    };
  }

  if (command === 'exec') {
    // Drop optional '--' separator if present
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
    if (args.length > 0 && args[0] !== undefined && !args[0].startsWith('-')) {
      inputPath = args.shift()!;
    } else {
      throw new Error('Missing input file path.');
    }
  } else {
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

  while (args.length > 0) {
    const flag = args.shift();
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

    throw new Error(`Unknown argument: ${flag ?? ''}`);
  }

  if (command === 'bench') {
    return {
      command: 'bench',
      inputPath: inputPath || datasetPath || '',
      ...(datasetPath || inputPath ? { datasetPath: datasetPath || inputPath } : {}),
      ...(reportJsonPath ? { reportJsonPath } : {}),
      ...(quiet ? { quiet } : {}),
      execArgs: [],
      ...(configPath ? { configPath } : {}),
      configOverrides:
        minimumConfidence === undefined && budgetOverrides === undefined
          ? configOverrides
          : {
              ...configOverrides,
              ...(minimumConfidence === undefined ? {} : { minimumConfidence }),
              ...(budgetOverrides === undefined ? {} : { budget: budgetOverrides }),
            },
    };
  }

  return {
    command: 'optimize',
    inputPath,
    execArgs: [],
    ...(configPath ? { configPath } : {}),
    ...(diff ? { diff } : {}),
    ...(diffHtmlPath ? { diffHtmlPath } : {}),
    ...(maxDebt !== undefined ? { maxDebt } : {}),
    ...(maxDrift !== undefined ? { maxDrift } : {}),
    ...(reportJsonPath ? { reportJsonPath } : {}),
    ...(quiet ? { quiet } : {}),
    configOverrides:
      minimumConfidence === undefined && budgetOverrides === undefined
        ? configOverrides
        : {
            ...configOverrides,
            ...(minimumConfidence === undefined ? {} : { minimumConfidence }),
            ...(budgetOverrides === undefined ? {} : { budget: budgetOverrides }),
          },
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
  main();
}
