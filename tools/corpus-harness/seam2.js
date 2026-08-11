#!/usr/bin/env node
'use strict';

/**
 * Seam 2 — is `looksLikeMarkdown` separable?
 *
 * Usage: node tools/corpus-harness/seam2.js <out-dir>
 *
 * DECISIONS §32 named three seams for the hash-commented-code defect and
 * docs/phase-4b-lever-disposition.md measured two of them dead. Seam 2 — tightening the [retired]
 * classifier — was never measured. This measures it.
 *
 * The known trap, from the disposition (§1): a *count* threshold on markers points the wrong
 * way, because `tclConfig.sh` carries 79 `#` lines to `CODE_OF_CONDUCT.md`'s 12. So the
 * candidates here are *shape* discriminators, not count thresholds.
 *
 * Ground truth is the corpus bucket: `prose` must stay markdown; every code bucket must not.
 */

const fs = require('fs');
const path = require('path');

// The four alternatives currently in looksLikeMarkdown (src/core/model/constructors.ts).
const RE_FENCE = /```[\s\S]*```/;
const RE_HEADING = /(^|\n)#{1,6}\s+\S/;
const RE_LIST = /(^|\n)(- |\* |\d+\.)\s+\S/;
const RE_LINK = /\[[^\]]+\]\([^)]+\)/;

// A list rule that matches what markdown actually looks like. The shipped RE_LIST requires
// "- " AND THEN \s+ before the text, so "- item" does not match and "-  item" does; this is
// almost certainly unintended, and it matters here because a candidate that leans on lists
// leans on a rule that mostly does not fire.
const RE_LIST_FIXED = /(^|\n)(-|\*|\d+\.)\s+\S/;
const RE_SETEXT = /(^|\n)(=|-){3,}\s*(\n|$)/;

const SIGNALS = {
  fence: (t) => RE_FENCE.test(t),
  heading: (t) => RE_HEADING.test(t),
  list: (t) => RE_LIST.test(t),
  listFixed: (t) => RE_LIST_FIXED.test(t),
  link: (t) => RE_LINK.test(t),
  setext: (t) => RE_SETEXT.test(t),
};

const CANDIDATES = {
  // What ships today.
  V0_current: (s) => s.fence || s.heading || s.list || s.link,

  // Drop the bare-heading path: a `#` line alone no longer makes a document.
  V1_nonHashRequired: (s) => s.fence || s.list || s.link,

  // Same, but with the list regex repaired first.
  V2_nonHashRequiredFixedList: (s) => s.fence || s.listFixed || s.link,

  // A heading counts only when corroborated by any other markdown construct.
  V3_headingNeedsCorroboration: (s) =>
    s.fence || s.list || s.link || (s.heading && (s.setext || s.listFixed)),

  // Two distinct signal kinds, whatever they are.
  V4_twoSignals: (s) =>
    [s.fence, s.heading, s.listFixed, s.link, s.setext].filter(Boolean).length >= 2,
};

// Buckets that must NOT be classified markdown, and the one that must.
const CODE_BUCKETS = ['shell', 'perl', 'tcl', 'c', 'rust', 'css', 'python', 'typescript'];
const PROSE_BUCKET = 'prose';

function main() {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('usage: seam2.js <out-dir>');
    process.exit(2);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));

  const rows = manifest.files.map((file) => {
    const text = fs.readFileSync(path.join(outDir, file.corpusPath), 'utf8').trim();
    const signals = Object.fromEntries(Object.entries(SIGNALS).map(([k, fn]) => [k, fn(text)]));
    return { bucket: file.bucket, corpusPath: file.corpusPath, signals };
  });

  // 1. Which alternative actually fires, per bucket. This is the part §32 assumed it knew.
  console.log('=== which signal fires, by bucket (a file can trip several) ===');
  console.log(
    `${'bucket'.padEnd(11)}${'n'.padStart(4)}${'fence'.padStart(7)}${'head'.padStart(6)}${'list'.padStart(6)}${'list+'.padStart(7)}${'link'.padStart(6)}${'setext'.padStart(8)}${'V0=md'.padStart(7)}`,
  );
  const buckets = [...new Set(rows.map((r) => r.bucket))];
  for (const bucket of buckets) {
    const r = rows.filter((x) => x.bucket === bucket);
    const c = (k) =>
      String(r.filter((x) => x.signals[k]).length).padStart(
        k === 'setext' ? 8 : k === 'list' ? 6 : 7,
      );
    console.log(
      bucket.padEnd(11) +
        String(r.length).padStart(4) +
        c('fence') +
        String(r.filter((x) => x.signals.heading).length).padStart(6) +
        String(r.filter((x) => x.signals.list).length).padStart(6) +
        String(r.filter((x) => x.signals.listFixed).length).padStart(7) +
        String(r.filter((x) => x.signals.link).length).padStart(6) +
        String(r.filter((x) => x.signals.setext).length).padStart(8) +
        String(r.filter((x) => CANDIDATES.V0_current(x.signals)).length).padStart(7),
    );
  }

  // 2. Confusion matrix per candidate.
  console.log('\n=== candidates: does it separate code from prose? ===');
  console.log(
    `${'candidate'.padEnd(30)}${'code->md'.padStart(10)}${'(of)'.padStart(6)}${'prose->md'.padStart(11)}${'(of)'.padStart(6)}${'verdict'.padStart(10)}`,
  );
  const code = rows.filter((r) => CODE_BUCKETS.includes(r.bucket));
  const prose = rows.filter((r) => r.bucket === PROSE_BUCKET);

  for (const [name, fn] of Object.entries(CANDIDATES)) {
    const falsePos = code.filter((r) => fn(r.signals)).length;
    const truePos = prose.filter((r) => fn(r.signals)).length;
    const verdict =
      falsePos === 0 && truePos === prose.length
        ? 'CLEAN'
        : truePos < prose.length
          ? 'BREAKS PROSE'
          : 'leaks';
    console.log(
      name.padEnd(30) +
        String(falsePos).padStart(10) +
        String(code.length).padStart(6) +
        String(truePos).padStart(11) +
        String(prose.length).padStart(6) +
        verdict.padStart(10),
    );
  }

  // 3. Per-bucket leakage for the best candidates, because an aggregate hides which language.
  console.log('\n=== leakage by bucket (files still classified markdown) ===');
  console.log(`${'candidate'.padEnd(30)}${buckets.map((b) => b.slice(0, 6).padStart(7)).join('')}`);
  for (const [name, fn] of Object.entries(CANDIDATES)) {
    const cells = buckets.map((b) => {
      const r = rows.filter((x) => x.bucket === b);
      return `${r.filter((x) => fn(x.signals)).length}/${r.length}`.padStart(7);
    });
    console.log(name.padEnd(30) + cells.join(''));
  }

  // 4. The prose files any candidate would lose - named, because "2 files" is not a finding.
  console.log('\n=== prose casualties, named ===');
  for (const [name, fn] of Object.entries(CANDIDATES)) {
    const lost = prose.filter((r) => !fn(r.signals));
    if (lost.length > 0) {
      console.log(`${name}: ${lost.map((r) => path.basename(r.corpusPath)).join(', ')}`);
    }
  }
}

main();
