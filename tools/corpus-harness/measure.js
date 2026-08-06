#!/usr/bin/env node
'use strict';

/**
 * Run the frozen corpus through the real CLI on both routes and record the trace.
 *
 * Usage:
 *   node tools/corpus-harness/measure.js <out-dir> [--variant <label>] [--ratio 0.3]
 *                                        [--concurrency 8] [--routes file,stdin]
 *
 * Reads  <out-dir>/manifest.json
 * Writes <out-dir>/results-<variant>.jsonl and prints a per-bucket summary.
 *
 * **It spawns the shipped CLI rather than calling the engine in-process, on purpose.**
 * `84fa00d` ("the benchmark loader was the third construction site, still guessing") is the
 * precedent: every harness that rebuilds a ContextBundle itself eventually rebuilds it
 * differently from the adapter it claims to model, and then measures its own divergence. The
 * cost is ~300ms per spawn; the concurrency pool absorbs it.
 *
 * The manifest is re-verified by hash before anything runs. A corpus that moved under the
 * measurement is the failure CLAUDE.md warns about, and it is silent unless checked.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'dist', 'src', 'cli', 'main.js');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

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
    if (sha256(bytes) !== file.sha256) {
      drifted.push(`${file.corpusPath}: hash changed`);
    }
  }
  return drifted;
}

/** Trace goes to stderr as one pretty-printed object. Extract defensively. */
function parseTrace(stderr) {
  const start = stderr.indexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(stderr.slice(start, end + 1));
  } catch {
    return null;
  }
}

function runOnce({ route, absPath, bytes, ratio }) {
  return new Promise((resolve) => {
    const args =
      route === 'file'
        ? [
            'optimize',
            absPath,
            '--target-reduction-ratio',
            String(ratio),
            '--trace-output',
            'stderr',
          ]
        : ['optimize', '-', '--target-reduction-ratio', String(ratio), '--trace-output', 'stderr'];

    const child = spawn(process.execPath, [CLI, ...args], { cwd: REPO_ROOT });

    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', () => resolve({ ok: false, reason: 'spawn-failed' }));
    child.on('close', (code) => {
      const stdout = Buffer.concat(out);
      const trace = parseTrace(Buffer.concat(err).toString('utf8'));
      resolve({
        ok: code === 0 && trace !== null,
        exitCode: code,
        trace,
        outputBytes: stdout.length,
        outputSha: sha256(stdout),
        byteIdentical: stdout.length === bytes.length && sha256(stdout) === sha256(bytes),
      });
    });

    if (route === 'stdin') {
      child.stdin.write(bytes);
    }
    child.stdin.end();
  });
}

/** The single content type present, for the one-item bundles the CLI builds. */
function soleContentType(trace) {
  const counts = trace?.bundleStatistics?.contentTypeCounts ?? {};
  const present = Object.entries(counts).filter(([, n]) => n > 0);
  return present.length === 1 ? present[0][0] : present.map(([k]) => k).join('+') || 'none';
}

function flatten(file, route, run) {
  const t = run.trace;
  return {
    bucket: file.bucket,
    corpusPath: file.corpusPath,
    source: file.source,
    route,
    ok: run.ok,
    exitCode: run.exitCode,
    inputBytes: file.bytes,
    outputBytes: run.outputBytes,
    // Recorded so an A/B diff can compare emitted bytes directly. It was missing until a
    // comparison script keyed on it, found `undefined === undefined` across 578 rows, and
    // reported "0 changed" against a summary table that plainly differed.
    outputSha: run.outputSha,
    byteIdentical: run.byteIdentical,
    contentType: t ? soleContentType(t) : null,
    planMode: t?.planMode ?? null,
    stageCount: t?.stageCount ?? null,
    tokenBefore: t?.tokenBefore ?? null,
    tokenAfter: t?.tokenAfter ?? null,
    reduction: t && t.tokenBefore > 0 ? 1 - t.tokenAfter / t.tokenBefore : null,
    fallbackUsed: t?.fallbackUsed ?? null,
    debtScore: t?.debtScore ?? null,
    driftScore: t?.driftScore ?? null,
    astChecked: t?.astCoverage?.checked ?? null,
    astUnchecked: t?.astCoverage?.unchecked ?? null,
    uncheckedContentTypes: t?.astCoverage?.uncheckedContentTypes ?? null,
    driftMeasured: t?.driftCoverage?.measured ?? null,
    driftAstMeasured: t?.driftCoverage?.astMeasured ?? null,
    driftStructMeasured: t?.driftCoverage?.structMeasured ?? null,
    contentChanged: t?.driftCoverage?.contentChanged ?? null,
    symbolsBefore: t?.driftCoverage?.symbolsBefore ?? null,
    contentMarkersBefore: t?.driftCoverage?.contentMarkersBefore ?? null,
    symbolBearingItems: t?.driftCoverage?.symbolBearingItems ?? null,
    unwitnessedItems: t?.driftCoverage?.unwitnessedItems ?? null,
    stageStatuses:
      t?.stageTraces?.map((s) => `${s.stageId}:${s.status}${s.changed ? '*' : ''}`) ?? null,
  };
}

async function pool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) {
        return;
      }
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

function summarize(rows, routes) {
  const buckets = [...new Set(rows.map((r) => r.bucket))];
  console.log(
    `\n${'bucket'.padEnd(11)}${'route'.padEnd(7)}${'n'.padStart(4)}${'reduce'.padStart(8)}${'fallbk'.padStart(8)}${'ast=0'.padStart(7)}${'drift~M'.padStart(9)}${'mkrs>0'.padStart(8)}  ${'saved%'.padStart(7)}`,
  );
  for (const bucket of buckets) {
    for (const route of routes) {
      const r = rows.filter((x) => x.bucket === bucket && x.route === route && x.ok);
      if (r.length === 0) {
        continue;
      }
      const reduced = r.filter((x) => x.reduction > 0.0001);
      const before = r.reduce((a, x) => a + x.tokenBefore, 0);
      const after = r.reduce((a, x) => a + x.tokenAfter, 0);
      console.log(
        bucket.padEnd(11) +
          route.padEnd(7) +
          String(r.length).padStart(4) +
          String(reduced.length).padStart(8) +
          String(r.filter((x) => x.fallbackUsed).length).padStart(8) +
          String(r.filter((x) => x.astChecked === 0).length).padStart(7) +
          String(r.filter((x) => x.driftMeasured).length).padStart(9) +
          String(r.filter((x) => x.contentMarkersBefore > 0).length).padStart(8) +
          `  ${(((before - after) / before) * 100).toFixed(2).padStart(6)}%`,
      );
    }
  }
  console.log(
    '\nast=0   items no AST validator looked at        drift~M items drift reports measured:true\n' +
      'mkrs>0  items with harvested structural markers  saved%  aggregate, engine estimator',
  );
}

async function main() {
  const args = process.argv.slice(2);
  const outDir = args[0];
  if (!outDir) {
    console.error(
      'usage: measure.js <out-dir> [--variant <label>] [--ratio 0.3] [--concurrency 8]',
    );
    process.exit(2);
  }
  const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };

  const variant = opt('variant', 'baseline');
  const ratio = Number(opt('ratio', '0.3'));
  const concurrency = Number(opt('concurrency', '8'));
  const routes = opt('routes', 'file,stdin').split(',');

  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));

  const drifted = verifyManifest(outDir, manifest);
  if (drifted.length > 0) {
    console.error(
      `corpus drifted from manifest (${drifted.length}):\n  ${drifted.slice(0, 10).join('\n  ')}`,
    );
    process.exit(1);
  }
  console.log(
    `manifest verified: ${manifest.files.length} files, engine ${manifest.engine.commit.slice(0, 7)}${manifest.engine.dirty ? ' (DIRTY)' : ''}`,
  );

  const jobs = [];
  for (const file of manifest.files) {
    for (const route of routes) {
      jobs.push({ file, route });
    }
  }

  let done = 0;
  const rows = await pool(jobs, concurrency, async ({ file, route }) => {
    const abs = path.join(outDir, file.corpusPath);
    const bytes = fs.readFileSync(abs);
    const run = await runOnce({ route, absPath: abs, bytes, ratio });
    done += 1;
    if (done % 100 === 0) {
      process.stderr.write(`  ${done}/${jobs.length}\r`);
    }
    return flatten(file, route, run);
  });

  // The count that 4b.3 got wrong. Asserted, not eyeballed.
  const expected = manifest.files.length * routes.length;
  if (rows.length !== expected) {
    console.error(`row count ${rows.length} != expected ${expected}`);
    process.exit(1);
  }

  const outPath = path.join(outDir, `results-${variant}.jsonl`);
  fs.writeFileSync(outPath, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);

  const failed = rows.filter((r) => !r.ok);
  console.log(
    `${rows.length} runs (${manifest.files.length} files x ${routes.length} routes), ${failed.length} failed -> ${outPath}`,
  );
  if (failed.length > 0) {
    for (const f of failed.slice(0, 10)) {
      console.log(`  FAIL ${f.route} ${f.corpusPath} exit=${f.exitCode}`);
    }
  }

  summarize(rows, routes);
}

main();
