#!/usr/bin/env node
'use strict';

/**
 * R3 step 3 — classifies every row where deep-mode output differs from fast-mode output.
 *
 * Usage:
 *   node tools/corpus-harness/deep-regions.js <fast-run-dir> <deep-run-dir> --out <file.json>
 *
 * ## Why two fallback numbers and not one
 *
 * §3.5 says "fallbacks must not rise". This split was designed when Deep's `check()` was meant
 * to run live on the optimize path: §80 measured a 9.28% TypeScript disagreement rate between
 * Deep's validator and Fast's, so a `new-fallback-validator` row would usually be Deep's own
 * validator being *wrong* where the grammar lags the language — expected noise, reported but
 * not gated.
 *
 * **That premise no longer holds, and this comment used to keep telling the old story.** Deep's
 * `check()` rejects TokenDamper's own elision marker (`[TokenDamper: N function-body lines
 * elided, …]` is not valid TypeScript or Python), so deep validation and elision cannot be
 * combined, and `validationMode` now defaults to `'fast'` for exactly that reason (see the "two
 * axes" comment in `src/core/engine/index.ts`). **Both arms of this comparison validate through
 * the identical Fast lexer, regardless of `--engine-mode`. Deep's validator does not run in
 * either run.**
 *
 * So a `new-fallback-validator` row no longer means "Deep's validator disagreed with Fast's" —
 * that class of disagreement cannot reach this comparison at all. It means the deep arm
 * produced a fallback whose reason carries an AST error from **Fast's own validator**, on
 * content the same validator accepted in the fast arm. The only thing that differs between the
 * two arms is which regions were chosen. That makes it a region defect — Deep picked a boundary
 * whose elision Fast's validator rejects — surfacing through a different symptom than a
 * `new-fallback-region` row, and arguably the more serious of the two: the spliced output was
 * rejected outright rather than merely scored worse.
 *
 * The two buckets stay separate because *which* symptom a region defect announces itself as is
 * still worth knowing. But **both gate at zero for this measurement, not just
 * region-attributable.** Collapsing them would hide a region regression behind a label that
 * used to mean "expected" and no longer does.
 *
 * ## What it refuses
 *
 *  - an empty comparison set — the shape a bad glob produces, and it reads as agreement
 *  - a row present in one run and missing from the other
 *  - a deep run whose `parserCoverage.backendAnswered` is 0 on every row: that is a deep run
 *    that never ran deep, and it would report perfect agreement
 */

const fs = require('fs');
const path = require('path');

/**
 * Reads one measure.js run.
 *
 * The file is `results-<variant>.jsonl` — **JSONL, one object per line**, not a JSON array —
 * and a row's identity is `corpusPath` **and** `route`, because measure.js runs every file
 * through both routes and asserts `rows.length === files × routes`. Keying on the path alone
 * silently collapses each pair, halving the comparison while still reporting agreement.
 */
function readRows(dir) {
  const matches = fs.readdirSync(dir).filter((f) => f.startsWith('results-') && f.endsWith('.jsonl'));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one results-*.jsonl in ${dir}, found ${matches.length}`);
  }
  const text = fs.readFileSync(path.join(dir, matches[0]), 'utf8');
  const byKey = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    byKey.set(`${row.corpusPath} ${row.route}`, row);
  }
  return byKey;
}

/**
 * AST validation issues are formatted `AST Error in item [<id>] at line …` by
 * `validation/index.ts`. Both arms validate through the identical Fast lexer (see the module
 * docstring), so a fallback reason carrying that prefix is **Fast's own validator** rejecting
 * the deep arm's spliced output — not Deep's validator disagreeing with anything. It is still a
 * region defect; this only names which symptom it announced itself through.
 */
function isValidatorFallback(row) {
  return typeof row.fallbackReason === 'string' && row.fallbackReason.includes('AST Error');
}

function classify(fastRow, deepRow) {
  if (fastRow.outputSha === deepRow.outputSha) return 'identical';
  if (!fastRow.fallbackUsed && deepRow.fallbackUsed) {
    return isValidatorFallback(deepRow) ? 'new-fallback-validator' : 'new-fallback-region';
  }
  if (fastRow.fallbackUsed && !deepRow.fallbackUsed) return 'recovered';
  if (deepRow.outputBytes < fastRow.outputBytes) return 'differs-deep-smaller';
  if (deepRow.outputBytes > fastRow.outputBytes) return 'differs-deep-larger';
  return 'differs-same-size';
}

async function main() {
  const [fastDir, deepDir, ...rest] = process.argv.slice(2);
  const outIndex = rest.indexOf('--out');
  if (!fastDir || !deepDir || outIndex === -1) {
    console.error('usage: deep-regions.js <fast-run-dir> <deep-run-dir> --out <file.json>');
    process.exit(2);
  }
  const outFile = rest[outIndex + 1];

  const fast = readRows(fastDir);
  const deep = readRows(deepDir);

  if (fast.size === 0) throw new Error('refusing: the fast run has 0 rows');
  if (fast.size !== deep.size) {
    throw new Error(`refusing: ${fast.size} fast rows vs ${deep.size} deep rows — not the same corpus`);
  }

  let backendAnswered = 0;
  const buckets = {};
  const differing = [];

  for (const [key, fastRow] of fast) {
    const deepRow = deep.get(key);
    if (!deepRow) {
      throw new Error(`refusing: ${fastRow.corpusPath} (${fastRow.route}) is missing from the deep run`);
    }
    backendAnswered += deepRow.parserBackendAnswered ?? 0;

    const verdict = classify(fastRow, deepRow);
    buckets[verdict] = (buckets[verdict] ?? 0) + 1;
    if (verdict !== 'identical') {
      differing.push({
        path: fastRow.corpusPath,
        route: fastRow.route,
        verdict,
        fastBytes: fastRow.outputBytes,
        deepBytes: deepRow.outputBytes,
        fastFallback: fastRow.fallbackUsed,
        deepFallback: deepRow.fallbackUsed,
        // Left empty on purpose: §3.5 requires every differing row be read by a person.
        classification: '',
      });
    }
  }

  if (backendAnswered === 0) {
    throw new Error(
      'refusing: no row in the deep run reports parserCoverage.backendAnswered > 0. ' +
        'That is a deep run in which Deep never answered, and it would report perfect agreement.',
    );
  }

  const report = { rows: fast.size, backendAnswered, buckets, differing };
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`${fast.size} rows, ${differing.length} differing, ${backendAnswered} backend answers`);
  console.log(JSON.stringify(buckets, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
