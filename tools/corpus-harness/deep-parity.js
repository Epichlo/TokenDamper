#!/usr/bin/env node
'use strict';

/**
 * R3 negative control — the Deep backend measured against the shipped Fast path, per file.
 *
 * Usage:
 *   node tools/corpus-harness/deep-parity.js <corpus-dir> --step symbols [--bucket ts,python]
 *   node tools/corpus-harness/deep-parity.js --files <dir> --language go [--limit 5000]
 *
 * ## Why this is a separate tool from `measure.js`
 *
 * `measure.js` drives the CLI and compares *output bytes*. Steps 1 and 2 of R3 ship nothing
 * that reaches output — symbols feed the drift tracker and `check()` feeds validation, and
 * both are measured **before** they are wired to elision, which is the ordering DECISIONS §56
 * measured as a safety property rather than a preference. So the two questions are different
 * and are asked by different tools: this one asks whether the backends agree, and `measure.js`
 * asks whether the corpus output moved. Both have to be answered.
 *
 * ## What it refuses
 *
 * Modelled on `timing.js`'s three refusals, each of which exists because a run that had the
 * failure looked fine:
 *
 *  - **an empty comparison set** is refused. "0 disagreements over 0 files" is the shape a
 *    broken glob produces, and it reads exactly like agreement (§60: 0 findings is also what
 *    a validator that examines nothing reports).
 *  - **a file the Fast extractor finds no symbols in at all** is counted separately rather
 *    than scored as agreement. Two empty sets agree vacuously and would inflate the rate.
 *  - **a parse failure** is reported, never silently skipped.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function req(rel) {
  const abs = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(abs)) {
    // `packages/deep/dist` is gitignored, so a fresh checkout has the source and not the build.
    // A raw MODULE_NOT_FOUND here would read as "the backend does not exist" rather than "it was
    // not built", and the two lead to very different next actions.
    console.error(
      `REFUSED: ${rel} is missing. Build it first:\n` +
        (rel.startsWith('packages/deep') ? '  npx tsc -p packages/deep/tsconfig.json' : '  npm run build'),
    );
    process.exit(2);
  }
  return require(abs);
}

function parseArgs(argv) {
  const out = { positional: [], step: 'symbols', buckets: null, files: null, language: null, limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--step') out.step = argv[++i];
    else if (a === '--bucket') out.buckets = argv[++i].split(',');
    else if (a === '--files') out.files = argv[++i];
    else if (a === '--language') out.language = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else out.positional.push(a);
  }
  return out;
}

/** Bucket name in `recipe.json` -> the language tag the pipeline uses. */
const BUCKET_LANGUAGE = { typescript: 'typescript', python: 'python', go: 'go', javascript: 'javascript' };

function collectFromCorpus(corpusDir, buckets) {
  const manifest = JSON.parse(fs.readFileSync(path.join(corpusDir, 'manifest.json'), 'utf8'));
  const wanted = new Set(buckets ?? Object.keys(BUCKET_LANGUAGE));
  const rows = [];
  for (const f of manifest.files) {
    if (!wanted.has(f.bucket) || !BUCKET_LANGUAGE[f.bucket]) continue;
    rows.push({
      label: f.corpusPath,
      language: BUCKET_LANGUAGE[f.bucket],
      abs: path.join(corpusDir, f.corpusPath),
    });
  }
  return { rows, manifest };
}

function collectFromDir(dir, language, limit) {
  const EXT = { typescript: ['.ts'], javascript: ['.js'], python: ['.py'], go: ['.go'] }[language];
  if (!EXT) throw new Error(`--language must be one of typescript|javascript|python|go, got ${language}`);
  const rows = [];
  const walk = (d) => {
    if (rows.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    // Sorted so a truncated run is deterministic rather than filesystem-ordered.
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (rows.length >= limit) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (EXT.some((x) => e.name.endsWith(x))) rows.push({ label: p, language, abs: p });
    }
  };
  walk(dir);
  return { rows, manifest: null };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { createDeepBackends } = req('packages/deep/dist/index.js');
  const { DriftTracker } = req('dist/src/core/ledger/drift-tracker.js');
  const { createContextItem } = req('dist/src/core/model/constructors.js');

  const { rows, manifest } = args.files
    ? collectFromDir(args.files, args.language, args.limit)
    : collectFromCorpus(args.positional[0], args.buckets);

  if (rows.length === 0) {
    console.error('REFUSED: no files selected. A clean result over an empty set reads like agreement.');
    process.exit(2);
  }

  const backends = new Map((await createDeepBackends()).map((b) => [b.language, b]));
  const drift = new DriftTracker();

  const stats = {};
  const disagreements = [];
  let parseFailures = 0;

  for (const row of rows) {
    const s = (stats[row.language] ??= { files: 0, agree: 0, disagree: 0, symbolFree: 0, lost: 0, extra: 0 });
    s.files++;
    const content = fs.readFileSync(row.abs, 'utf8');
    const backend = backends.get(row.language);

    let deep;
    try {
      deep = backend.symbols(content);
    } catch (e) {
      parseFailures++;
      disagreements.push({ label: row.label, language: row.language, parseError: String(e && e.message) });
      continue;
    }

    const fast = drift.extractItemSymbols(
      createContextItem({ id: 'x', kind: 'file', content, language: row.language }),
    );

    // Two empty sets agree vacuously. Counted, never scored.
    if (fast.size === 0 && deep.size === 0) {
      s.symbolFree++;
      continue;
    }

    const lost = [...fast].filter((x) => !deep.has(x)).sort();
    const extra = [...deep].filter((x) => !fast.has(x)).sort();
    if (lost.length === 0 && extra.length === 0) {
      s.agree++;
    } else {
      s.disagree++;
      s.lost += lost.length;
      s.extra += extra.length;
      disagreements.push({ label: row.label, language: row.language, lost, extra, fast: fast.size, deep: deep.size });
    }
  }

  const pin = manifest
    ? `corpus ${manifest.engine.commit.slice(0, 7)}${manifest.engine.dirty ? ' (DIRTY)' : ''} dist ${manifest.engine.distHash.slice(0, 12)}`
    : `tree ${args.files}`;
  console.log(`deep-parity step=${args.step} · ${rows.length} files · ${pin}\n`);
  console.log('language      files  scored  agree  disagree  symbol-free   lost  extra');
  for (const [lang, s] of Object.entries(stats).sort()) {
    const scored = s.agree + s.disagree;
    console.log(
      `${lang.padEnd(12)} ${String(s.files).padStart(5)}  ${String(scored).padStart(6)}  ${String(s.agree).padStart(5)}  ` +
        `${String(s.disagree).padStart(8)}  ${String(s.symbolFree).padStart(11)}  ${String(s.lost).padStart(5)}  ${String(s.extra).padStart(5)}`,
    );
  }
  if (parseFailures > 0) console.log(`\nparse failures: ${parseFailures}`);

  // Next to the tree that was scanned, never `process.cwd()` — which is the repository root in
  // practice and silently drops an untracked report into it.
  const outPath = path.join(args.files ?? args.positional[0], `deep-parity-${args.step}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ pin, stats, disagreements }, null, 2));
  console.log(`\n${disagreements.length} disagreeing files -> ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
