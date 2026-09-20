#!/usr/bin/env node
'use strict';

/**
 * R3 negative control — the Deep backend measured against the shipped Fast path, per file.
 *
 * Usage:
 *   node tools/corpus-harness/deep-parity.js <corpus-dir> --step symbols [--bucket ts,python]
 *   node tools/corpus-harness/deep-parity.js --files <dir> --language go --out <dir> [--limit N]
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
  const out = { positional: [], step: 'symbols', buckets: null, files: null, language: null, limit: Infinity, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--step') out.step = argv[++i];
    else if (a === '--bucket') out.buckets = argv[++i].split(',');
    else if (a === '--files') out.files = argv[++i];
    else if (a === '--language') out.language = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
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
  const isValidatorStep = args.step.startsWith('validator');
  const { selectValidator } = isValidatorStep ? req('dist/src/core/validation/ast/index.js', 'npm run build') : {};

  const stats = {};
  const disagreements = [];
  let parseFailures = 0;

  for (const row of rows) {
    const s = (stats[row.language] ??= isValidatorStep
      ? { files: 0, agree: 0, disagree: 0, uncovered: 0, deepOnly: 0, fastOnly: 0 }
      : { files: 0, agree: 0, disagree: 0, symbolFree: 0, lost: 0, extra: 0 });
    s.files++;
    const content = fs.readFileSync(row.abs, 'utf8');
    const backend = backends.get(row.language);

    if (isValidatorStep) {
      // **Step 2, §3.5.** The disagreement rate against the *shipped* validator, per language,
      // with every disagreement written out so it can be read. §60's standard, and its second
      // half — the inverse control — lives in `test/unit/deep-backend-validator.test.ts`,
      // because 0 findings is also what a validator that examines nothing reports.
      const item = createContextItem({ id: 'x', kind: 'file', content, language: row.language });
      const fastValidator = selectValidator(item);
      if (!fastValidator) {
        // Nothing to compare against. Counted rather than scored — an uncovered item agreeing
        // with anything is the vacuity §23 exists to surface.
        s.uncovered++;
        continue;
      }
      let fastResult;
      let deepResult;
      try {
        fastResult = fastValidator.validate(content);
        deepResult = backend.check(content);
      } catch (e) {
        parseFailures++;
        disagreements.push({ label: row.label, language: row.language, parseError: String(e && e.message) });
        continue;
      }
      if (fastResult.valid === deepResult.valid) {
        s.agree++;
      } else {
        s.disagree++;
        if (!deepResult.valid) s.deepOnly++;
        else s.fastOnly++;
        disagreements.push({
          label: row.label,
          language: row.language,
          bytes: content.length,
          fastValid: fastResult.valid,
          deepValid: deepResult.valid,
          fastCodes: [...new Set(fastResult.issues.map((i) => i.code))],
          deepIssues: deepResult.issues.slice(0, 3).map((i) => ({ line: i.line, column: i.column, code: i.code })),
        });
      }
      continue;
    }

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
  if (isValidatorStep) {
    console.log('language      files  scored  agree  disagree      rate  deep-only  fast-only  uncovered');
    for (const [lang, s] of Object.entries(stats).sort()) {
      const scored = s.agree + s.disagree;
      const rate = scored === 0 ? 'n/a' : ((100 * s.disagree) / scored).toFixed(2) + '%';
      console.log(
        `${lang.padEnd(12)} ${String(s.files).padStart(5)}  ${String(scored).padStart(6)}  ${String(s.agree).padStart(5)}  ` +
          `${String(s.disagree).padStart(8)}  ${rate.padStart(8)}  ${String(s.deepOnly).padStart(9)}  ${String(s.fastOnly).padStart(9)}  ${String(s.uncovered).padStart(9)}`,
      );
      if (scored < 5000) {
        console.log(
          `${' '.repeat(12)} NOTE: §3.5 asks for >=5,000 scored files for this language; this run scored ${scored}.`,
        );
      }
    }
  } else {
    console.log('language      files  scored  agree  disagree  symbol-free   lost  extra');
    for (const [lang, s] of Object.entries(stats).sort()) {
      const scored = s.agree + s.disagree;
      console.log(
        `${lang.padEnd(12)} ${String(s.files).padStart(5)}  ${String(scored).padStart(6)}  ${String(s.agree).padStart(5)}  ` +
          `${String(s.disagree).padStart(8)}  ${String(s.symbolFree).padStart(11)}  ${String(s.lost).padStart(5)}  ${String(s.extra).padStart(5)}`,
      );
    }
  }
  if (parseFailures > 0) console.log(`\nparse failures: ${parseFailures}`);

  // **Never `process.cwd()` and never the scanned tree.** Both were tried and both were wrong:
  // cwd is the repository root in practice, and the scanned tree in `--files` mode is somebody
  // else's — a first run of this dropped a report inside a CPython installation. A corpus
  // directory is ours to write in; anything else requires `--out`.
  const outDir = args.out ?? (args.files ? null : args.positional[0]);
  if (outDir === null) {
    console.error('REFUSED: --files needs --out <dir>. The scanned tree is not ours to write into.');
    process.exit(2);
  }
  const outPath = path.join(outDir, `deep-parity-${args.step}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ pin, stats, disagreements }, null, 2));
  console.log(`\n${disagreements.length} disagreeing files -> ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
