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
      io.stderr.write('Usage: tokendamper optimize <input-file>\n');
      return 1;
    }

    const inputPath = resolve(cwd, parsed.inputPath);
    const rawInput = readFileSync(inputPath, 'utf8');
    const config = loadConfig({
      cwd,
      ...(parsed.configPath ? { configPath: parsed.configPath } : {}),
      ...(parsed.configOverrides ? { cliOverrides: parsed.configOverrides } : {}),
    });
    const request = parse(rawInput, config, { sourcePath: inputPath });
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

    throw new Error(`Unknown argument: ${flag ?? ''}`);
  }

  return {
    command: 'optimize',
    inputPath,
    ...(configPath ? { configPath } : {}),
    configOverrides: minimumConfidence === undefined ? configOverrides : { ...configOverrides, minimumConfidence },
  };
}

if (require.main === module) {
  main();
}
