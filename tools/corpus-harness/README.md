# Corpus harness

Freeze a corpus, pin the engine, run both routes, record the trace.

This exists because every reduction figure in this project is measured over files a session
may also be editing, and because two separate measurements have already been wrong in ways
nothing caught: the repo moved under a measurement (CLAUDE.md, Gotchas), and a 4b.3 A/B loop
globbed one directory level and measured 132 of 144 files without noticing
(`docs/phase-4b-lever-disposition.md`, finding 3). [retired]

## Use

```bash
# 1. freeze: copy the corpus out, hash it, pin the engine
node tools/corpus-harness/collect.js <out-dir>

# 2. measure: verify hashes, run the CLI on both routes, dump traces
node tools/corpus-harness/measure.js <out-dir> --variant baseline

# 3. patch dist/, re-measure under another label, diff the two jsonl files
node tools/corpus-harness/measure.js <out-dir> --variant candidate
```

`<out-dir>` should be a scratch directory outside the repo. Never point it inside `src/`.

`seam2.js <out-dir>` is a one-off analysis, not part of the loop — it scores candidate
`looksLikeMarkdown` rules against the frozen corpus.

## What it guarantees

- **The corpus cannot move silently.** `measure.js` re-hashes every file against
  `manifest.json` and refuses to run on a mismatch.
- **The engine is pinned, and a dirty tree is visible.** The manifest records the commit, a
  sha256 over every `dist/**/*.js`, and `dirty: true` when the tree has uncommitted changes.
  A result carrying `dirty: true` is an A/B arm, not a baseline.
- **Counts are asserted, not eyeballed.** Each bucket declares `expect`; collection fails on a
  mismatch. `measure.js` asserts `rows === files × routes`.
- **It measures the shipped CLI.** `measure.js` spawns `dist/src/cli/main.js` rather than
  calling the engine in-process — `84fa00d` is the precedent for what happens when a harness
  builds its own `ContextBundle`.

## What it does not guarantee

The corpus is **machine-specific**. `recipe.json` points at third-party source found on a
developer machine (MSYS2, Git for Windows, a pip install) rather than bytes vendored into this
repo — vendoring GPL/BSD source to measure a classifier is a licensing problem for a
measurement. Two runs on the same machine are comparable; a run on another machine produces a
different manifest, which is visible rather than silent.

Aggregates are **not** directly comparable to the figures in `docs/phase-4b-*.md`: this corpus
applies a 1 KB floor, so the TypeScript bucket holds 56 of the repo's 64 sources.

Deterministic selection is not the same as representative selection. Sort-then-take is
reproducible, and on the first run it filled the entire prose bucket with `.agents/`
scratchpads because they sort first. Check what a bucket actually caught before trusting it.
