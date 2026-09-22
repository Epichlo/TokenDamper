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

  it('accepts fast explicitly and behaves as the default', () => {
    const streams = io();
    expect(runCli(['optimize', 'README.md', '--engine-mode', 'fast'], streams)).toBe(0);
  });
});
