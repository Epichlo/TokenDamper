#!/usr/bin/env node
'use strict';

/**
 * Per-file latency over a frozen corpus.
 *
 * Usage:
 *   node tools/corpus-harness/timing-run.js <out-dir> [--ratio 0.3] [--variant label] [--warmup 5]
 *
 * **A separate invocation from `measure.js`, and that is not organisation.** Wall clock is noisy
 * and machine-dependent; byte-identity is deterministic and is the harness's one load-bearing
 * output. Folding timing into `measure.js` would make a green byte-identity result depend on
 * machine load — the mistake `test/unit/ast-sla-determinism.test.ts` exists to prevent for
 * `slaExceeded`. `measure.js` is deliberately not touched by this file.
 *
 * ## What it reports, and why three numbers rather than one
 *
 * `cold`   engine time with the git workspace cache cleared before each file. Models the **CLI**,
 *          where every invocation is a fresh process and pays `git status` in full.
 * `warm`   engine time with the cache left populated. Models the **Gateway and MCP**, which are
 *          long-lived processes.
 * `fixed`  spawned-CLI wall clock minus `cold`. Node boot plus module load — paid once per
 *          invocation and attributable to no stage.
 *
 * The cold/warm split is forced by `globalGitCache` in `src/core/topology/git-inspector.ts`
 * (2000 ms TTL). Timing N files in one process lets files 2..N hit a warm cache, which removes
 * most of `pruning:topology-pruner` — measured at **123 ms of a 138 ms stage sum** on one 41 KB
 * file. A harness that ignored this would under-report per-file CLI cost by roughly the entire
 * engine time, and would make any future parser look proportionally more expensive than it is.
 *
 * It is also the axis §9 of the v2 design doc calls unestablished: a per-process cost can make a
 * backend unusable at the CLI while fine at the Gateway. Cold and warm are that question.
 *
 * ## Why in-process, and what pays for it
 *
 * The ~132 ms of per-process cost swamps an engine difference measured through spawns. So the
 * engine is driven in-process — through `runCli` itself, with captured streams, so the computation
 * is the CLI's rather than a hand-built approximation of it. The cost is that nothing guarantees
 * in-process and spawned agree, so **every file is run both ways and the output bytes compared**.
 * A single disagreement refuses the whole report: a timing for a computation the product does not
 * perform is worse than no timing.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const {
  percentiles,
  timeOnce,
  routeParityFailures,
  assertStageAttribution,
} = require('./timing');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'dist', 'src', 'cli', 'main.js');
const DIST_INDEX = path.join(REPO_ROOT, 'dist', 'src', 'cli', 'main.js');
const GIT_INSPECTOR = path.join(REPO_ROOT, 'dist', 'src', 'core', 'topology', 'git-inspector.js');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** A corpus that moved is not the corpus that was pinned. Refused, not warned about. */
function verifyManifest(outDir, manifest) {
  const drifted = [];
  for (const file of manifest.files) {
    const abs = path.join(outDir, file.corpusPath);
    let bytes;
    try {
      bytes = fs.readFileSync(abs);
    } catch {
      drifted.push(`${file.corpusPath}: missing`);
      continue;
    }
    if (sha256(bytes) !== file.sha256) drifted.push(`${file.corpusPath}: hash changed`);
  }
  return drifted;
}

/** The trace is one pretty-printed object on stderr. Same extraction `measure.js` uses. */
function parseTrace(stderr) {
  const start = stderr.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(stderr.slice(start));
  } catch {
    return null;
  }
}

/** Minimal writable sink — `runCli` only ever calls `write`. */
function capture() {
  const chunks = [];
  return {
    stream: {
      write(chunk, encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
        const done = typeof encoding === 'function' ? encoding : callback;
        if (typeof done === 'function') done();
        return true;
      },
      end() {},
      on() {},
      once() {},
      emit() {},
    },
    bytes: () => Buffer.concat(chunks),
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

function main() {
  const args = process.argv.slice(2);
  const outDir = args[0];
  if (!outDir || outDir.startsWith('--')) {
    console.error('usage: timing-run.js <out-dir> [--ratio N] [--variant label] [--warmup N]');
    process.exit(2);
  }
  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
  };
  const ratio = String(flag('ratio', '0.3'));
  const variant = String(flag('variant', 'baseline'));
  const warmup = Number(flag('warmup', '5'));

  const manifestPath = path.join(outDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`no manifest at ${manifestPath} — run collect.js first`);
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const drifted = verifyManifest(outDir, manifest);
  if (drifted.length > 0) {
    console.error(`corpus drifted from its manifest (${drifted.length} files):`);
    for (const line of drifted.slice(0, 10)) console.error(`  ${line}`);
    process.exit(1);
  }

  if (!fs.existsSync(CLI)) {
    console.error(`no built CLI at ${CLI} — build first`);
    process.exit(2);
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { runCli } = require(DIST_INDEX);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { clearGitWorkspaceCache } = require(GIT_INSPECTOR);
  if (typeof runCli !== 'function' || typeof clearGitWorkspaceCache !== 'function') {
    console.error('built artifact does not expose runCli / clearGitWorkspaceCache');
    process.exit(2);
  }

  const files = manifest.files;
  console.log(
    `timing ${files.length} files at ratio ${ratio} · variant ${variant} · ` +
      `corpus ${manifest.engine.commit.slice(0, 7)}${manifest.engine.dirty ? ' (DIRTY)' : ''} ` +
      `dist ${manifest.engine.distHash.slice(0, 12)}`,
  );

  const runInProcess = (absPath, { cold }) => {
    if (cold) clearGitWorkspaceCache();
    const out = capture();
    const err = capture();
    // `traceOf` rather than the return value: `runCli` hands back an exit code, so there is no
    // `.trace` to read. It is called after the clock stops, so parsing is not charged to the
    // engine.
    let trace = null;
    const timed = timeOnce({
      optimize: () =>
        runCli(
          ['optimize', absPath, '--target-reduction-ratio', ratio],
          { stdout: out.stream, stderr: err.stream },
          REPO_ROOT,
        ),
      traceOf: () => {
        trace = parseTrace(err.text());
        return trace;
      },
    });
    return { ...timed, outputSha: sha256(out.bytes()), trace };
  };

  // V8 warms up. Without this the first files pay JIT cost and land in p95/max as an artifact
  // of measurement order rather than of any file.
  const warmupTarget = path.join(outDir, files[0].corpusPath);
  for (let i = 0; i < warmup; i += 1) runInProcess(warmupTarget, { cold: true });

  const rows = [];
  const inProcessShas = [];
  const cliShas = [];

  for (const file of files) {
    const abs = path.join(outDir, file.corpusPath);

    const cold = runInProcess(abs, { cold: true });
    const warm = runInProcess(abs, { cold: false });

    const spawnStart = Date.now();
    const spawned = spawnSync(
      process.execPath,
      [CLI, 'optimize', abs, '--target-reduction-ratio', ratio],
      { cwd: REPO_ROOT, maxBuffer: 256 * 1024 * 1024 },
    );
    const cliWallMs = Date.now() - spawnStart;

    inProcessShas.push({ corpusPath: file.corpusPath, outputSha: cold.outputSha });
    cliShas.push({ corpusPath: file.corpusPath, outputSha: sha256(spawned.stdout || Buffer.alloc(0)) });

    rows.push({
      corpusPath: file.corpusPath,
      bucket: file.bucket,
      bytes: file.bytes,
      variant,
      coldEngineMs: cold.engineMs,
      warmEngineMs: warm.engineMs,
      coldStageSumMs: cold.stageSumMs,
      coldUnaccountedMs: cold.unaccountedMs,
      coldStageMs: cold.stageMs,
      cliWallMs,
      fixedMs: cliWallMs - cold.engineMs,
      fallbackUsed: cold.trace ? cold.trace.fallbackUsed : null,
      outputSha: cold.outputSha,
    });
  }

  // Assert the count, the way collect.js and measure.js do. A run that silently measured a
  // subset is the 4b.3 glob defect, which reported no differences over 132 of 144 files.
  if (rows.length !== files.length) {
    console.error(`measured ${rows.length} of ${files.length} files — refusing to report`);
    process.exit(1);
  }

  // An empty per-stage table next to a real end-to-end number reads as "these stages cost
  // nothing". Refused, because this harness emitted exactly that on its first run.
  assertStageAttribution(rows.map((row) => ({ stageMs: row.coldStageMs })));

  const parity = routeParityFailures(inProcessShas, cliShas);
  if (parity.length > 0) {
    console.error(
      `in-process and spawned CLI disagree on ${parity.length} of ${files.length} files — ` +
        `refusing to report timings for a computation the product may not perform:`,
    );
    for (const line of parity.slice(0, 10)) console.error(`  ${line}`);
    process.exit(1);
  }

  const cold = percentiles(rows.map((r) => r.coldEngineMs));
  const warm = percentiles(rows.map((r) => r.warmEngineMs));
  const wall = percentiles(rows.map((r) => r.cliWallMs));
  const fixed = percentiles(rows.map((r) => r.fixedMs));
  const unaccounted = percentiles(rows.map((r) => r.coldUnaccountedMs));

  // The harness's own assertion that cold mode does what it claims. If clearing the cache does
  // not cost anything, the cold/warm split measured nothing and the numbers below are one number
  // reported twice.
  const coldWarmRatio = cold.p50 / warm.p50;

  const stageTotals = {};
  for (const row of rows) {
    for (const [stageId, ms] of Object.entries(row.coldStageMs)) {
      (stageTotals[stageId] = stageTotals[stageId] || []).push(ms);
    }
  }
  const perStage = Object.fromEntries(
    Object.entries(stageTotals).map(([stageId, samples]) => [stageId, percentiles(samples)]),
  );

  const report = {
    variant,
    ratio: Number(ratio),
    measuredAt: new Date().toISOString(),
    corpus: {
      commit: manifest.engine.commit,
      dirty: manifest.engine.dirty,
      distHash: manifest.engine.distHash,
      fileCount: files.length,
    },
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    warmupRuns: warmup,
    cold,
    warm,
    coldWarmRatio,
    cliWallMs: wall,
    fixedMs: fixed,
    coldUnaccountedMs: unaccounted,
    perStage,
  };

  const rowsPath = path.join(outDir, `timing-${variant}.jsonl`);
  const reportPath = path.join(outDir, `timing-${variant}.json`);
  fs.writeFileSync(rowsPath, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  const ms = (v) => `${v.toFixed(1)}ms`;
  console.log('');
  console.log(`files            ${files.length}   parity  ${files.length}/${files.length} agree`);
  console.log(`cold  engine     p50 ${ms(cold.p50)}  p95 ${ms(cold.p95)}  max ${ms(cold.max)}`);
  console.log(`warm  engine     p50 ${ms(warm.p50)}  p95 ${ms(warm.p95)}  max ${ms(warm.max)}`);
  console.log(`cold/warm ratio  ${coldWarmRatio.toFixed(2)}x`);
  console.log(`CLI   wall       p50 ${ms(wall.p50)}  p95 ${ms(wall.p95)}  max ${ms(wall.max)}`);
  console.log(`fixed per-proc   p50 ${ms(fixed.p50)}`);
  console.log(`cold unaccounted p50 ${ms(unaccounted.p50)}  (validation + planning + render)`);
  console.log('');
  for (const [stageId, p] of Object.entries(perStage)) {
    console.log(`  ${stageId.padEnd(36)} p50 ${ms(p.p50)}  p95 ${ms(p.p95)}`);
  }
  console.log('');
  console.log(`rows   ${rowsPath}`);
  console.log(`report ${reportPath}`);

  if (coldWarmRatio < 1.05) {
    console.log('');
    console.log(
      `NOTE cold/warm is ${coldWarmRatio.toFixed(2)}x — clearing the git cache cost almost ` +
        `nothing, so treat cold and warm as one number rather than two on this corpus.`,
    );
  }
}

main();
