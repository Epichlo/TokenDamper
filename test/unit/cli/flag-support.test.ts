import { describe, expect, it } from 'vitest';
import { parseArguments, runCli, SUPPORTED_FLAGS } from '../../../src/cli/main';

/**
 * Every flag was accepted by the parse loop for every command, then dropped by whichever
 * command had no field for it. Three silent no-ops shipped that way:
 *
 *   tokendamper bench --diff            parsed, discarded, exit 0
 *   tokendamper optimize x --report-json r   parsed, discarded, exit 0
 *   tokendamper mcp --config custom.json     parsed? no — the parser returned before the
 *                                            loop, and the MCP branch reads `parsed.configPath`
 *
 * The third is the worst: `runCli` passes `parsed.configPath` to `loadConfig`, and
 * `loadConfig` silently ignores a config file that does not exist, so pointing the server at
 * one ran it on defaults with no signal anywhere. This is DECISIONS §29's argument about
 * `--language` — a declaration that quietly does nothing produces a run that looks configured
 * and is not — and it was never specific to `--language`.
 */
const VALUE_FOR: Readonly<Record<string, string | null>> = {
  '--config': 'tokendamper.config.json',
  '--mode': 'optimize',
  '--trace-output': 'stderr',
  '--planner-mode': 'pass_through',
  '--minimum-confidence': '0.5',
  '--log-level': 'silent',
  '--max-input-tokens': '500',
  '--target-reduction-ratio': '0.3',
  '--preserve-kinds': 'prompt',
  '--diff': null,
  '--diff-html': 'out.html',
  '--max-debt': '10',
  '--max-drift': '0.5',
  '--language': 'python',
  '--input-name': 'snippet.py',
  '--report-json': 'report.json',
  '--quiet': null,
};

const argvFor = (command: string, flag: string): string[] => {
  const value = VALUE_FOR[flag];
  const head = command === 'optimize' ? [command, '-'] : [command];
  return value === undefined
    ? [...head, flag]
    : value === null
      ? [...head, flag]
      : [...head, flag, value];
};

describe('the flag table matches the loop it governs', () => {
  it('supplies a test value for every flag in the table', () => {
    // Invariant 10: without this, a flag missing from VALUE_FOR would be exercised as a
    // valueless flag, throw "Missing value", and the loop below would report that as coverage.
    const all = new Set(Object.values(SUPPORTED_FLAGS).flatMap((set) => [...set]));
    expect(all.size).toBeGreaterThan(15);

    for (const flag of all) {
      expect(
        Object.prototype.hasOwnProperty.call(VALUE_FOR, flag),
        `no test value for ${flag}`,
      ).toBe(true);
    }
  });

  it('carries no test value for a flag the table no longer supports', () => {
    // The reverse direction, added when audit H4 withdrew `--max-output-tokens`,
    // `--max-latency-ms` and `--risk-tolerance`. Without it a removed flag leaves an entry
    // here that nothing exercises and nothing complains about — and the next reader takes the
    // list above for the flag surface, because that is what it looks like.
    const all = new Set(Object.values(SUPPORTED_FLAGS).flatMap((set) => [...set]));
    for (const flag of Object.keys(VALUE_FOR)) {
      expect(all.has(flag), `${flag} has a test value but no command supports it`).toBe(true);
    }
  });

  it('rejects the flags H4 withdrew, on every command', () => {
    for (const command of ['optimize', 'bench', 'mcp'] as const) {
      for (const flag of ['--max-output-tokens', '--max-latency-ms', '--risk-tolerance']) {
        const head = command === 'optimize' ? [command, '-'] : [command];
        // `Unknown argument`, not `Unsupported for` — these belong to no command now, so the
        // "applies to" hint would have nothing to name.
        expect(() => parseArguments([...head, flag, 'x'], process.cwd())).toThrow('Unknown argument');
      }
    }
  });

  it('accepts every flag it claims to support, on the command that claims it', () => {
    for (const [command, flags] of Object.entries(SUPPORTED_FLAGS)) {
      for (const flag of flags) {
        // A flag in the table that the loop does not recognize throws `Unknown argument`, and
        // that is the failure this catches: the table and the loop drifting apart.
        expect(
          () => parseArguments(argvFor(command, flag), process.cwd()),
          `${command} rejected its own supported flag ${flag}`,
        ).not.toThrow();
      }
    }
  });
});

describe('an unsupported flag is an error, not a no-op', () => {
  const parseFails = (argv: string[], fragment: string) => {
    expect(() => parseArguments(argv, process.cwd())).toThrow(fragment);
  };

  it('rejects optimize-only flags on bench', () => {
    parseFails(['bench', '--diff'], 'Unsupported for `tokendamper bench`');
    parseFails(['bench', '--language', 'python'], '--language');
    parseFails(['bench', '--max-drift', '0.5'], '--max-drift');
    parseFails(['bench', '--input-name', 'x.py'], '--input-name');
  });

  it('rejects bench-only flags on optimize', () => {
    parseFails(
      ['optimize', '-', '--report-json', 'r.json'],
      'Unsupported for `tokendamper optimize`',
    );
    parseFails(['optimize', '-', '--quiet'], '--quiet');
  });

  it('rejects both families on mcp', () => {
    parseFails(['mcp', '--diff'], 'Unsupported for `tokendamper mcp`');
    parseFails(['mcp', '--report-json', 'r.json'], '--report-json');
  });

  it('names every offending flag at once, and where each one applies', () => {
    let message = '';
    try {
      parseArguments(['bench', '--diff', '--language', 'python'], process.cwd());
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('--diff');
    expect(message).toContain('--language');
    // Actionable, not just refusing: the flag exists, it belongs to a different command.
    expect(message).toContain('applies to: optimize');
  });

  it('surfaces the refusal as a non-zero exit, not a thrown stack', () => {
    const stderr: string[] = [];
    const exitCode = runCli(
      ['bench', 'test/fixtures/bench', '--diff'],
      {
        stdout: { write: () => true } as never,
        stderr: { write: (chunk: unknown) => (stderr.push(String(chunk)), true) } as never,
      },
      process.cwd(),
    );

    expect(exitCode).toBe(1);
    expect(stderr.join('')).toContain('Unsupported for `tokendamper bench`');
  });
});

describe('mcp finally receives the config flags its branch reads', () => {
  it('populates configPath, which the parser used to return before ever setting', () => {
    const parsed = parseArguments(['mcp', '--config', 'custom.json'], process.cwd());

    expect(parsed.command).toBe('mcp');
    expect(parsed.configPath).toBe('custom.json');
  });

  it('populates config overrides too', () => {
    const parsed = parseArguments(
      ['mcp', '--log-level', 'silent', '--max-input-tokens', '1024'],
      process.cwd(),
    );

    expect(parsed.configOverrides?.logLevel).toBe('silent');
    expect(parsed.configOverrides?.budget?.maxInputTokens).toBe(1024);
  });

  it('still parses a bare `mcp`', () => {
    const parsed = parseArguments(['mcp'], process.cwd());

    expect(parsed.command).toBe('mcp');
    expect(parsed.configPath).toBeUndefined();
  });
});

describe('supported combinations still parse', () => {
  it('bench with its own flags', () => {
    const parsed = parseArguments(
      ['bench', 'test/fixtures/bench', '--report-json', 'r.json', '--quiet'],
      process.cwd(),
    );

    expect(parsed.command).toBe('bench');
    expect(parsed.reportJsonPath).toBe('r.json');
    expect(parsed.quiet).toBe(true);
  });

  it('optimize with its own flags', () => {
    const parsed = parseArguments(
      ['optimize', '-', '--language', 'python', '--diff', '--max-drift', '0.5'],
      process.cwd(),
    );

    expect(parsed.command).toBe('optimize');
    expect(parsed.language).toBe('python');
    expect(parsed.diff).toBe(true);
    expect(parsed.maxDrift).toBe(0.5);
  });

  it('exec forwards everything to the child rather than consuming it', () => {
    // `exec` is deliberately outside the table: its arguments belong to another program.
    const parsed = parseArguments(['exec', '--', 'aider', '--diff', '--quiet'], process.cwd());

    expect(parsed.command).toBe('exec');
    expect(parsed.execArgs).toEqual(['aider', '--diff', '--quiet']);
  });
});
