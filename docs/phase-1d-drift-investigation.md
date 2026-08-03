# Phase 1d — Semantic Drift Investigation (Diagnostic Record)

> ## ⚠️ What this is, and what it is not
>
> This is the **investigation** half of Phase 1d, recorded **2026-08-03** at commit
> `3dc30f4`. The brief was: *"`codebase.py` aborts on semantic drift 0.60 > 0.40.
> Investigate what drives the score, then tell me whether the threshold should be
> content-type-specific rather than shared across prose, logs, and code. Do not change the
> threshold without making the case first."*
>
> **The threshold has not been changed, and this record does not propose changing it.**
> Every number below is measured, with the reproduction script described in §9.
>
> ### One measurement caveat that qualifies the whole document
>
> The benchmark fallback rate cited here (100%, 10/10 fixtures) was measured with the
> engine's automated-rehydration recovery path **switched off** — not deliberately, but
> because `src/bench/runner.ts:45` called `optimize(request)` with no options, so no
> `TokenHasher` and no `ConfidenceLedger` reached the engine and
> `attemptAutomatedRehydration` returned immediately on `if (!hasher && !ledger)`. See §8.
>
> **Corrected 2026-08-03 — the valve is now enabled and §10 supersedes the fallback rate:
> it drops to 0.40.** §10 also documents what enabling it exposed: the benchmark's
> `avgReduction` figure is fabricated by an estimator mismatch, and actual savings are zero
> either way. **Corrected again 2026-08-03 — the estimator is now unified (`1b1e999`,
> DECISIONS.md §19) and §12 supersedes every reduction figure in §10: they are all 0.00%,
> which is what the tooling now reports. Read §10 and §12 before citing any benchmark
> number from this document.**
>
> The per-fixture drift *mechanics* in §2–§6 are unaffected by it — they are computed from
> `DriftTracker` directly on before/after bundles, not from the benchmark's fallback
> outcome.

---

## 1. Summary

The prevailing hypothesis was that the `0.40` drift threshold is too sensitive for code.
That hypothesis is **not supported**. Three things are true instead:

1. `extractSymbols` returns an **empty set** on the optimized side of every code fixture —
   and that is *correct*, not a misparse. `compression:token-hashing` replaces the item's
   entire content with a 77-byte placeholder, so there is nothing left to extract.
2. **No validator participates in symbol extraction.** Extraction is pure regex over
   `item.content`. The "wrong validator is parsing it" hypothesis is inapplicable.
3. **`0.60` is a formula constant, not a measurement.** It is `w_AST` exactly, produced
   whenever `R_AST = 0` and `R_struct = 1`.

The real cause is **granularity** (§6): `token-hashing` is whole-item and all-or-nothing,
and `createContextBundle` produces a **single-item** bundle for CLI and bench input. Every
symbol therefore dies simultaneously, `R_AST` can only be `0` or `1`, and there is no
fractional case for the metric to measure.

A separate, independent finding (§5) stands regardless of how the granularity problem is
solved: for code, **40% of the metric does no work**.

---

## 2. Q1 — what `extractSymbols` returns on the optimized side

Measured on the first three bundled bench fixtures, plan
`topology_knapsack` → `cleanup:constraint-preservation` → `pruning:topology-pruner` →
`compression:token-hashing` → `compression:delta-compression`. Only
`constraint-preservation` and `token-hashing` reported `changed`.

| Fixture | Content before → after | symbolsBefore | symbolsAfter |
|---|---|---|---|
| `HumanEval/0` | 348 B → 77 B | 2 — `{fn:has_close_elements, import:typing}` | **0** — `{}` |
| `HumanEval/1` | 504 B → 77 B | 3 — `{fn:is, fn:separate_paren_groups, import:typing}` | **0** — `{}` |
| `HumanEval/2` | 328 B → 77 B | 1 — `{fn:truncate_number}` | **0** — `{}` |

The optimized content in every case is a single placeholder:

```
<BLOCK_HASH:216f86867f4323186122cabc98606f33a05a92ac68d8ad463dfe6598944642cb>
```

Empty is the right answer. A 77-byte hash contains no `def`, no `class`, no `import`. The
extractor is reporting accurately on content that no longer exists.

---

## 3. Q2 — no validator is involved in extraction

`DriftTracker.extractSymbols` reads `item.content` and applies eight regexes. It never
calls `selectValidator`, and it does not parse. The only `contentType`-sensitive branch in
the whole function is the `jsonkey:` harvest at `drift-tracker.ts:240`, gated on
`item.contentType === 'json'` — which never applies to code.

Demonstrated by holding content fixed and varying the tag across every legal value:

```
contentType=code      symbols n=4 {fn:render, fn:helper, type:Widget, import:os}
contentType=text      symbols n=4 {fn:render, fn:helper, type:Widget, import:os}
contentType=json      symbols n=4 {fn:render, fn:helper, type:Widget, import:os}
contentType=markdown  symbols n=4 {fn:render, fn:helper, type:Widget, import:os}
contentType=unknown   symbols n=4 {fn:render, fn:helper, type:Widget, import:os}
```

Identical across all five. Symbol extraction cannot be fixed by correcting a tag or a
validator, because neither reaches it.

---

## 4. Q3 — `0.60` is a formula constant

```
S_k = 1 − (w_AST · R_AST + w_struct · R_struct)      w_AST = 0.60, w_struct = 0.40
```

With `R_AST = 0` and `R_struct = 1`:

```
S_k = 1 − (0.60 × 0 + 0.40 × 1) = 1 − 0.40 = 0.60
```

`0.60` **is** `w_AST`, reproduced by construction. It carries no information about *how
much* was lost — only that `R_AST` reached zero. Measured identical to four decimal places
on every fixture, across Python, TypeScript and JavaScript. A value that is constant across
three languages and every payload size is not measuring the payload.

---

## 5. Finding — for code, 40% of the metric is a constant

**This finding is independent of the granularity cause and survives whatever fix is chosen
for it.** Recorded in `DECISIONS.md` §18.

`extractMarkers` harvests: `filepath:` (from `item.path`), markdown headings, code fences,
`TD_PRESERVE:` directives, and section delimiters. For a source file with none of those in
its content, the marker set is exactly one entry — `filepath:<path>` — derived from
`item.path`, which is **metadata**. Elision rewrites `content`; it never touches `path`.

So `R_struct = 1.0` by construction for code:

| Fixture | markersBefore | markersAfter | R_struct |
|---|---|---|---|
| `HumanEval/0` | 1 — `{filepath:src/has_close_elements.py}` | 1 — same | 1.0000 |
| `HumanEval/1` | 1 — `{filepath:src/separate_paren_groups.py}` | 1 — same | 1.0000 |
| `HumanEval/2` | 1 — `{filepath:src/truncate_number.py}` | 2 — same + a directive | 1.0000 |

Three consequences:

1. The `w_struct` term contributes a **fixed 0.40** to retention. It cannot vary, so it
   cannot discriminate between a good transform and a catastrophic one.
2. `S_k` for code is therefore confined to **`[0.00, 0.60]`** — it is
   `0.6 · (1 − R_AST)` in disguise, a one-variable metric wearing a two-variable formula.
3. The `0.40` threshold sits at **two-thirds of a maximum the metric can never exceed**.

Reachable values, with `R_struct` pinned:

| R_AST | R_struct | S_k |
|---|---|---|
| 1.0 | 1.0 | 0.0000 |
| 0.5 | 1.0 | 0.3000 |
| 0.0 | 1.0 | **0.6000** ← ceiling |
| 0.0 | 0.5 | 0.8000 (unreachable for marker-free code) |
| 0.0 | 0.0 | 1.0000 (unreachable for marker-free code) |

This is not a badly-tuned threshold. It is a metric whose structural half does no work on
the content type the product exists to serve. Tuning the number would paper over that.

> **Note.** The `R_struct < 1` rows above *are* reachable for Python today, but only via a
> defect: `extractMarkers` matches `/^#{1,6}\s+/` and Python comments satisfy it. See §7.

---

## 6. The cause — transform granularity, not the metric

`compression:token-hashing` maps over bundle items and, for each eligible one, replaces its
**entire content** with a single placeholder (`token-hashing.ts:37–90`). There is no
sub-item granularity: an item is hashed whole or not at all.

`createContextBundle` (`constructors.ts:91`) builds `items = freeze([item])` — a **single
item** — from CLI and bench input.

Composing those two facts: on the CLI and bench paths, one successful `token-hashing`
destroys every symbol in the bundle simultaneously. `R_AST` is therefore not a ratio in
practice; it is a **boolean**, `0` or `1`. `S_k = 0.60` is deterministic, exceeds `0.40`,
and falls back — **every time, structurally**. `token-hashing` can never succeed on a
single-item code bundle.

**Measured caveat:** a file with no extractable symbols behaves differently, because
`R_AST` defaults to `1.0` when `symbolsBefore.size === 0`:

```
symbol-free code item : symbolsBefore=0  R_AST=1.0000  S_k=0.0000  fallback=false
```

So the rule is: *given at least one extractable symbol*, a single-item code bundle always
fails. A symbol-free file passes trivially — which is its own small dishonesty, since it
passes by having nothing to measure.

### The metric grades correctly once it has granularity

The same stage, same threshold, on multi-item bundles where some items are below
`token-hashing`'s 40-character eligibility floor and therefore survive intact:

| Bundle shape | Items hashed | R_AST | R_struct | S_k | Outcome |
|---|---|---|---|---|---|
| 1 item (**the CLI/bench shape**) | 1 / 1 | 0.0000 | 1.0000 | **0.6000** | fallback |
| 2 items, both eligible | 2 / 2 | 0.0000 | 1.0000 | **0.6000** | fallback |
| 4 items, all eligible | 4 / 4 | 0.0000 | 1.0000 | **0.6000** | fallback |
| 4 items, 1 long + 3 short | 1 / 4 | 0.4286 | 1.0000 | 0.3429 | **ok** |
| 4 items, 2 long + 2 short | 2 / 4 | 0.2222 | 1.0000 | 0.4667 | fallback |
| 4 items, 3 long + 1 short | 3 / 4 | 0.0909 | 1.0000 | 0.5455 | fallback |

The middle rows are the point: given a fractional `R_AST`, `S_k` moves smoothly and the
`0.40` threshold discriminates sensibly — one-of-four passes, two-of-four fails. The metric
is not broken. It is being fed a transform that only ever hands it `0` or `1`.

Note also that the top three rows are identical regardless of bundle size. `S_k` is
scale-invariant here precisely because *all* symbols die in every case.

---

## 7. A real extraction defect — in `extractMarkers`, not `extractSymbols`

`extractMarkers` classifies any line matching `/^#{1,6}\s+/` as a markdown heading. **Python
comments match that pattern.**

```
1 item, python WITH # comments   R_AST=0.0000  R_struct=0.3333  S_k=0.8667  FALLBACK
```

Two `#` comments push `S_k` to `0.8667` — *above the `0.60` ceiling* §5 establishes for
code, because the comment-derived pseudo-markers are destroyed along with the content while
`filepath:` survives. Drift on Python therefore scales with comment density.

This is a straight bug and is fixed separately, ahead of any granularity work, because it
contaminates every Python measurement taken while designing that work.

---

## 8. The fallback rate was measured with the recovery valve disabled

`src/bench/runner.ts:45` calls `optimize(request)` with **no options**. The engine's
recovery path is:

```ts
function attemptAutomatedRehydration(bundle, hasher?, ledger?, turn = 1) {
  if (!hasher && !ledger) {
    return undefined;
  }
  ...
```

With neither supplied it returns immediately. So on validation failure the engine's
documented ability to un-hash placeholders and re-validate **never runs** in the benchmark,
and the observed 100% fallback rate is a number taken with that machinery switched off.

This is the fifth instance of the same pattern in this project — a result produced by
machinery that never executed, after the hardcoded `fallbackUsed: false`, the vacuous JSON
AST check, the vacuous JSON drift check, and the unreachable `post_condition_rejected`. It
is why `CLAUDE.md` invariant 10 exists.

**Consequence for this record:** §2–§7 stand, because they are computed from `DriftTracker`
directly. The benchmark fallback *rate* does not stand until re-measured with the valve
enabled.

---

## 9. Reproduction

All figures come from two scripts run against `dist/` at `3dc30f4`:

1. **Per-fixture drift decomposition** — loads the bundled fixture set, re-runs
   `plan()` + `executeBuiltInStage()` step by step so the *pre-validation* bundle is
   observable (the engine returns `request.bundle` on fallback, which would hide exactly
   what is being measured), then prints the symbol and marker sets on both sides alongside
   `DriftTracker.calculateDrift`'s own component ratios.
2. **Bundle-shape sweep** — synthesizes 1/2/4-item bundles with a controlled mix of items
   above and below `token-hashing`'s 40-character floor, and runs the stage in isolation.

Budget in both cases: `targetReductionRatio: 0.30` over `loadConfig()` defaults. Without a
budget the planner returns `pass_through` with zero stages and every figure is trivially
zero.

---

## 10. Addendum (2026-08-03) — the recovery valve enabled, and what it exposed

§8 said the 100% fallback rate was measured with `attemptAutomatedRehydration` switched
off. It has now been enabled — `src/bench/runner.ts` passes a fresh `TokenHasher` per run,
which is what the engine needs both to *make* the placeholders reversible and to reverse
them. Re-measured on the same ten fixtures at `targetReductionRatio: 0.30`:

| Metric | Valve off | Valve on | Real? |
|---|---|---|---|
| `fallbackRate` | 1.00 | **0.40** | **yes** |
| `totalValidationIssues` | 11 | **4** | **yes** |
| `avgReduction` | 0.0000% | **7.8217%** | **no — see below** |
| Actual bytes saved | 0 | **0** | — |

### The fallback drop is real

Six of ten fixtures now recover instead of falling back. The engine detects the drift
failure, rehydrates the `<BLOCK_HASH:…>` placeholder back to its original content,
re-validates, and passes. That machinery works and had simply never been switched on.

### The reduction figure is fabricated

**Every fixture's output is byte-identical to its input** — verified directly, not inferred:

| Fixture | in bytes | out bytes | identical | in tokens | out tokens | `ceil(len/4)` | reported |
|---|---|---|---|---|---|---|---|
| `HumanEval/0` | 348 | 348 | **yes** | 106 | 87 | **87** | 17.92% |
| `HumanEval/1` | 504 | 504 | **yes** | 146 | 126 | **126** | 13.70% |
| `HumanEval/2` | 328 | 328 | **yes** | 91 | 82 | **82** | 9.89% |
| `HumanEval/3` | 446 | 446 | **yes** | 126 | 112 | **112** | 11.11% |
| `HumanEval/4` | 386 | 386 | **yes** | 109 | 97 | **97** | 11.01% |
| `CodeXGLUE/py/102` | 164 | 164 | **yes** | 48 | 41 | **41** | 14.58% |

`out tokens` equals `ceil(len/4)` exactly in every row. The cause is that **two different
token estimators are in use**, and a reduction ratio compares one against the other:

| Estimator | Sites |
|---|---|
| `EnhancedHeuristicTokenizer` | `constructors.ts:108` (`createContextBundle` — the **input** side), `:131` (`createBundleFromItems`) |
| Naive `ceil(len / 4)` | `engine/index.ts:398` (`attemptAutomatedRehydration`), `trace/index.ts:56`, `gateway/proxy.ts:505,627`, `constraint-preservation.ts:103`, `session-dedup.ts:186`, `delta-compression.ts:273` |

The input bundle is measured with the tokenizer; every bundle a stage or the rehydrator
produces is measured with `ceil(len/4)`. On this corpus the tokenizer runs 11–22% above
`len/4`, so identical bytes register as an 11–22% saving.

**This is not confined to the benchmark.** Any successful optimization on the CLI path
reports a reduction inflated by the same gap, because `createContextBundle` uses the
tokenizer and every stage's output bundle uses `ceil(len/4)`. It was invisible until now
only because everything was falling back, and on fallback `finalBundle = request.bundle`,
so both sides used the tokenizer and the ratio was a true 0%.

The Gateway is *not* affected the same way: it builds its input bundle with `ceil(len/4)`
too, so both sides use the same estimator. The Gateway figures reported earlier in this
work (66%, 98.59%, 0%) were computed from actual HTTP body byte lengths, and stand.

### What the valve does and does not buy

It converts "fallback, 0% saved" into "success, 0% saved". Actual token savings on this
corpus remain **exactly zero** with the valve on, because the engine's recovery *is* the
undoing of the compression. That is a better outcome than a fallback — the fail-open path
is no longer being exercised as though it were normal operation — but it is not a reduction
win, and the `avgReduction` figure must not be cited as one.

This is the sixth instance of the vacuity pattern in this project, and the first where the
fabricated value reports **success** rather than a passed check. It is why the delta was
reported before any design work rather than after.

### Consequence for §5 and §6

Unchanged. Both are computed from `DriftTracker` on before/after bundles and do not touch
token estimates. The four remaining fallbacks are still drift at exactly `0.60`
(`CodeXGLUE/py/101`, `ts/201`, `js/301`) plus the pre-existing unclosed-bracket AST failure
on `CodeXGLUE/ts/202`.

Note the recovery valve is, in effect, an accidental partial implementation of per-stage
rollback for one specific stage: it undoes `token-hashing` and keeps the earlier stages'
work. Phase 1c should account for it rather than build a second mechanism beside it.

---

## 11. What this record does **not** conclude

- **It does not answer the brief's actual question** — whether the threshold should be
  content-type-specific. It answers the prerequisite: what drives the score. On the present
  evidence a content-type-specific *threshold* looks like the wrong instrument, because the
  problem is not that `0.40` is mis-set for code but that the metric's structural half is
  inert for code (§5) and the transform hands it a boolean (§6). That is an argument
  against the framing, not a decision.
- **It does not propose the granularity fix.** Sub-item hashing granularity is the
  indicated direction, but the design is separate and unwritten.
- **It does not re-validate the benchmark fallback rate.** See §8.

---

## 12. Addendum (2026-08-03) — the estimator unified; the real reduction on this corpus is zero

§10 identified the `avgReduction: 7.8217%` as fabricated by an estimator mismatch and
declined to cite it. The mismatch is now fixed (`1b1e999`, DECISIONS.md §19): all
measurement routes through `estimateTokens` / `estimateBundleTokens` in
`src/core/hashing/tokenizer.ts`, and `countTokens` is called from exactly one place.

**Every per-fixture figure in the §10 table is 0.00%.** Re-measured on the same ten
fixtures at `targetReductionRatio: 0.30`:

| Fixture | in bytes | out bytes | identical | §10 reported | now |
|---|---|---|---|---|---|
| `HumanEval/0` | 348 | 348 | **yes** | 17.92% | **0.00%** |
| `HumanEval/1` | 504 | 504 | **yes** | 13.70% | **0.00%** |
| `HumanEval/2` | 328 | 328 | **yes** | 9.89% | **0.00%** |
| `HumanEval/3` | 446 | 446 | **yes** | 11.11% | **0.00%** |
| `HumanEval/4` | 386 | 386 | **yes** | 11.01% | **0.00%** |
| `CodeXGLUE/py/101` | 192 | 192 | **yes** | 0.00% | **0.00%** |
| `CodeXGLUE/py/102` | 164 | 164 | **yes** | 14.58% | **0.00%** |
| `CodeXGLUE/ts/201` | 130 | 130 | **yes** | 0.00% | **0.00%** |
| `CodeXGLUE/ts/202` | 49 | 49 | **yes** | 0.00% | **0.00%** |
| `CodeXGLUE/js/301` | 112 | 112 | **yes** | 0.00% | **0.00%** |

| Metric | §10 (valve on) | now |
|---|---|---|
| `avgReduction` | 7.8217% (fabricated) | **0.0000%** |
| `fallbackRate` | 0.40 | **0.40** — unchanged |
| `totalValidationIssues` | 4 | **4** — unchanged |

The two unchanged metrics are the point: nothing about the engine's *behavior* moved. Only
the arithmetic used to describe it did. §10's "actual token savings on this corpus remain
exactly zero" is now what the tooling reports rather than something a reader has to know.

**§10's four already-zero rows were not clean either.** Those are the fallbacks, where the
*benchmark's* ratio compared two tokenizer-derived bundle summaries and correctly read 0%.
Their `trace.tokenAfter` was still the naive count, so the MCP adapter — which divides
`trace.tokenAfter` by `trace.tokenBefore` — reported a saving on them anyway.
`CodeXGLUE/py/101` read 53 → 48, a phantom 9.4% **on a pure fallback**, where the emitted
text is `request.rawInput` verbatim. It is now 53 → 53.

**Accuracy is a separate, still-open question.** Scored against real `cl100k_base` over
these ten fixtures plus the four `tokendamper-benchmark/test_data` payloads,
`EnhancedHeuristicTokenizer` is the **less** accurate of the two estimators that were in
use — mean absolute error 24% against `ceil(len / 4)`'s 17%, max 56% against 44%. It was
adopted for the seam, not the numbers (DECISIONS.md §19). Recalibrating it, or landing
`createTiktokenAdapter` against a real encoder, is now a one-line change to
`DEFAULT_TOKENIZER`.

**A weak test surfaced while checking this, not fixed here.** `test/integration/bench.test.ts`
Test 2 asserts `avgReductionRatio >= 0.40` and passes — genuinely, in bytes: 151 → 77 and
153 → 77 on two synthetic prose fixtures. But the 77 bytes are a bare `<BLOCK_HASH:…>`
placeholder, and it passes the drift gate only because prose with no extractable symbols
takes `R_AST`'s `symbolsBefore.size === 0` default of 1.0 — the "passes by having nothing to
measure" case §6 already flagged. The threshold is being met by total content destruction on
inputs the metric cannot grade. Not an instance of the estimator bug; recorded so it is not
mistaken for evidence that the pipeline reduces anything.

**§5 and §6 are unaffected**, for the same reason §10 gave: both are computed from
`DriftTracker` on before/after bundles and never touch a token estimate. The four remaining
fallbacks are still drift at exactly `0.60` plus the unclosed-bracket AST failure on
`CodeXGLUE/ts/202`.
