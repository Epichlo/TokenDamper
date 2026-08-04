# Phase 4b — Pathless Code Is Invisible to the Validator Layer (Scope)

> **Label:** this document was filed as `phase-1e-pathless-code-scope.md` while its contents
> called the work "4b". One label, and it is **4b** — filename, heading and steps now agree.
> Renamed 2026-08-04, before anything else came to reference the old name.
>
> **Status: 4b.0 landed 2026-08-04 (harness only — no engine change). 4b.1, 4b.2 and 4b.3
> remain scoping only, nothing implemented, nothing approved.** This document exists to be
> argued with before any code is written. Measured 2026-08-04 against `dist/` at `04ce2a3`,
> over corpora frozen in a scratch directory (`CLAUDE.md`, Gotchas — freeze before measuring).
>
> **Headline:** the obvious narrow fix — resolve a language inside `selectValidator` and leave
> classification alone — is the wrong one, and the measurement says so. It fixes the yield
> defect and makes a second, currently-latent defect material.

---

## 1. Reproduction

Same bytes, two entry forms, current build:

```
$ node dist/src/cli/main.js optimize corpus/…/codebase.py --target-reduction-ratio 0.3
  output 11,328 bytes   tokenBefore 5029  tokenAfter 3310  fallback false  drift 0
  astCoverage {"checked":1,"unchecked":0,"uncheckedContentTypes":[]}

$ node dist/src/cli/main.js optimize - --target-reduction-ratio 0.3 < corpus/…/codebase.py
  output 16,937 bytes   tokenBefore 5029  tokenAfter 5029  fallback true   drift 0.6
  astCoverage {"checked":0,"unchecked":1,"uncheckedContentTypes":["text"]}
  contentTypeCounts {"text":1, …}
```

`createContextBundle` derives `contentType` from content **and** `sourcePath`; stdin has no
path. With `contentType: 'text'`, `selectValidator` returns `null`, `selectElisionRegions`
returns nothing (it asks the same validator for a language), and the item falls to whole-item
hashing, where `S_k` pins at the formula constant `0.60` and the pipeline falls back.

§23's coverage reporting is working: `astCoverage` says plainly that nothing looked. The hole
is **visible**; it is not closed.

### Yield, both frozen corpora

| | file argument | stdin |
|---|---|---|
| pip corpus (39 Python files) — files reducing | 20 | **1** |
| pip corpus — aggregate tokens saved | 14.11% | **2.42%** |
| repo corpus (64 TS + 4 py) — files reducing | 30 | **5** |
| repo corpus — aggregate tokens saved | 19.31% | **0.13%** |

Two of the three entry modes are pathless by construction. `optimize -` has no path; the MCP
`optimize_context` schema accepts `rawInput` plus budget knobs and **no path or language
field**; Gateway messages are provider payloads and have neither. The CLI file argument is the
only route that works, and it is the one route a coding assistant does not use.

## 2. There are two defects here, not one

### D1 — no validator, no regions (the known one)

Described above. Costs yield, fails closed, visible on the trace.

### D2 — a positive misclassification that fabricates drift markers (not previously recorded)

Pathless content does not merely lack a type; it is assigned a wrong one with confidence:

```
pathless classification of the frozen corpora
  pip python  →  text 20,  markdown 19
  repo ts     →  text 63,  markdown  4,  html 1
```

Python files classify as **markdown** because `looksLikeMarkdown` tests
`/(^|\n)#{1,6}\s+\S/`, and `# NOTE: ...` is a Python comment. And
`DriftTracker.extractMarkers` harvests markdown headings for every type on the
`MARKDOWN_MARKER_TYPES` allowlist — which contains `markdown` **and `text`**:

```
pathless classification  →  fabricated markdown headings
  py/markdown   20 files   717 headings
  py/text       23 files   308 headings
  ts/*          64 files     0 headings
```

**1,025 fabricated structural markers across 43 Python files**, e.g.
`heading:# NOTE: Maybe use the optionx attribute to normalize keynames.` This is the defect
`57950bf` fixed ("stop reading Python comments as markdown headings") arriving by a different
route: that fix gated harvesting on `contentType`, and misclassification hands it a
`contentType` on the allowlist.

Worth noting for whoever touches that allowlist next: its docblock says a new `ContentType`
"should default to *not* harvesting these — an invented marker actively inflates drift". Its
membership includes `text` and `unknown`, which are the two "we do not know" buckets. The
stated rule and the list disagree.

**D2 is currently inert.** Nothing is elided on the pathless path, so before and after markers
are identical and `R_struct` stays 1.0. It becomes material the moment D1 is fixed.

## 3. Why the narrow seam is the wrong one — measured

The intuitive minimal change (call it **option D**) resolves a language inside
`selectValidator` when `path` and `language` are absent, leaving `classifyContent` untouched.
Blast radius looks smaller: validation and region selection change, `extractMarkers` does not.

That is exactly the problem. Simulating option D — real CLI output with regions elided, scored
by the real `DriftTracker` with the pathless `contentType` the item would still carry — over
the 20 pip files that reduce:

```
drift higher under option D          : 14 / 20
newly pushed over the 0.40 gate      : 1

  pip/_internal/cli/main_parser.py       text      S_k 0.400 vs 0.000   markers 24 -> 0
  pip/_vendor/packaging/_elffile.py      text      S_k 0.400 vs 0.000   markers  3 -> 0
  pip/_vendor/pygments/…/__init__.py     markdown  S_k 0.514 vs 0.114   markers  4 -> 0
  pip/_internal/configuration.py         markdown  S_k 0.361 vs 0.015   markers 30 -> 4
```

The right-hand column is the same elision scored with `contentType: 'code'`. Several files sit
at **exactly 0.400** — every fabricated heading destroyed, `R_struct = 0` — and pass only
because the gate is `> 0.40` rather than `>=`. Any real drift on top tips them over.

So option D would deliver the yield and simultaneously convert a dormant metric defect into
spurious fallbacks on precisely the content it was enabling. **Whatever resolves the language
must also correct the content type**, and the two must move together.

## 4. Is content-based detection viable at all? Python yes, TypeScript no

§17 removed content-only code detection on purpose: its only signal was a markdown fence, and
the verdict flipped on apostrophe parity in surrounding prose. The question is whether a
majority-of-lines rule — the shape §22 and §27 already use for logs and YAML — has a usable
margin. Measured, the answer differs by language, and the difference is not an accident.

**Python — separable, with a factor-of-seven margin.** Line predicates: `def`/`class` headers
ending in a colon, `from X import` / `import X` with no `from` clause, own-line decorators
(strong); block headers and statement keywords (weak); `#` lines neutral; and a disqualifying
count for shapes Python does not have (`;`/`{` line ends, `=>`, `function f(`, `const x =`).

| set | ratio range |
|---|---|
| pip Python (positive, n=39) | 0.000 – 0.569 |
| repo Python (positive, n=4) | 0.066 – 0.313 |
| repo TypeScript (negative, n=64) | 0.000 – **0.021** |
| repo prose (negative, n=27) | 0.000 – **0.008** |

Rule `strong ≥ 2 && ratio ≥ 0.15 && disqualified < 10%`: **38 of 43 Python files detected, 0
false positives on 64 TypeScript sources and 27 prose documents.** The five misses are files
with almost no `def`/`class`/`import` density — `pip/_vendor/rich/_cell_widths.py` is a 452-line
list literal and scores 0.000, which is correct: it is not recognisable as Python by structure.
Misses fail to today's behaviour, which is the safe direction.

**TypeScript — not separable on this corpus.** Using the same method, TypeScript positives span
0.283–1.000 and prose negatives reach **0.333**, with 34 strong-signal lines in
`docs/architecture/milestone_5_topology_knapsack_planner.md`. The ranges overlap; no threshold
orders them.

The cause is worth stating because it will not go away: this repository's prose is
*documentation about TypeScript*, dense with fenced TypeScript. Nobody here writes design docs
full of Python. A whole-item classifier must choose one answer for a document that is genuinely
both — which is §17's finding, reached from the other end. **A TypeScript content probe is not
proposed, now or later, without a different kind of signal.**

Real Gateway traffic behaves as the method predicts. Scoring the seven messages of
`test_data/session.json`:

```
  session[0] user       decisive   1   py 0.00   "Can you analyze our TokenDamper resilience pipel…"
  session[2] tool       decisive   5   py 1.00   "class CircuitBreaker:\n    def __init__(self):…"
  session[4] tool       decisive 200   py 0.00   "2026-07-30T19:00:12.144Z [WARN] Stage 3 circuit…"
  session[6] tool       decisive 120   ts 0.67   "{\n  \"stage_3\": {\n    \"retry_count\": 5,…"
```

A five-line Python snippet is detected; prose messages score zero. Note `session[6]`: JSON
scores high on a brace-and-semicolon signal and is saved only by `looksLikeJson` running first.
Probe **order** is load-bearing, and a code probe must stay behind the JSON check.

## 5. Proposed sequencing

Four changes, deliberately separable, in this order. Each is independently useful and each has
its own evidence.

**4b.0 — the benchmark harness passes a path (one line, no engine change). — LANDED
2026-08-04.** `run_benchmark.py` invoked `[cmd, "optimize", "-"]` and piped the text, which is
why it "saw no improvement from granularity". A harness defect, not an engine defect, and the
one that had been distorting published numbers. Landed alone, as proposed.

Measured over the four bundled fixtures, engine frozen at `95056df` (all 64 `dist/**/*.js`
hashes identical across both runs), corpus frozen by `sha256` manifest. Tokens are
`cl100k_base` via the harness's own `tiktoken`:

| fixture | before (stdin) | after (path) | outcome |
|---|---|---|---|
| `codebase.py` | 0.00% — fallback `S_k 0.60` | **27.61%** — no fallback | changed |
| `sample_logs.txt` | 0.00% — fallback, constraint directive | 0.00% — same | unchanged |
| `tool_output.json` | 0.00% — fallback `S_k 0.60` | 0.00% — same | unchanged |
| `session.json` | −1.39% — fallback `S_k 0.60` | −1.39% — same | unchanged |

**One fixture of four moves.** That is the honest headline: this corpus is one Python file,
one log, and two JSON payloads, and only the Python file is reachable by the path route. Logs
and JSON fall back for reasons that have nothing to do with the path, and would not move under
4b.1–4b.3 either.

Two figures in §1 and §7 of this document need reading in that light. §1 reports
`codebase.py` at 16,937 → 11,328 bytes, which the engine's own trace calls **34.18%**
(5,029 → 3,310). Scored with a real BPE tokenizer the same output is **27.61%**. The gap is
`EnhancedHeuristicTokenizer`, whose 24% mean absolute error CLAUDE.md already records; the
trace figure is a self-estimate and the `cl100k` figure is the one to publish. The §7
projections (`2.42% → up to 14.11%`, `1 → up to 20 files`) are likewise engine-estimator
figures over the frozen pip corpus and should be re-derived against `cl100k` before they are
quoted as expected value.

The −1.39% on `session.json` is **not** fixed by 4b.0 and is not meant to be. It is the
harness's *other* defect: `run_benchmark.py:75-77` sets `orig_tokens` from
`count_tokens(json.dumps(messages))`, a re-serialization that drops the file's pretty-printing,
while TokenDamper is handed the raw file and — correctly — echoes it back byte-identically on
fallback. The engine is behaving; the denominator is wrong. Separate concern, separate commit;
see CLAUDE.md's Issue 5 entry, which already documents it.

**4b.1 — let the caller declare the language.** `item.language` already exists on
`ContextItem`, is already **first** in `selectValidator`'s precedence, and **is never populated
by any adapter** — `constructors.ts:251` passes it through and nothing supplies it. Add the
declaration routes: a CLI `--language` / `--input-name` flag for stdin, a `path` or `language`
property on the MCP `optimize_context` schema, and an optional Gateway hint. Zero inference,
zero blast radius, and it is strictly better than a probe wherever the caller knows the answer
— which on the MCP path is always.

**4b.2 — a Python-only content probe, setting language *and* content type together.** Runs
only when `path` and a declared `language` are both absent, and only behind the JSON check.
Sets `language: 'python'` **and** `contentType: 'code'` atomically. Both, because §3 shows the
language alone leaves the marker fabrication in place — and because
`CONTENT_TYPE_VALIDATORS.code` maps to the **TypeScript** validator, so a `code` tag without a
language sends Python to the wrong checker. That coupling deserves a test, not a comment.

**4b.3 — the `MARKDOWN_MARKER_TYPES` allowlist, separately.** 4b.2 fixes the fabrication for
*detected* Python only. Undetected Python, and pathless code in any other language, still
harvest `#` and `- ` lines as structural markers from the `text` and `unknown` buckets. This is
its own decision with its own blast radius over every prose item in every bundle, and it should
not ride along.

**Not proposed:** a TypeScript or JavaScript content probe (§4), and any change to §17's
removal of fence-based detection.

## 6. Risks, and the measurement that must accompany 4b.2

1. **Turn-1 Gateway measurement is mandatory.** `validate()` runs `validateBundleAst` over
   *every* item in the final bundle, so a classification change can fail an item nothing
   touched. Measure turn 1 of a real session, where `cleanup:session-dedup` has no previous
   hashes and cannot elide: any fallback there is a false positive by construction. That is how
   §17 was found.
2. **New validation means new fallbacks are possible.** Enabling `PythonValidator` on pathless
   fragments will reject some of them — the pip corpus already produces one
   `Unexpected indent level 4` fallback on a *complete* file, and the Gateway carries
   fragments, which are worse. Needs its own before/after count on the session corpus, and a
   decision about whether a fragment that fails indentation should fall back or be reported as
   uncheckable.
3. **`code` → `tsValidator` is a trap.** Any path that sets `contentType: 'code'` without a
   language sends the item to the TypeScript validator. Pin it.
4. **User-visible marker text changes** for detected items — `[TokenDamper: N code lines
   elided…]` instead of `text`/`markdown`. Correct per §24, but it is a CHANGELOG line.
5. **Corpus bias.** The negative set is 27 documents from one repository plus 7 synthetic
   session messages. The zero-false-positive result is real but narrow; it should be re-run
   against a wider prose corpus before the probe is trusted, and the probe should be the kind
   that fails to today's behaviour rather than to a wrong answer.

## 7. Expected value, stated honestly

If 4b.1 and 4b.2 land, the pathless Python path should approach the file-argument path: on the
frozen pip corpus that is **1 → up to 20 files reducing** and **2.42% → up to 14.11%** aggregate
tokens saved, minus the five files the probe does not detect and minus whatever risk 2 costs.
TypeScript over stdin is **not** addressed and should not be claimed as addressed; 4b.1's
declaration route is the only thing on offer for it.
