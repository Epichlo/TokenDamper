#!/usr/bin/env node
'use strict';

/**
 * R3 step 1's binding assertion: **`S_k` must not fall** when Deep's symbols replace Fast's.
 *
 * Usage:
 *   node tools/corpus-harness/deep-drift-control.js <corpus-dir> [--ratio 0.3]
 *
 * ## Why symbol-set equality is not the assertion
 *
 * The design says "equal or superset", and a superset is only safe when the extra symbols are
 * ones body elision destroys. `import:` and `type:` are signature-level and survive elision by
 * construction, so adding them raises `R_AST` toward 1 and *lowers* `S_k` for the same
 * transform. That is §59's falling drift score, and it is how 32 real Go files elided at
 * `S_k = 0.0000` with both gates green, one of them losing 78.4% of its tokens.
 *
 * The converse also bites, which is why this tool exists rather than a set comparison. The
 * shipped extractor harvests phantom symbols from **comment prose** — `fn:bodies` out of
 * "selects function bodies only", `type:class` out of `@dataclass`. Deep drops them, and
 * whether that raises or lowers `S_k` depends on something a set comparison cannot see:
 * whether the comment sat *inside* a region the engine elides. A phantom inside an elided body
 * is destroyed and inflates drift; a phantom in a doc comment above the function is retained
 * and deflates it. So the two extractors have to be compared against **the transform the
 * engine actually performs**, per file.
 *
 * ## The transform is the real one
 *
 * `after` is the shipped CLI's own stdout at the measured ratio, not a reconstruction. A
 * hand-rolled elision would be measuring this file's idea of the product.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'dist', 'src', 'cli', 'main.js');

// `go-app` and `go-stdlib` are the separately frozen Go corpus's two buckets. The main
// `recipe.json` has no Go bucket at all, which is why §77 measured Go on its own tree and why
// this mapping has to know both naming schemes.
const BUCKET_LANGUAGE = {
  typescript: 'typescript',
  python: 'python',
  javascript: 'javascript',
  go: 'go',
  'go-app': 'go',
  'go-stdlib': 'go',
};

function runCli(absPath, ratio) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'optimize', absPath, '--target-reduction-ratio', String(ratio)], {
      cwd: REPO_ROOT,
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', () => resolve(null));
    child.on('close', (code) =>
      resolve(code === 0 ? { stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') } : null),
    );
  });
}

/** `R_AST` as `DriftTracker` computes it: retained share of the before-set. */
function retention(before, after) {
  if (before.size === 0) return 1;
  let kept = 0;
  for (const s of before) if (after.has(s)) kept++;
  return kept / before.size;
}

async function main() {
  const corpusDir = process.argv[2];
  const ratioArg = process.argv.indexOf('--ratio');
  const ratio = ratioArg > 0 ? Number(process.argv[ratioArg + 1]) : 0.3;

  // `packages/deep/dist` is gitignored, so a fresh checkout has the source and not the build. A
  // raw MODULE_NOT_FOUND reads as "the backend does not exist" rather than "it was not built".
  const req = (rel, how) => {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) {
      console.error(`REFUSED: ${rel} is missing. Build it first:\n  ${how}`);
      process.exit(2);
    }
    return require(abs);
  };
  const { createDeepBackends } = req('packages/deep/dist/index.js', 'npx tsc -p packages/deep/tsconfig.json');
  const { DriftTracker } = req('dist/src/core/ledger/drift-tracker.js', 'npm run build');
  const { createContextItem } = req('dist/src/core/model/constructors.js', 'npm run build');

  const manifest = JSON.parse(fs.readFileSync(path.join(corpusDir, 'manifest.json'), 'utf8'));
  const rows = manifest.files.filter((f) => BUCKET_LANGUAGE[f.bucket]);
  if (rows.length === 0) {
    console.error('REFUSED: no files of a Deep-covered language in this corpus.');
    process.exit(2);
  }

  const backends = new Map((await createDeepBackends()).map((b) => [b.language, b]));
  const drift = new DriftTracker();
  const fastSymbols = (c, language) =>
    drift.extractItemSymbols(createContextItem({ id: 'x', kind: 'file', content: c, language }));

  const results = [];
  let transformed = 0;
  let unchanged = 0;
  let failed = 0;

  for (const f of rows) {
    const language = BUCKET_LANGUAGE[f.bucket];
    const abs = path.join(corpusDir, f.corpusPath);
    const before = fs.readFileSync(abs, 'utf8');
    const run = await runCli(abs, ratio);
    if (run === null) {
      failed++;
      continue;
    }
    const after = run.stdout;

    // A file the engine did not change says nothing about either extractor: both score 1.0.
    if (after === before) {
      unchanged++;
      continue;
    }
    transformed++;

    const backend = backends.get(language);
    const fastBefore = fastSymbols(before, language);
    const fastAfter = fastSymbols(after, language);
    const deepBefore = backend.symbols(before);
    const deepAfter = backend.symbols(after);
    const fastR = retention(fastBefore, fastAfter);
    const deepR = retention(deepBefore, deepAfter);

    // **The criterion, refined by reading every failing case.**
    //
    // "S_k must not fall" is the design's wording and it is the right *instinct* — §59's hazard
    // is a backend whose symbols cannot register the loss. But a raw comparison cannot tell
    // that hazard from its opposite, and both were present here:
    //
    //  - **the hazard** — the backend *invents* a signature-level symbol that survives elision
    //    by construction, so `R_AST` rises for the same transform. Found twice (Go grouped
    //    imports, annotated top-level consts) and refused in `symbols.ts`.
    //  - **not the hazard** — the backend *declines to invent* a symbol the shipped regexes
    //    harvested from English prose in a comment. `type:keeps` out of "the content type keeps
    //    the message concrete". When that phantom sat inside an elided body, Fast scored it as
    //    destroyed, so Deep dropping it lowers `S_k` while losing no information at all.
    //
    // What separates them is whether Deep *had* the symbol and kept it anyway. So the failure
    // is: a symbol in Deep's before-set that Fast saw destroyed and Deep did not.
    const unwitnessed = [...fastBefore].filter(
      (s) => !fastAfter.has(s) && deepBefore.has(s) && deepAfter.has(s),
    );
    const phantomOnly = [...fastBefore].filter((s) => !fastAfter.has(s) && !deepBefore.has(s));

    results.push({
      label: f.corpusPath,
      language,
      fastRetention: fastR,
      deepRetention: deepR,
      fastDrift: 1 - fastR,
      deepDrift: 1 - deepR,
      driftDelta: fastR - deepR,
      unwitnessed,
      phantomOnly,
    });
  }

  if (transformed === 0) {
    console.error(
      `REFUSED: 0 of ${rows.length} files were transformed at ratio ${ratio}. Comparing two ` +
        `extractors over files nothing touched reports perfect agreement and measures nothing.`,
    );
    process.exit(2);
  }

  const fell = results.filter((r) => r.deepDrift < r.fastDrift - 1e-9);
  const rose = results.filter((r) => r.deepDrift > r.fastDrift + 1e-9);
  const same = results.length - fell.length - rose.length;
  const hazard = results.filter((r) => r.unwitnessed.length > 0);

  console.log(
    `deep-drift-control · ratio ${ratio} · ${rows.length} files ` +
      `(${transformed} transformed, ${unchanged} unchanged, ${failed} failed)\n`,
  );
  console.log('language      transformed   S_k fell   S_k rose   S_k same');
  for (const lang of [...new Set(results.map((r) => r.language))].sort()) {
    const sub = results.filter((r) => r.language === lang);
    const f = sub.filter((r) => r.deepDrift < r.fastDrift - 1e-9).length;
    const ro = sub.filter((r) => r.deepDrift > r.fastDrift + 1e-9).length;
    console.log(
      `${lang.padEnd(12)} ${String(sub.length).padStart(11)}   ${String(f).padStart(8)}   ${String(ro).padStart(8)}   ${String(sub.length - f - ro).padStart(8)}`,
    );
  }

  console.log(`\nTOTAL  fell ${fell.length}   rose ${rose.length}   same ${same}`);

  if (fell.length > 0) {
    console.log('\nS_k fell on these — each is classified, not counted:');
    for (const r of fell.sort((a, b) => a.deepDrift - b.deepDrift)) {
      const verdict = r.unwitnessed.length > 0 ? 'HAZARD' : 'phantom-only';
      console.log(
        `  ${r.label.split('/').pop().slice(-58).padEnd(60)} ${r.fastDrift.toFixed(4)} -> ${r.deepDrift.toFixed(4)}  ` +
          `${verdict}  fast-destroyed-phantoms: ${r.phantomOnly.join(' ') || '-'}`,
      );
    }
  }

  console.log(
    `\nVERDICT  files where a symbol Deep HAS was destroyed under Fast and retained under Deep: ${hazard.length}`,
  );
  if (hazard.length > 0) {
    console.log("That is §59's hazard. Every one must be read before any region scanner is wired:");
    for (const r of hazard) console.log(`  ${r.label}  unwitnessed: ${r.unwitnessed.join(' ')}`);
  }

  const out = path.join(corpusDir, 'deep-drift-control.json');
  fs.writeFileSync(out, JSON.stringify({ ratio, transformed, unchanged, failed, results }, null, 2));
  console.log(`\nrows -> ${out}`);
  process.exit(hazard.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
