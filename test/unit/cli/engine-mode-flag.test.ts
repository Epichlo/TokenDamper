import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { runCli } from '../../../src/cli/main';

function io() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (c) => (out += String(c)));
  stderr.on('data', (c) => (err += String(c)));
  return {
    stdout,
    stderr,
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

describe('--engine-mode', () => {
  it('rejects a value that is neither fast nor deep', () => {
    const streams = io();
    const code = runCli(['optimize', 'README.md', '--engine-mode', 'turbo'], streams);
    expect(code).toBe(1);
    expect(streams.err).toContain('Accepted values: fast, deep');
  });

  it('is refused on a command that does not consume it', () => {
    const streams = io();
    const code = runCli(['mcp', '--engine-mode', 'deep'], streams);
    expect(code).toBe(1);
    expect(streams.err).toContain('--engine-mode');
  });

  // `bench`'s runner does not read `engineMode` (`src/bench/runner.ts` calls
  // `optimize(request, { tokenHasher })` unconditionally), so accepting the flag there would
  // register deep backends and could hard-fail without ever changing what bench measures —
  // an accepted-then-ignored flag with a side effect. Refused the same way every other
  // misplaced flag is: `rejectUnsupportedFlags` names the command it does apply to.
  it('is refused on bench, which does not consume it either, and names where it does apply', () => {
    const streams = io();
    const code = runCli(['bench', '--engine-mode', 'deep'], streams);
    expect(code).toBe(1);
    expect(streams.err).toContain('--engine-mode');
    expect(streams.err).toContain('applies to: optimize');
  });

  it('accepts fast explicitly and behaves as the default', () => {
    const streams = io();
    expect(runCli(['optimize', 'README.md', '--engine-mode', 'fast'], streams)).toBe(0);
  });
});
