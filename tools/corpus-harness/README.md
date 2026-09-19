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

# timing is a SEPARATE invocation — never folded into the run above
node tools/corpus-harness/timing-run.js <out-dir> --variant baseline
```

`<out-dir>` should be a scratch directory outside the repo. Never point it inside `src/`.

`seam2.js <out-dir>` is a one-off analysis, not part of the loop — it scores candidate
`looksLikeMarkdown` rules against the frozen corpus.

## Timing (`timing-run.js`)

Per-file latency. **A separate invocation on purpose** — wall clock is noisy and
machine-dependent, byte-identity is deterministic and is what the rest of this harness exists
to produce. Folding timing into `measure.js` would make a green identity result depend on
machine load.

It reports **three** numbers, because one would be wrong:

| | |
|---|---|
| `cold` | git workspace cache cleared per file — models the **CLI**, a fresh process each time |
| `warm` | cache retained — models the **Gateway** and **MCP**, which are long-lived |
| `fixed` | spawned wall clock minus `cold` — Node boot plus module load |

Measured `cold` p50 **159.1ms** against `warm` p50 **3.8ms** — a **41.48x** ratio, caused by
`globalGitCache` (2000ms TTL). Timing N files in one process and calling the result "per-file
latency" under-reports CLI cost forty-fold. See DECISIONS §76 for the baseline.

It drives the engine **in-process through `runCli`** with captured streams, so the computation
is the CLI’s rather than an approximation of it — the ~151ms of per-process fixed cost would
otherwise swamp any engine difference. That buys resolution and costs a guarantee, so **every
file is also run spawned and the output bytes compared**. One disagreement refuses the whole
report.

### Three things it refuses to report

Each was added because the run that produced it looked fine:

- an **empty sample** — a p95 of `0` over no observations reads as a measurement
- a **coverage gap** between the two routes, rather than comparing the intersection
- a run where **no stage was attributed**. The first baseline run did exactly this on all 292
  files: `timeOnce` read `result.trace` and `runCli` returns an exit code, so the per-stage
  table was empty beside a plausible end-to-end number. The instrument had the failure mode it
  was built to detect.

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
