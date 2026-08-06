import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/main';

/**
 * Phase B — fail-open means the caller gets *their bytes* back, not a re-encoding of them.
 *
 * `resolveFallback` returns `request.rawInput`, which reads like a byte-identical echo and is
 * not one: `rawInput` is a string the CLI decoded with `readFileSync(path, 'utf8')`, and that
 * call replaces every invalid byte with U+FFFD, which re-encodes to three bytes. So the
 * guarantee held only for input that happened to be valid UTF-8, and nothing said so.
 *
 * Found by the Phase 0 corpus harness rather than by reading the code: of 504 fallback runs,
 * 502 were byte-identical and two were not — `vimspell.sh`, a Latin-1 file containing
 * "Fernández-Sanguino_Peña", came back 1,462 -> 1,466 bytes with `fallbackUsed: true`. Four
 * bytes, two characters, one silent violation of invariant 3.
 */
describe('fallback returns the caller bytes, whatever encoding they were in', () => {
  let dir: string;
  let stdout: Buffer[];
  let stderr: string[];
  let io: { stdout: Writable; stderr: Writable };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'td-bytes-'));
    stdout = [];
    stderr = [];
    io = {
      stdout: new Writable({
        write(chunk, _enc, cb) {
          stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          cb();
        },
      }),
      stderr: new Writable({
        write(chunk, _enc, cb) {
          stderr.push(String(chunk));
          cb();
        },
      }),
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Latin-1: 0xE1 is "á" and 0xF1 is "ñ". Neither is valid UTF-8 on its own, and each becomes
  // a 3-byte U+FFFD when decoded and re-encoded — the exact +4 measured on vimspell.sh.
  const LATIN1 = Buffer.concat([
    Buffer.from('#!/bin/sh\n# by Javier Fern'),
    Buffer.from([0xe1]),
    Buffer.from('ndez-Sanguino_Pe'),
    Buffer.from([0xf1]),
    Buffer.from('a\n\nPREFIX=/usr/local\nLIBS="-lm"\nexec_prefix=${PREFIX}\n'),
  ]);

  it('emits a non-UTF-8 file byte for byte', () => {
    const file = join(dir, 'latin1.sh');
    writeFileSync(file, LATIN1);

    const code = runCli(['optimize', file, '--target-reduction-ratio', '0.3'], io, dir);

    expect(code).toBe(0);
    const emitted = Buffer.concat(stdout);
    expect(emitted.equals(LATIN1)).toBe(true);
    // The specific failure this guards: a lossy round-trip is *longer*, never shorter.
    expect(emitted.length).toBe(readFileSync(file).length);
  });

  it('still emits a trace, because a run with no trace cannot be told from a crash', () => {
    // The first version of this fix returned early from the adapter. It produced the right
    // bytes and no trace at all, and the corpus harness recorded two rows it could not parse —
    // indistinguishable, from outside, from the process having died. Routing the refusal
    // through the engine keeps the trace.
    const file = join(dir, 'latin1.sh');
    writeFileSync(file, LATIN1);

    runCli(['optimize', file, '--target-reduction-ratio', '0.3'], io, dir);

    const trace = JSON.parse(stderr.join('')) as {
      fallbackUsed: boolean;
      fallbackReason?: string;
    };

    expect(trace.fallbackUsed).toBe(true);
    expect(trace.fallbackReason).toContain('not valid UTF-8');
  });

  it('leaves valid UTF-8 alone — multi-byte characters are not the trigger', () => {
    // The rule is "these bytes do not survive the string model", not "this file has non-ASCII
    // in it". A UTF-8 file full of multi-byte characters round-trips perfectly and must take
    // the ordinary path, or the guard would refuse most of the world's source comments.
    const utf8 = '# 説明: ünïcödé — ✅\nPREFIX=/usr/local\nexec_prefix=${PREFIX}\n';
    const file = join(dir, 'utf8.sh');
    writeFileSync(file, utf8, 'utf8');

    const code = runCli(['optimize', file, '--target-reduction-ratio', '0.3'], io, dir);

    expect(code).toBe(0);
    const trace = JSON.parse(stderr.join('')) as { fallbackReason?: string };
    expect(trace.fallbackReason ?? '').not.toContain('not valid UTF-8');
    expect(Buffer.concat(stdout).toString('utf8')).toContain('説明');
  });
});
