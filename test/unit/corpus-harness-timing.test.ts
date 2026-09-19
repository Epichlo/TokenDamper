import { describe, expect, it } from 'vitest';
import * as path from 'path';

/**
 * The timing harness is a measurement *instrument*, and the thing worth testing about an
 * instrument is not that it returns a number — it is that the number moves when the quantity
 * moves, and does not move when it does not.
 *
 * `tools/` is outside `tsconfig.json`'s `include`, so it is never type-checked and cannot be
 * `import`ed. It is loaded with `require` at runtime, the way `test/unit/topology.test.ts`
 * already reaches non-typed surfaces.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const timing = require(
  path.join(__dirname, '..', '..', 'tools', 'corpus-harness', 'timing.js'),
) as {
  percentiles(samples: ReadonlyArray<number>): {
    n: number;
    min: number;
    p50: number;
    p95: number;
    max: number;
    mean: number;
  };
  timeOnce(options: { optimize: () => unknown; request?: unknown }): {
    engineMs: number;
    stageSumMs: number;
    stageMs: Record<string, number>;
    unaccountedMs: number;
  };
  routeParityFailures(
    inProcess: ReadonlyArray<{ corpusPath: string; outputSha: string }>,
    cli: ReadonlyArray<{ corpusPath: string; outputSha: string }>,
  ): ReadonlyArray<string>;
};

/** Burns CPU for `ms`, so a stub engine has a real duration rather than a faked clock. */
function busyWait(ms: number): void {
  const start = performance.now();
  while (performance.now() - start < ms) {
    /* spin */
  }
}

const traceWithStages = (stages: ReadonlyArray<readonly [string, number]>) => ({
  trace: { stageTraces: stages.map(([stageId, durationMs]) => ({ stageId, durationMs })) },
});

describe('percentiles over timing samples', () => {
  it('reports nearest-rank percentiles over a known sample', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);

    const result = timing.percentiles(samples);

    expect(result.n).toBe(100);
    expect(result.min).toBe(1);
    expect(result.p50).toBe(50);
    expect(result.p95).toBe(95);
    expect(result.max).toBe(100);
    expect(result.mean).toBeCloseTo(50.5, 6);
  });

  it('does not depend on the order samples arrive in', () => {
    const ascending = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const shuffled = [7, 2, 10, 4, 1, 9, 3, 8, 5, 6];

    expect(timing.percentiles(shuffled)).toEqual(timing.percentiles(ascending));
  });

  it('refuses an empty sample rather than reporting a zero', () => {
    // A p95 of 0 over no samples is the shape of every silent no-op this project has recorded:
    // a number that reads as a measurement and describes nothing.
    expect(() => timing.percentiles([])).toThrow(/empty/i);
  });
});

describe('timeOnce — the instrument itself', () => {
  it('reports a larger engine time for a slower engine', () => {
    // The negative control, and the only test here that establishes the instrument measures
    // anything at all. §60's discipline: 0 findings is also what a validator that examines
    // nothing reports, so a duration has to be shown to move with the duration it claims.
    const fast = timing.timeOnce({ optimize: () => traceWithStages([]) });
    const slow = timing.timeOnce({
      optimize: () => {
        busyWait(60);
        return traceWithStages([]);
      },
    });

    expect(slow.engineMs).toBeGreaterThan(fast.engineMs + 40);
  });

  it('attributes each stage duration from the trace and sums them', () => {
    const result = timing.timeOnce({
      optimize: () =>
        traceWithStages([
          ['cleanup:constraint-preservation', 2.5],
          ['pruning:topology-pruner', 123],
          ['compression:token-hashing', 12.5],
        ]),
    });

    expect(result.stageMs['pruning:topology-pruner']).toBe(123);
    expect(result.stageSumMs).toBeCloseTo(138, 6);
  });

  it('refuses a pending result rather than timing nothing', () => {
    // `runCli` returns `number | Promise<number>`. Timing a promise without awaiting it stops the
    // clock before the work happens and reports a near-zero duration — a fast number that means
    // the opposite of fast. Refused loudly instead.
    expect(() => timing.timeOnce({ optimize: () => Promise.resolve(0) })).toThrow(
      /pending|promise|async/i,
    );
  });

  it('exposes the engine time no stage accounts for', () => {
    // Validation runs after every stage and appears in no stage's duration, so "sum of stages"
    // is not engine time. Without this field the difference is invisible, which is how the
    // roadmap came to carry a <1ms target that no measurement supports.
    const result = timing.timeOnce({
      optimize: () => {
        busyWait(50);
        return traceWithStages([['pruning:topology-pruner', 1]]);
      },
    });

    expect(result.unaccountedMs).toBeCloseTo(result.engineMs - result.stageSumMs, 6);
    expect(result.unaccountedMs).toBeGreaterThan(30);
  });
});

describe('routeParityFailures — is the in-process route the same computation?', () => {
  const row = (corpusPath: string, outputSha: string) => ({ corpusPath, outputSha });

  it('passes when both routes produce the same bytes for every file', () => {
    const a = [row('ts/one.ts', 'aaa'), row('py/two.py', 'bbb')];
    const b = [row('py/two.py', 'bbb'), row('ts/one.ts', 'aaa')];

    expect(timing.routeParityFailures(a, b)).toEqual([]);
  });

  it('names a file whose bytes differ between routes', () => {
    const failures = timing.routeParityFailures(
      [row('ts/one.ts', 'aaa')],
      [row('ts/one.ts', 'zzz')],
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('ts/one.ts');
  });

  it('names a file only one route covered, rather than comparing the intersection', () => {
    // The trap `measure-corpus` records: a diff keyed on something one side lacks reports
    // "compared N rows, differing: 0" and reads exactly like agreement. Coverage is asserted
    // here, not assumed.
    const failures = timing.routeParityFailures(
      [row('ts/one.ts', 'aaa'), row('ts/only-in-process.ts', 'bbb')],
      [row('ts/one.ts', 'aaa'), row('ts/only-cli.ts', 'ccc')],
    );

    expect(failures).toHaveLength(2);
    expect(failures.join(' ')).toContain('only-in-process.ts');
    expect(failures.join(' ')).toContain('only-cli.ts');
  });

  it('refuses two empty inputs rather than calling that agreement', () => {
    expect(() => timing.routeParityFailures([], [])).toThrow(/empty|nothing/i);
  });
});
