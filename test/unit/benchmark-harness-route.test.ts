import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression guard for the wrong-route class of bug (4b.0).
 *
 * `tokendamper-benchmark/run_benchmark.py` invoked the CLI as `optimize -` and piped the
 * fixture bytes to stdin. That route supplies no `sourcePath`, so `createContextBundle`
 * classifies the item as `text`, `selectValidator` returns null, `selectElisionRegions`
 * finds no language, and the item falls to whole-item hashing where `S_k` pins at the
 * formula constant 0.60 — a fallback on every fixture, 0% reduction published as a result.
 *
 * The harness was therefore measuring a route no developer uses, and understating the one
 * it claimed to measure: the same `codebase.py` goes 0% over stdin and 27.61% as a file
 * argument, same engine, same budget, same bytes.
 *
 * This is a property of the harness, not of the engine, so it is pinned here as text rather
 * than by running the pipeline. The engine-side defect — that pathless input is invisible to
 * the validator layer at all — is real, tracked in `docs/phase-4b-pathless-code-scope.md`,
 * and deliberately NOT asserted here. Fixing it must not make this test pass by accident.
 */
describe('benchmark harness invocation route', () => {
  const harnessPath = join(process.cwd(), 'tokendamper-benchmark', 'run_benchmark.py');
  const source = readFileSync(harnessPath, 'utf8');

  // Invariant 10: everything below is a search over this string. If the harness moves or is
  // renamed, every assertion would pass over an empty haystack and report a green result
  // for a check that never looked at anything.
  it('reads a harness that actually exists and contains the invocation site', () => {
    expect(source.length, 'run_benchmark.py is empty or missing').toBeGreaterThan(0);
    expect(source, 'no subprocess invocation found in the harness').toContain('subprocess.run');
    expect(source, 'no optimize invocation found in the harness').toContain('"optimize"');
  });

  it('invokes the CLI with a file argument, not with stdin', () => {
    // The argv list literal that spawns the CLI.
    const argvMatch = source.match(/\[\s*cmd\s*,\s*"optimize"\s*,\s*([^,\]]+)/);
    expect(argvMatch, 'could not locate the [cmd, "optimize", ...] argv literal').not.toBeNull();

    const inputArg = argvMatch![1]!.trim();

    // `"-"` is the CLI's stdin sentinel. Passing it is the defect.
    expect(inputArg, 'the harness passes "-" and pipes stdin, so the engine sees no path').not.toBe(
      '"-"',
    );
    expect(inputArg).toBe('file_path');
  });

  it('does not feed the CLI through stdin', () => {
    // A path argument plus a stdin body would be contradictory, and `input=` is how the
    // stdin form was expressed. Scoped to the TokenDamper runner: Headroom is in-process
    // and has no subprocess of its own.
    const runner = source.slice(
      source.indexOf('def run_tokendamper'),
      source.indexOf('def benchmark_payload'),
    );
    expect(runner.length, 'could not isolate run_tokendamper').toBeGreaterThan(0);
    expect(runner, 'run_tokendamper still pipes bytes to stdin').not.toMatch(/^\s*input=/m);
  });

  it('passes the same path it opened, so the measured bytes are the fixture bytes', () => {
    // `benchmark_payload` reads `file_path` to compute `orig_tokens`. If it handed the CLI
    // anything else, the two sides of the reduction ratio would describe different content —
    // which is exactly the surviving `session.json` defect (`orig_tokens` is computed from a
    // re-serialization, not from the file). That one is out of scope here and still open.
    const caller = source.slice(source.indexOf('def benchmark_payload'));
    const calls = caller.match(/run_tokendamper\(([^,]+),/g) ?? [];

    expect(
      calls.length,
      'no run_tokendamper call sites found in benchmark_payload',
    ).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call, `call site passes something other than file_path: ${call}`).toContain(
        'file_path',
      );
    }
  });
});
