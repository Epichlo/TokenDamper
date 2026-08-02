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
> because `src/bench/runner.ts:45` calls `optimize(request)` with no options, so no
> `TokenHasher` and no `ConfidenceLedger` reach the engine and
> `attemptAutomatedRehydration` returns immediately on `if (!hasher && !ledger)`. See §8.
> That is being corrected separately; **re-read §8 before citing the fallback rate.**
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

## 10. What this record does **not** conclude

- **It does not answer the brief's actual question** — whether the threshold should be
  content-type-specific. It answers the prerequisite: what drives the score. On the present
  evidence a content-type-specific *threshold* looks like the wrong instrument, because the
  problem is not that `0.40` is mis-set for code but that the metric's structural half is
  inert for code (§5) and the transform hands it a boolean (§6). That is an argument
  against the framing, not a decision.
- **It does not propose the granularity fix.** Sub-item hashing granularity is the
  indicated direction, but the design is separate and unwritten.
- **It does not re-validate the benchmark fallback rate.** See §8.
