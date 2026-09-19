---
name: measure-corpus
description: The corpus A/B measurement loop for TokenDamper — freeze, pin the engine, vary only dist/, compare per-row. Use this skill whenever you are about to claim that a change to src/ did or did not move reduction numbers, whenever you need a current figure for any bucket, whenever someone quotes a reduction percentage from memory or from a doc, and before writing any DECISIONS or CHANGELOG entry containing a measured number. Also use it when a change "obviously" cannot affect output — that belief is what the per-row A/B exists to check. Triggers on: reduction percentage, corpus, A/B, regression, byte-identical, fallback rate, "did this change anything", baseline, re-measure.
---

# Measuring TokenDamper against a corpus

Every reduction figure in this project is measured over `src/**/*.ts` and third-party source —
and `src/` is the code a session edits while it works. **The corpus moves under you unless you
freeze it.** That is not a hypothetical: a previous session read its own edits as a behavioural
change.

`tools/corpus-harness/` exists so this loop is not hand-rolled. The hand-rolled ones have been
wrong at least twice — once with the repo moving mid-run, once with a glob that silently measured
132 of 144 files.

## The loop

```bash
# 1. Freeze the corpus and pin the engine (records commit, dist hash, dirty flag)
node tools/corpus-harness/collect.js <scratch-dir>

# 2. Measure the current engine
node tools/corpus-harness/measure.js <scratch-dir> --variant baseline

# 3. Change src/, rebuild dist/ with an src-only tsconfig (see below), measure again
node tools/corpus-harness/measure.js <scratch-dir> --variant <label>

# 4. Diff per-row — never by eyeballing the summary tables
```

`measure.js` takes `--ratio` (default 0.3), `--concurrency`, and `--routes file,stdin`. Use the
default ratio unless you have a reason; the recorded baselines are at 0.3.

Put the scratch dir outside the repo. Both scripts assert their own counts, which is the point of
using them.

## Build the comparison engine, and verify which engine you built

```bash
npx tsc -p tsconfig.build.json    # or `npm run build` - same thing since v1.7.2
```

**No temp tsconfig. That instruction was stale and this section used to carry it.** It said to
hand-roll a `tsconfig.src.json` because `npm run build` also typechecked `test/`, and on a branch
whose new tests reference new APIs it would fail, **emit nothing, and leave the previous `dist/` in
place** — comparing an engine against itself and reporting a perfect match. Since **v1.7.2** the
build script is `tsc -p tsconfig.build.json`, which is `src/`-only, so the failure mode is gone and
the temp file was pure cost: an extra step plus a dirty tree in the next `collect.js` run if you
forgot to delete it.

**The guard the stale instruction bought is still worth having, so keep it and make it direct.**
After building each arm, assert the built artifact contains the code you think it does, rather than
assuming the build ran:

```bash
node -e "console.log(require('fs').readFileSync('dist/src/<file>.js','utf8').includes('<new symbol>'))"
```

`true` on the candidate and `false` on the baseline. Two lines, and it checks the thing that
actually matters — a perfect match is exactly what a real match looks like, so the only way to tell
them apart is to look at the engine rather than at the result. §77 used this on both arms and the
baseline independently reproduced §61's recorded Go figure to two decimals, which is what a
correctly-built baseline looks like.

## Diff per-row, and check the diff itself ran

Key on `corpusPath` **and** the route, assert the row count, and assert the fields you are
comparing actually exist on the rows. Keying on a field the harness does not emit collapses every
row onto one `undefined` key and reports `compared 2 rows, differing: 0`.

Fields worth comparing:

```
outputSha  byteIdentical  tokenBefore  tokenAfter  reduction  fallbackUsed
driftScore  debtScore  planMode  stageCount  contentType
astChecked  astUnchecked  driftMeasured  unwitnessedItems
```

A diff script that prints `compared N rows` where N is the number you expect, plus a count of
fields actually present, takes thirty seconds to write and has caught two silent no-ops.

## Reading the result

**Aggregates are not comparable across commits.** The TypeScript bucket has read 29.55%, 25.35%,
23.26%, 17.57% and 24.56% at different times — same engine for several of those; the corpus grew,
or line endings changed, or a target started binding. Only a per-row A/B over one frozen corpus
means anything.

**A falling aggregate is not a regression by default.** It has now happened five times for five
non-regression reasons (§45 line endings, §46 corpus growth, §48 the target binding, §50
sub-region elision, §52 the constraint gate). Compare per-row, and look at whether fallbacks fell
and reduced counts rose — that is usually the story.

**Compare over the rows that reduce under every arm.** A variant that converts fallbacks into
reductions changes the denominator and can make a strictly worse rule look better on the mean.

**Byte-identical is not the same as inert.** §56 measured a real Python fix that moved 0 of 576
rows, because 0 of 45 Python corpus files contained the shape it fixes. Before concluding a change
does nothing, ask whether the corpus contains the case at all — count the occurrences directly. A
corpus that cannot see a fix is a fact about the corpus.

## Line endings will bite

The repo is uniformly CRLF, and prose files are themselves corpus. A Python rewrite in default
text mode reads CRLF as `\n` and writes back LF, silently converting the file — which is §45's
defect (line endings adding a byte per line) arriving through the editing tool rather than git.

After any scripted edit to a tracked file:

```bash
python -c "
import io,sys
for f in sys.argv[1:]:
    b=io.open(f,'rb').read(); c=b.count(b'\r\n')
    print(f, 'CRLF=%d LF-only=%d'%(c, b.count(b'\n')-c))
" <files>
```

Mixed means fix it before committing. Heredocs (`cat >> file <<'EOF'`) write LF and will mix a
CRLF file.

## Recording the number

A measurement nobody wrote down gets re-derived wrong later — that is most of what `DECISIONS.md`
is defending against. When the number matters, record it in `docs/audit-remediation-status.md` §2
(the live baseline) or as a DECISIONS entry, with:

- the commit the corpus was frozen at, and the file/row counts
- what varied between arms, and what did not
- the per-row result, not just the aggregate
- what the measurement **does not** establish

That last line is the one people skip and the one that ages best.
