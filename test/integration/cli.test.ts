import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/main';

describe('CLI integration', () => {
  it('reads a file, runs the no-op pipeline, and emits the original content', () => {
    const fixturePath = join(process.cwd(), 'test', 'fixtures', 'sample.txt');
    const expected = readFileSync(fixturePath, 'utf8');
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const exitCode = runCli(
      ['optimize', fixturePath],
      {
        stdout: {
          write: (chunk: unknown) => {
            stdoutChunks.push(String(chunk));
            return true;
          },
        } as never,
        stderr: {
          write: (chunk: unknown) => {
            stderrChunks.push(String(chunk));
            return true;
          },
        } as never,
      },
      process.cwd(),
    );

    const trace = JSON.parse(stderrChunks.join(''));

    expect(exitCode).toBe(0);
    expect(stdoutChunks.join('')).toBe(expected);
    expect(trace.requestId).toEqual(expect.any(String));
    expect(trace.planMode).toBe('pass_through');
    expect(trace.stageCount).toBe(0);
    expect(trace.fallbackUsed).toBe(false);
  });
});
