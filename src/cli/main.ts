import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { format as formatCliOutput, parse } from '../adapters/cli';
import { loadConfig } from '../config';
import { optimize } from '../core/engine';
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

    if (parsed.command !== 'optimize') {
      io.stderr.write('Usage: tokendamper optimize <input-file|->\n');
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
    const result = optimize(request);
    const output = formatCliOutput(result);

    io.stdout.write(output);
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

interface ParsedArguments {
  readonly command: 'optimize' | 'unknown';
  readonly inputPath: string;
  readonly configPath?: string;
  readonly configOverrides?: Partial<ConfigOverrides>;
}

function parseArguments(argv: readonly string[], cwd: string): ParsedArguments {
  void cwd;

  const args = [...argv];
  const command = args.shift();

  if (command !== 'optimize') {
    return {
      command: 'unknown',
      inputPath: '',
    };
  }

  const inputPath = args.shift();
  if (!inputPath) {
    throw new Error('Missing input file path.');
  }

  let configPath: string | undefined;
  const configOverrides: Partial<ConfigOverrides> = {};
  let minimumConfidence: number | undefined;
  let budgetOverrides: NonNullable<Partial<ConfigOverrides>['budget']> | undefined;

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
        continue;
      }
      throw new Error('Invalid value for --mode.');
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

    throw new Error(`Unknown argument: ${flag ?? ''}`);
  }

  return {
    command: 'optimize',
    inputPath,
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
