# Phase 4b — Pathless Code Is Invisible to the Validator Layer (Scope)

> **Label:** this document was filed as `phase-1e-pathless-code-scope.md` while its contents
> called the work "4b". One label, and it is **4b** — filename, heading and steps now agree.
> Renamed 2026-08-04, before anything else came to reference the old name.
>
> **Status: 4b.0 landed 2026-08-04 (harness only). 4b.1 landed 2026-08-05 — see §8. 4b.2
> landed 2026-08-06 — see §9, and note that its §6 risk 2 was disposed of by a mechanism this
> document does not contain. 4b.3 landed 2026-08-06 — see §10, and read it before quoting §5's
> description of it: the fabrication it names is not in the buckets it names. All four steps
> are now implemented.** This document exists to be argued with before any code is written. Measured 2026-08-04 against `dist/` at `04ce2a3`,
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

> **Correction, 2026-08-06 (`docs/phase-0-measurement-baseline.md` §4).** "The CLI file argument
> is the only route that works" is true for Python and false in general. The file route works
> only for the **19 extensions in `isCodeExtension`**. `.pl` and `.tcl` are not among them, so
> Perl and Tcl classify `markdown` on the file route exactly as they do over stdin, and a
> 57,037-token Perl file passed **by name** is deleted whole at 100% with
> `astCoverage.checked: 0` and `fallbackUsed: false`. Read "pathless" in this document as
> "outside `isCodeExtension`" wherever it is used as the boundary of the defect.

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

**4b.1 — let the caller declare the language. — LANDED 2026-08-05, DECISIONS §29. See §8.**
`item.language` already exists on
`ContextItem`, is already **first** in `selectValidator`'s precedence, and **is never populated
by any adapter** — `constructors.ts:251` passes it through and nothing supplies it. Add the
declaration routes: a CLI `--language` / `--input-name` flag for stdin, a `path` or `language`
property on the MCP `optimize_context` schema, and an optional Gateway hint. Zero inference,
zero blast radius, and it is strictly better than a probe wherever the caller knows the answer
— which on the MCP path is always.

**4b.2 — a Python-only content probe, setting language *and* content type together. — LANDED
2026-08-06, DECISIONS §31. See §9.** Runs
only when `path` and a declared `language` are both absent, and only behind the JSON check.
Sets `language: 'python'` **and** `contentType: 'code'` atomically. Both, because §3 shows the
language alone leaves the marker fabrication in place — and because
`CONTENT_TYPE_VALIDATORS.code` maps to the **TypeScript** validator, so a `code` tag without a
language sends Python to the wrong checker. That coupling deserves a test, not a comment.

**4b.3 — the `MARKDOWN_MARKER_TYPES` allowlist, separately. — LANDED 2026-08-06, DECISIONS
§32. The paragraph below is wrong about where the fabrication lives; see §10.** 4b.2 fixes the fabrication for
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

---

## 8. 4b.1 as landed — what it measured, and three things this document got wrong

**Date:** 2026-08-05. Implemented: DECISIONS §29, `test/unit/declared-language.test.ts`.
Shipped surface: CLI `--language` / `--input-name`, MCP `optimize_context.language` /
`.path`. **No Gateway hint** — see below.

### The measurement

Corpora re-frozen for this change (the 2026-08-04 scratch copies were gone): 64 TypeScript
sources extracted from `HEAD` with `git archive`, and 45 `pip/_internal` Python files, each
under a `sha256` manifest. Engine A/B'd as `dist-before` (built from a stashed tree at
`5b19394`) against `dist-after`. Tokens are real `cl100k_base`, not the engine's estimator.
`--target-reduction-ratio 0.3`.

| corpus | bare stdin | `--language` | file argument | `--input-name` |
|---|---|---|---|---|
| repo TypeScript (64) | 0.07%, 2 files reduce, 57 fallbacks | **19.27%, 25 files** | 19.27% | 19.27% |
| `pip` Python (45) | 0.02%, 1 file, 43 fallbacks | **12.34%, 19 files** | 12.34% | 12.34% |

Byte-identical to the file-argument route on **109/109 files**. AST coverage 0/109 → 109/109
items checked. Deterministic across 6/6 fresh processes. Zero collateral: every undeclared
run is byte-identical before and after.

### Correction 1 — §7's expected value is not comparable to what landed, in either direction

§7 projected the pip corpus from `2.42% → up to 14.11%` and `1 → up to 20 files`. Those are
**engine-estimator** figures over a **different 39-file selection**. The landed measurement
is `0.02% → 12.34%` and `1 → 19 files` over 45 files in `cl100k`. Both differences push the
same way — a 24%-MAE estimator and a different file set — so the numbers are not evidence for
or against each other. Quote the §8 table, which states its tokenizer and its manifest.

### Correction 2 — TypeScript over stdin *is* addressed, by the declaration route

§7 closes: *"TypeScript over stdin is **not** addressed and should not be claimed as
addressed; 4b.1's declaration route is the only thing on offer for it."* That was written
about 4b.2's probe, which is Python-only and deliberately so. The declaration route landed
and delivers 19.27% on this repository's own sources. What remains unaddressed is
**undeclared** TypeScript over stdin, which is 4b.2's excluded scope (§4) and stays excluded.

### Correction 3 — the risk register missed the effect that dominates

§6 lists five risks, of which risk 2 (*"new validation means new fallbacks are possible"*)
was expected to cost a little yield through `PythonValidator` rejecting fragments. That is
not what happened. **Zero** fallbacks came from syntax. Six files across the two corpora
reduce under bare stdin and fall back once declared, and every one is `SEMANTIC_DRIFT_
UNMEASURABLE` — five TypeScript barrels and `pip`'s `status_codes.py`.

That is §28 reaching a route it had not reached. §28 refuses to certify an unwitnessed
elision only for items an AST validator **covers**, and nothing covers a pathless item, so
over stdin a symbol-free barrel was still being elided whole at `S_k = 0.0000` with no
fallback — the exact defect `5b19394` is recorded as closing:

```
index.ts, bare stdin:  135 -> 18 tokens   fallbackUsed false
                       astCoverage {checked: 0, unchecked: 1, uncheckedContentTypes: ["text"]}
                       driftCoverage {symbolBearingItems: 0, unwitnessedItems: []}
index.ts, declared:    refused            fallbackUsed true
                       driftCoverage {symbolBearingItems: 1, unwitnessedItems: [7c2bce68…]}
```

The consequence for anyone reading the yield table: the declared route is not uniformly
additive. It gains 44 files and gives back 6, and the 6 were reducing only by being deleted
under a score that had measured nothing. It also means **a pathless item is not merely
unoptimized — it is unprotected**, which is a stronger argument for 4b.2 than the yield
figures §7 makes it on.

### The Gateway hint, proposed in §5 and not built

§5's 4b.1 includes "an optional Gateway hint". It is deliberately unbuilt. A provider payload
has no per-message language field, so the only shape available to a header or a config key is
a **whole-request** declaration — and §4's own scoring shows a real session is heterogeneous:
of seven `session.json` messages, one is a Python snippet, one is JSON, and the rest are
prose and logs. Declaring `python` for that request tags English as Python and hands it to
`PythonValidator`, whose indentation rule prose does not satisfy. That turns a declaration
route into a fallback generator on precisely the traffic invariant 8 exists to protect. A
per-message declaration would need a header format naming message indices; that is a design
with its own measurement, not a flag.

### Addendum — the harness was a construction site too

Filed after the initial 4b.1 commit, on the question "is anything left". There are exactly
three `createOptimizationRequest` call sites: CLI, MCP, and `src/bench/fixtures/loader.ts`.
The third passed `sourcePath` and dropped `fixture.language` — a **required** field on
`BenchmarkFixture` — so the benchmark harness re-derived a content type from a filename it had
sometimes synthesized itself. `codexglue.ts` writes `src/item_<id>.txt` for a fixture with no
path, which classifies `text`, and that fixture then reached the engine with no validator and a
guaranteed fallback: `checked: 0`, 133 → 133 tokens. Declared: 133 → 59.

This matters beyond the one fixture. §1 of this document contrasts "the file argument route"
with "the stdin route" as though the file route were sound. It is sound *when the filename
carries the answer*. The harness demonstrates the third case — a path that exists but does not
describe the content — and that case is invisible to the framing this document started with.

Two consequences worth carrying into 4b.2:

1. **A path is not a declaration.** `src/item_pathless-1.txt` is a real `sourcePath` and tells
   the classifier something false. Any probe added in 4b.2 must not treat the presence of a
   path as evidence that classification succeeded.
2. **A false declaration fails closed, and cheaply.** Believing `language` broke
   `test/integration/bench.test.ts` Test 2, whose fixtures were English prose labelled
   `python`. §28 refuses the elision (no symbols in English), the input returns verbatim, and
   the only casualty is the reduction. That is the failure direction 4b.2's probe should also
   aim for — and it is the measured answer to §6's risk 5, which asked that the probe "fail to
   today's behaviour rather than to a wrong answer".

---

## 9. 4b.2 as landed — the probe, and the step this document did not specify

**Date:** 2026-08-06. Implemented: DECISIONS §31, `test/unit/python-content-probe.test.ts`.

### What shipped

`classifyContent` became a wrapper over `classifyContentShape`, which returns
`{ contentType, language? }`. The Python probe sits behind json/yaml/html/logs and ahead of
markdown, and sets both fields at once — §3's finding, implemented rather than argued.

### The addition: the probe proposes, the parser confirms

§6's risk 2 asked whether a fragment that fails the indentation rule should fall back or be
reported as uncheckable. The answer turned out to be neither, and it is a third option this
document did not consider:

> **A probe may only claim content the validator for that language already accepts.**

A declaration is the caller's assertion — failing on it is right, and §29 pins that case. A
detection is *our* guess, and content that does not parse is far likelier to mean the guess was
wrong than that the user's data is broken. Failing closed on our own guess is how a heuristic
becomes a fallback generator, which is precisely the trade §17 refused.

`PythonValidator` imports types only, so the model layer can consult it with no cycle, and it
runs only for candidates the regex pass already accepted.

Two measurements make this more than a nicety. The confirmation **fires**: a bad indent level,
an unterminated string and a call truncated mid-argument each clear the structural rule and are
each rejected by the parser. And it **costs nothing**: all six `pip` files the probe declines
parse fine, so the structural rule — not the validator — is what turned them down.

### Measured

| | detected | false positives |
|---|---|---|
| 45 `pip` Python (positive) | **39 (86.7%)** | — |
| 64 repo TypeScript | — | **0** |
| 25 repo markdown | — | **0** |
| repo YAML, `sample_logs.txt` | — | **0** |

| route | before | after |
|---|---|---|
| `pip` over stdin, undeclared | 0.02%, 1 file, 0/45 checked | **12.27%, 19 files, 39/45 checked** |
| `pip` as a file argument | 12.34% | 12.34% — **0 collateral** |
| repo TS over stdin | 0.07% | 0.07% — **0 files changed** |

99.4% of the filename route's yield, recovered without a filename. Gateway turn 1: no fallback,
byte-identical output. Turn 2: byte-identical before and after. Deterministic 6/6.

### Correction to §7's expected value

§7 projected `2.42% → up to 14.11%` for this corpus. The landed figure is `0.02% → 12.27%`, but
the two are not comparable in either direction: §7 used the engine's own estimator (24% MAE)
over a 39-file selection, and this uses `cl100k_base` over a 45-file selection re-frozen on
2026-08-05. The comparable pair is the one in the table above — the same corpus, the same
tokenizer, stdin against the filename route.

### What 4b.2 does not close, and 4b.3

An **undetected** pathless Python file is not merely unoptimized — §8's addendum said a path is
not a declaration, and the same holds for a non-detection. `pip`'s `status_codes.py` is a
symbol-free constants file the probe declines; over stdin nothing covers it, §28's refusal
cannot fire, and it is elided whole and unwitnessed (44 → 27 tokens) while the file route
correctly refuses it. Detection narrows that population, it does not close it.

**4b.3 is unchanged and still wanted.** Undetected Python and pathless code in every other
language still harvest `#` and `- ` lines as structural markers from the `text` and `unknown`
buckets. 4b.2 fixed the fabrication for *detected* Python only, exactly as §5 said it would.

---

## 10. 4b.3 as landed — the allowlist was not where the fabrication was

**Date:** 2026-08-06. Implemented: DECISIONS §32,
`test/unit/markdown-marker-allowlist.test.ts`.

### What §5 said, and what is true

§5: *"Undetected Python, and pathless code in any other language, still harvest `#` and `- `
lines as structural markers from the `text` and `unknown` buckets."*

Two errors, one small and one that changes what the step is.

**Small: `- ` lines are not harvested at all.** `collectMarkers` gates exactly three kinds —
`heading:` (`#{1,6}\s+`), `fence:` (` ``` `) and `section:` (`---`/`===`/`System:`/`User:`/
`Assistant:`/`[Context]`/`[Instructions]`). There is no bullet branch and never was.

**Large: the fabrication is not in `text` or `unknown`.** Measured pathless across five frozen
corpora:

| bucket | files | gated markers |
|---|---|---|
| `text` (60 TS + 2 py) | 62 | **0** |
| `html`, `logs` | 2 | **0** |
| `unknown` | — | only returned for empty content |
| `markdown` — **9 shell scripts** | 9 | **591**, every one a `#` comment |
| `markdown` — **4 undetected `pip` files** | 4 | **45**, every one a `#` comment |
| `markdown` — 25 real documents | 25 | 477 headings + 47 fences + 23 sections, genuine |

`looksLikeMarkdown` fires on a single `#` heading, so a shell script's first `# Copyright …`
line makes the whole file markdown. §2's original table (`py/text 23 files 308 headings`) was
taken before §22's classifier fix and 4b.2's probe moved that population; what is left sits in
`markdown`, where no allowlist edit can reach it without gutting the 25 real documents.

### So 4b.3 landed as scoped, and is inert

The list is now `markdown` alone — `text`, `html`, `logs` and `unknown` removed, because the
docblock's own rule says a type should default to not harvesting and the two "we could not
tell" buckets are the worst possible exceptions to it. 132 files over stdin, 40 over the file
route and both Gateway turns are byte-identical before and after. A latent-trap fix, stated as
such.

### The finding, which is worth more than the fix

`tclConfig.sh`, frozen, through the real CLI over stdin:

```
1,877 -> 19 tokens (99.0% deleted)   fallbackUsed false   driftScore 0.4
astCoverage    {checked: 0, unchecked: 1, uncheckedContentTypes: ["markdown"]}
driftCoverage  {structMeasured: true, measured: true, contentMarkersBefore: 79, …}
```

`S_k` lands on exactly `0.400` — `1 - (0.6·1 + 0.4·0)`, every fabricated marker destroyed —
and passes because the gate is `> 0.40` rather than `>=`. §3 predicted files sitting at exactly
0.400 in the abstract; this is one, and it is being deleted whole.

The harm is not the score. It is that `structMeasured: true` and `measured: true` are reported
on 79 comment lines, so the `DriftCoverage` reporting §28 added **so that this class would be
visible** says the item was witnessed. The fabricated markers forge the evidence that anything
was measured.

### Where it belongs, and how it reframes §28

Not in the allowlist (`# Copyright …` and `# A heading` are the same bytes). Not obviously in
`looksLikeMarkdown` either — that is a classifier change with blast radius over every prose
item, the gotcha CLAUDE.md states outright and the way §17 was found. It belongs in drift, in
the question §28 deferred: what does drift owe an item no validator covers?

§28 deferred that as a product question about **prose**. It is not. The population is
**everything no validator covers**, and that includes real source code in every language the
AST-lite suite does not implement — shell, Ruby, Go, Rust, SQL. "May TokenDamper compress
prose" and "may TokenDamper delete 99% of a shell script under a forged `measured: true`" are
not the same question, and the second one does not need a product decision.
