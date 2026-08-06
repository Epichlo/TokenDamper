#!/usr/bin/env node
'use strict';

/**
 * Freeze a corpus, and pin the engine that will be measured against it.
 *
 * Usage:  node tools/corpus-harness/collect.js <out-dir> [--recipe <path>]
 *
 * Writes <out-dir>/corpus/<bucket>/<flattened-name> and <out-dir>/manifest.json.
 *
 * Why this exists rather than an ad-hoc `for f in corpus/*` loop: CLAUDE.md's gotcha
 * ("this repo is its own corpus - freeze it before measuring, or the measurement moves under
 * you") has bitten this project at least twice, and the 4b.3 A/B loop separately measured 132
 * of 144 files because its glob only covered one directory level. Both failures are silent.
 * This script makes them loud: every file is hashed, every bucket count is asserted against
 * the recipe, and the engine's own hash is recorded next to the corpus it was run on.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Recursive walk. Not a glob — a glob is how 4b.3 lost 12 files. */
function walk(dir, excludeDirs, out, depth) {
  if (depth > 12) {
    return out;
  }

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // unreadable directory: skipped, and counted as never seen
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!excludeDirs.includes(entry.name)) {
        walk(full, excludeDirs, out, depth + 1);
      }
    } else if (entry.isFile()) {
      out.push(full);
    }
  }

  return out;
}

function collectBucket(bucket, recipe) {
  const extensions = bucket.extensions.map((e) => `.${e.toLowerCase()}`);
  const seen = [];

  for (const root of bucket.roots) {
    const absRoot = path.isAbsolute(root) ? root : path.join(REPO_ROOT, root);
    if (!fs.existsSync(absRoot)) {
      continue;
    }
    for (const file of walk(absRoot, recipe.excludeDirs, [], 0)) {
      if (extensions.includes(path.extname(file).toLowerCase())) {
        seen.push(file);
      }
    }
  }

  // Deduplicate by resolved path — roots may nest (e.g. "." and "docs").
  const unique = [...new Set(seen.map((f) => path.resolve(f)))];

  const sized = [];
  for (const file of unique) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (stat.size >= recipe.minBytes && stat.size <= recipe.maxBytes) {
      sized.push(file);
    }
  }

  // Deterministic selection: sort, then take. Not "whatever the filesystem returned".
  sized.sort();
  const selected = sized.slice(0, bucket.limit);

  return { seen: unique.length, eligible: sized.length, selected };
}

function pinEngine() {
  const git = (args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();

  const distDir = path.join(REPO_ROOT, 'dist');
  const distFiles = fs.existsSync(distDir)
    ? walk(distDir, [], [], 0)
        .filter((f) => f.endsWith('.js'))
        .sort()
    : [];

  const hasher = crypto.createHash('sha256');
  for (const file of distFiles) {
    hasher.update(path.relative(distDir, file).replace(/\\/g, '/'));
    hasher.update(fs.readFileSync(file));
  }

  const porcelain = git(['status', '--porcelain']);

  return {
    commit: git(['rev-parse', 'HEAD']),
    // A dirty tree is not a pin. Recorded, not rejected — measuring an uncommitted patch is
    // exactly the A/B workflow — but a result carrying dirty:true is not a baseline.
    dirty: porcelain.length > 0,
    dirtyPaths: porcelain ? porcelain.split('\n').map((l) => l.trim()) : [],
    distFileCount: distFiles.length,
    distHash: hasher.digest('hex'),
  };
}

function main() {
  const args = process.argv.slice(2);
  const outDir = args[0];
  if (!outDir) {
    console.error('usage: collect.js <out-dir> [--recipe <path>]');
    process.exit(2);
  }

  const recipeIdx = args.indexOf('--recipe');
  const recipePath = recipeIdx >= 0 ? args[recipeIdx + 1] : path.join(__dirname, 'recipe.json');
  const recipe = JSON.parse(fs.readFileSync(recipePath, 'utf8'));

  const corpusDir = path.join(outDir, 'corpus');
  fs.rmSync(corpusDir, { recursive: true, force: true });
  fs.mkdirSync(corpusDir, { recursive: true });

  const files = [];
  const buckets = [];
  const shortfalls = [];

  for (const bucket of recipe.buckets) {
    const { seen, eligible, selected } = collectBucket(bucket, recipe);
    const bucketDir = path.join(corpusDir, bucket.name);
    fs.mkdirSync(bucketDir, { recursive: true });

    for (const source of selected) {
      // Flatten, but keep enough of the path to stay unique and traceable.
      const flat = source
        .replace(/^[A-Za-z]:/, '')
        .replace(/[\\/]/g, '_')
        .replace(/^_+/, '');
      const dest = path.join(bucketDir, flat);
      const bytes = fs.readFileSync(source);
      fs.writeFileSync(dest, bytes);

      files.push({
        bucket: bucket.name,
        source: source.replace(/\\/g, '/'),
        corpusPath: path.relative(outDir, dest).replace(/\\/g, '/'),
        bytes: bytes.length,
        sha256: sha256(bytes),
      });
    }

    buckets.push({
      name: bucket.name,
      why: bucket.why,
      seen,
      eligible,
      selected: selected.length,
      expect: bucket.expect,
      met: selected.length === bucket.expect,
    });

    if (selected.length !== bucket.expect) {
      shortfalls.push(`${bucket.name}: expected ${bucket.expect}, selected ${selected.length}`);
    }
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    recipe: path.relative(REPO_ROOT, path.resolve(recipePath)).replace(/\\/g, '/'),
    engine: pinEngine(),
    machineSpecific: true,
    totals: {
      buckets: buckets.length,
      files: files.length,
    },
    buckets,
    files,
  };

  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  for (const b of buckets) {
    console.log(
      `${b.name.padEnd(11)} seen ${String(b.seen).padStart(5)}  eligible ${String(b.eligible).padStart(4)}  selected ${String(b.selected).padStart(3)}  expect ${String(b.expect).padStart(3)}  ${b.met ? 'ok' : 'MISMATCH'}`,
    );
  }
  console.log(`\n${files.length} files -> ${corpusDir}`);
  console.log(
    `engine ${manifest.engine.commit.slice(0, 7)}${manifest.engine.dirty ? ' (DIRTY)' : ''} dist ${manifest.engine.distHash.slice(0, 12)} (${manifest.engine.distFileCount} js)`,
  );

  if (shortfalls.length > 0) {
    console.error(`\nrecipe expectations not met:\n  ${shortfalls.join('\n  ')}`);
    process.exit(1);
  }
}

main();
