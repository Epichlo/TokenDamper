'use strict';

const { performance } = require('perf_hooks');

/**
 * Timing primitives for the corpus harness.
 *
 * Separate from `measure.js` on purpose, and the separation is load-bearing rather than tidiness:
 * wall clock is noisy and machine-dependent, byte-identity is deterministic and is the harness's
 * one load-bearing output. A timing run is a *separate invocation*, so that a green byte-identity
 * result can never come to depend on machine load. That is the same mistake
 * `test/unit/ast-sla-determinism.test.ts` was written to prevent for `slaExceeded`.
 */

/**
 * Nearest-rank percentiles over a sample.
 *
 * Nearest-rank rather than interpolated because every sample here is a real observed duration,
 * and an interpolated p95 reports a number no run produced. `p50 = sorted[ceil(0.50n) - 1]`.
 *
 * Throws on an empty sample. A p95 of `0` over no observations is the exact shape of every
 * silent no-op this project has recorded — a value that reads as a measurement and describes
 * nothing — so it is refused rather than returned.
 */
function percentiles(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error('percentiles: refusing an empty sample — nothing was measured');
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const rank = (q) => sorted[Math.ceil(q * n) - 1];

  let total = 0;
  for (const value of sorted) total += value;

  return {
    n,
    min: sorted[0],
    p50: rank(0.5),
    p95: rank(0.95),
    max: sorted[n - 1],
    mean: total / n,
  };
}

/**
 * Times one `optimize()` call and attributes the result.
 *
 * `optimize` is injected rather than required here so the instrument can be checked against a
 * stub of known duration. That is not a testing convenience — it is the only way to establish
 * that the number moves with the quantity, which §60 had to do for the Go validator and which
 * `0 findings` never proves on its own.
 *
 * `unaccountedMs` is the quantity no existing field carries. Validators run *after* every stage
 * and appear in no stage's `durationMs`, so the sum of stages is not engine time — measured on
 * one 41 KB file, stages summed to 138 ms inside a 270 ms process. Anything comparing two
 * backends needs to see that gap rather than average it away.
 */
function timeOnce({ optimize, request }) {
  if (typeof optimize !== 'function') {
    throw new Error('timeOnce: `optimize` must be a function');
  }

  const start = performance.now();
  const result = optimize(request);
  const engineMs = performance.now() - start;

  // `runCli` is typed `number | Promise<number>`. Stopping the clock on a promise measures the
  // time to *schedule* the work, not to do it, and reports a near-zero duration — a fast number
  // meaning the opposite of fast. Refused rather than returned.
  if (result && typeof result.then === 'function') {
    throw new Error('timeOnce: `optimize` returned a pending value — the clock measured nothing');
  }

  const trace = result && result.trace;
  const stageTraces = trace && Array.isArray(trace.stageTraces) ? trace.stageTraces : [];

  const stageMs = {};
  let stageSumMs = 0;
  for (const stage of stageTraces) {
    const durationMs = typeof stage.durationMs === 'number' ? stage.durationMs : 0;
    stageMs[stage.stageId] = durationMs;
    stageSumMs += durationMs;
  }

  return { engineMs, stageSumMs, stageMs, unaccountedMs: engineMs - stageSumMs };
}

/**
 * Whether the in-process route computed the same thing the CLI route did.
 *
 * A timing run drives `optimize()` directly, because the CLI's ~132 ms of per-process cost
 * swamps an engine difference measured through it. That buys resolution and costs a guarantee:
 * nothing makes a hand-built request identical to the one `runCli` builds. So the timings are
 * only reported when both routes emit the same bytes for the same file — otherwise the harness
 * is timing a computation the product does not perform.
 *
 * **Coverage is asserted, not assumed.** A file present on one side only is a failure rather than
 * a skip. Comparing the intersection is how a diff reports `compared N rows, differing: 0` and
 * reads exactly like agreement, which is the silent no-op the `measure-corpus` skill records.
 */
function routeParityFailures(inProcess, cli) {
  if (!Array.isArray(inProcess) || !Array.isArray(cli)) {
    throw new Error('routeParityFailures: both routes must be arrays');
  }
  if (inProcess.length === 0 && cli.length === 0) {
    throw new Error('routeParityFailures: refusing two empty routes — nothing was compared');
  }

  const failures = [];
  const byPath = (rows) => new Map(rows.map((row) => [row.corpusPath, row.outputSha]));
  const a = byPath(inProcess);
  const b = byPath(cli);

  for (const [corpusPath, sha] of a) {
    if (!b.has(corpusPath)) {
      failures.push(`${corpusPath}: in-process only — the CLI route did not cover it`);
      continue;
    }
    if (b.get(corpusPath) !== sha) {
      failures.push(`${corpusPath}: in-process ${sha} vs CLI ${b.get(corpusPath)}`);
    }
  }
  for (const corpusPath of b.keys()) {
    if (!a.has(corpusPath)) {
      failures.push(`${corpusPath}: CLI only — the in-process route did not cover it`);
    }
  }

  return failures;
}

module.exports = { percentiles, timeOnce, routeParityFailures };
