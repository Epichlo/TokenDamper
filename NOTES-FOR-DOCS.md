# Notes for Docs

Corrections to planning documents, recorded here rather than by editing those documents in
place. Each entry names the document, what it says, what is actually true, and why.

Planning docs in this repo have repeatedly been read as current state after going stale.
Appending here keeps the original proposal intact as a historical record while making the
correction discoverable next to it.

---

## `purposed architecture changes.md` — Change 1 specifies the wrong seam

**Date:** 2026-08-02
**Status of the correction:** approved, implemented in Phase 1a / Issue 2

**What the document says.** Change 1 ("Make content-type a first-class planning input")
specifies that *"`ContextBundle` should carry a content-type tag (e.g. `json`, `code`,
`prose`, `logs`) determined at ingestion."*

**What is actually true.** The tag belongs on `ContextItem`, not `ContextBundle` — and it
already exists there.

1. `ContentType` is defined at `src/core/model/types.ts:19` and carried on `ContextItem` at
   `:53`. `classifyContent()` (`constructors.ts:392`) already sets it at ingestion.
2. `selectValidator()` — the function that rejects the corrupting placeholder — dispatches
   **per item**, with precedence `language` → `path` extension → `contentType`. A
   bundle-level tag would key the transform and the check at different granularities, which
   is the exact mismatch that produced Issue 2. It would reproduce the bug's shape while
   appearing to fix it.
3. Bundles are heterogeneous by construction. A Gateway bundle is N messages: one may be a
   12 KB JSON tool result, the next a one-line prose question. A scalar bundle tag forces a
   choice between over-conservatism (skip the stage if *any* item is JSON) and corruption
   (apply a JSON contract to prose).
4. `ContextBundle` already carries the correct bundle-level view:
   `statistics.contentTypeCounts`, a `Record<ContentType, number>` histogram
   (`types.ts:90`). A scalar `bundle.contentType` would duplicate and contradict it.

**Consequent reframing.** Issue 2 is not "add content-awareness." The awareness exists:
`token-hashing.ts:75` copies `item.contentType` onto the item it produces and never reads it
to decide whether the transform is safe. The real defects are that four construction sites
bypass `classifyContent()` and hardcode a literal, that eliding stages never consult the tag
they already propagate, and that nothing binds how a stage elides to which validator will
judge the result.

**Where the approved design lives:** `docs/issue-2-content-type-contract-design.md`.

---

## `DECISIONS.md` §16 — the recoverable-elision rationale does not hold on the Gateway path

**Date:** 2026-08-02
**Status of the correction:** approved, implemented in Commit B of Issue 2

**What the document says.** §16 ("Recoverable References Are Not Semantic Drift") justifies
exempting `cleanup:session-dedup` elisions from drift on the grounds that *"a dedup marker
is a pointer: the full text is retained in the session store under `originalContentHash` and
is restorable on demand. Nothing is irrecoverably lost, so nothing should be scored as
loss."*

**Where that holds.** On the MCP path, where `rehydrate_context` exists and a client can
actually resolve the reference. §16 stands there.

**Where it does not.** On the Gateway path, which is the *only* path
`cleanup:session-dedup` currently runs on. The consumer there is a stateless provider API:

- It has no rehydration mechanism and will never call `rehydrate_context`.
- Each request is independent, so content sent in an earlier turn is not available to the
  model in this one. Prompt caching does not help — it reuses computation for identical
  prefix bytes, and an elision changes those bytes.
- `rehydrateRefs` — the only input that triggers rehydration inside the stage — is never set
  by any caller in `src/`. The rehydration branch is unreachable in the product.

So content elided from an outbound payload is not pointed at, it is **deleted**. Cross-turn
elision of a sole copy is lossy compression wearing a pointer's clothes, and `DriftTracker`
scoring it 0.60 was correct all along. The exemption was granting a pass to precisely the
case that deserved scoring — the same shape as the hardcoded `fallbackUsed: false` that
Phase 1.0a removed: a safety property asserted without being evaluated.

**The correction.** `recoverable: true` is now set only when an intact copy of the content
survives elsewhere in the **same outbound payload**. The stage preserves the first
occurrence of duplicated content so the copies after it reference something demonstrably
present in this request. That is a verifiable precondition rather than an assumed one.

**Measured cost:** `docs/phase-1-stabilization-summary.md` §9. Cross-turn dedup on code and
logs drops from ~99% to 0% with a fallback; within-payload duplication still deduplicates at
~66%. The Gateway's near-term dedup value is likely close to zero on realistic traffic.

**Not changed:** MCP behavior. `cleanup:session-dedup` only runs under `session_dedup`
planner mode, which only the Gateway sets, so the stage never executes on the CLI or MCP
paths. The change is path-agnostic in code and Gateway-only in effect.

---

## `docs/phase-1-stabilization-summary.md` §9 — the predicted flip happened, plus one it missed

**Date:** 2026-08-02
**Status of the correction:** measured, implemented in Commit C of Issue 2

**What the document says.** §9 records the cross-turn `tool_output.json` row still reading
99.14% after Commit B, notes that this is the §2.2 vacuity rather than a surviving
exemption, and predicts: *"Commit C (the relabel) is expected to flip that row to 0% and a
fallback ... It is listed here so the change is attributable when it happens rather than
read as a regression introduced by the relabel."*

**What happened.** The prediction held. Measured through the real proxy path, two turns per
session, same methodology as §9. **These are Gateway figures, derived from HTTP body byte
lengths — unaffected by the token-estimator unification (`1b1e999`), do not re-correct
them:**

| Payload (cross-turn, sole copy) | Before Commit C | After Commit C |
|---|---|---|
| `tool_output.json` | 13,785 / 13,982 = **98.59%**, no fallback | **0.00%**, fallback |
| `codebase.py` | 0.00%, fallback | 0.00%, fallback |
| `sample_logs.txt` | 0.00%, fallback | 0.00%, fallback |

Within-payload duplication is unchanged at ~66% with no fallback on all three, which is the
result that matters for the relabel being safe: it does not disturb the case where a
referent demonstrably survives in the same request.

**What §9 did not anticipate.** The relabel also introduced a **false positive**, caught by
measurement rather than by the design:

`validate()` runs `validateBundleAst` over **every item in the final bundle**, not only the
items a stage changed. So a newly computed tag can fail an item that nothing touched. With
`contentType` computed, a message quoting a code snippet classified as `code`, and
`selectValidator` maps `code` to the TypeScript validator — so on **turn 1**, where
`cleanup:session-dedup` has no previous block hashes and cannot elide anything, this fell
back:

    Here's the fix. It's the guard that's missing:

    ```ts
    const a = 1;
    ```

Three apostrophes leave an odd number of quote characters open and the message is rejected
as an unterminated string literal. The same message with one fewer contraction passes.

That is fixed in Commit C1 (`DECISIONS.md` §17) by reclassifying fenced content as
`markdown`, which selects no validator. C1 landed **before** the relabel so the Gateway was
never in the regressed state.

**The general lesson, worth carrying into per-stage checkpointing (Phase 1c).** A
content-type tag is not only an input to the transform; it is an input to the *check applied
to everything in the bundle*. Any future change to classification has a blast radius over
untouched items, and the way to see it is to measure turn 1 — where nothing is transformed,
so every failure is a false positive by construction.

---

## `purposed architecture changes.md` — Change 2 assumes a validation failure is attributable to a stage

**Date:** 2026-08-02
**Status of the correction:** design input for Phase 1c, which is **not started**

**What the document says.** Change 2 ("Replace the single global validate→fallback gate with
per-stage checkpointing") proposes: *"Validate incrementally after each stage in the Linear
Engine ... On a stage-level validation failure, roll back only that stage's transform and
keep the output of prior stages."*

**What that assumes.** That a validation failure can be attributed to the stage that caused
it. For a class of failures it cannot, and this was demonstrated rather than theorized
during Issue 2.

**1. A failure can originate in an item no stage touched.** `src/core/validation/index.ts`
runs `validateBundleAst(after)` over **every item in the final bundle**, not only the items
a stage changed. The fenced-prose defect in `DECISIONS.md` §17 was found exactly this way:
with `contentType` newly computed, a message quoting a code snippet failed the TypeScript
validator on **turn 1** of a Gateway session, where `cleanup:session-dedup` has no previous
block hashes and cannot elide anything. Nothing had been transformed. There was no stage to
roll back, and rolling one back would not have helped.

**2. Two of the four checks are bundle-scoped, not item-scoped.** Constraint-directive
retention compares the `before` directives against all `after` item content joined into one
string; `DriftTracker` computes `S_k` from whole-bundle symbol and marker *sets*. Neither
produces a per-stage or per-item attribution as written. Drift in particular is a set
comparison — a symbol dropped by stage 2 and a symbol dropped by stage 4 are
indistinguishable in the result.

**Consequence for the design.** "Roll back only the failing stage" needs a prior answer to
*which stage failed*, and for these cases the honest answer is "none of them" or "not
determinable." A checkpointing implementation that assumes attributability will roll back an
innocent stage and report a cause that is not the cause — the same class of error as the
hardcoded `fallbackUsed: false` that Phase 1.0a removed, and the vacuous JSON checks that
Commit C removed: a verdict asserted without being derived.

The suggested first step is to establish attribution before building rollback on it —
validate the *delta* a stage produced rather than the whole bundle, and decide explicitly
what happens to a failure that predates every stage. Change 2's estimate that this "would
likely convert at least 2 of the current 0%-fallback cases into partial reductions" should
be re-derived afterwards; both cited cases (`tool_output.json`, `session.json`) have since
changed behavior under `b11dcb0` and `ac16cec`.

**Also recorded in:** `docs/phase-1-stabilization-summary.md` §8 (1c), and `CLAUDE.md` as a
gotcha, because those are read.

---

## Every CLI/bench/MCP reduction figure recorded before `1b1e999` was inflated

**Date:** 2026-08-03
**Status of the correction:** measured, implemented in `1b1e999` (DECISIONS.md §19)

**What the documents say.** `CLAUDE.md` records under Gotchas: *"Token counting is currently
`content.length / 4`. It is an estimate, not exact."* Several records cite reduction figures
produced on the CLI or bench path.

**What was actually true.** Token counting was `content.length / 4` **on one side of every
comparison and `EnhancedHeuristicTokenizer` on the other.** `createContextBundle` measured
the input bundle with the tokenizer; `core/trace`, `attemptAutomatedRehydration`,
`gateway/proxy.ts` and three of the five stages measured their output with
`Math.ceil(len / 4)`. The heuristic runs 11–22% above `len / 4` on this corpus, so
byte-identical output measured as an 11–22% saving.

**Which figures this invalidates, and which it does not.**

| Record | Status |
|---|---|
| `docs/phase-1d-drift-investigation.md` §10 `avgReduction: 7.8217%` | **Was already flagged as fabricated in that document.** Now 0.0000%. See §12 there. |
| `docs/phase-1d-drift-investigation.md` §10 per-fixture 9.89%–17.92% | Same. All ten fixtures were byte-identical; every figure is 0.00%. |
| `tokendamper-benchmark/BENCHMARK_RESULTS.md` `tokenBefore`/`tokenAfter` trace lines | **Invalid.** Every pair was the estimator gap on unchanged content — see below. |
| `tokendamper-benchmark/BENCHMARK_RESULTS.md` reduction percentages | **Valid.** `run_benchmark.py` counts both sides with `tiktoken` `cl100k_base` on the actual text, independent of TokenDamper's internal estimator. |
| `docs/phase-1-stabilization-summary.md` §9 (66.15%, 66.37%, 66.21%, 99.14%, 0.00%) | **Valid. Do not re-correct these.** Gateway path, derived from HTTP body byte lengths. The Gateway's internal counters do shift unit (`rawTokens` 8,470 → 10,059 on a 36 KB payload) but its `dedupRatio` moves only 49.79% → 49.82%, because both of its sides already used the same estimator. |
| `NOTES-FOR-DOCS.md` §"the predicted flip happened" (98.59%, 0.00%, ~66%) | **Valid. Do not re-correct these.** Same Gateway measurement, same provenance. |

**The `BENCHMARK_RESULTS.md` trace lines specifically.** All four pairs are the heuristic
count of the input against the `len / 4` count of the *same* input:

| Payload | Recorded `tokenBefore` → `tokenAfter` | Implied saving | Measured now |
|---|---|---|---|
| `sample_logs.txt` | 3029 → 2724 | 10.07% | **3029 → 3029**, fallback, output byte-identical |
| `tool_output.json` | 3974 → 3009 | 24.28% | **3974 → 3974**, fallback, output byte-identical |
| `codebase.py` | 5029 → 4235 | 15.79% | **5029 → 5029**, fallback, output byte-identical |
| `session.json` | 4679 → 4049 | 13.47% | **4679 → 4679**, fallback, output byte-identical |

Re-measured through the real CLI at `--target-reduction-ratio 0.3`, build at `1b1e999`.

**Accuracy, separately.** `EnhancedHeuristicTokenizer` is named as though it improves on
`len / 4`. Scored against `cl100k_base` over the ten bench fixtures plus the four Gateway
payloads, it does not: mean absolute error **24%** against `len / 4`'s **17%** (max 56% vs
44%). That did not change which estimator was adopted — `TokenizerAdapter` is the seam a
real BPE tokenizer plugs into, and the planner already denominates knapsack weights and
1,024-token cache blocks in adapter units — but it is a real open item, and the fix is now a
one-line change to `DEFAULT_TOKENIZER`. DECISIONS.md §19.

---

## `CLAUDE.md` Issue 5 — the −1.39% is a benchmark-harness artifact, not a fallback defect

**Date:** 2026-08-03
**Status of the correction:** measured against source; **Phase 1b is not yet rescoped**

**What the document says.** `CLAUDE.md`: *"**Issue 5:** on fallback, `session.json` emits
**−1.39%** — output is *larger* than input. Fallback re-renders `currentBundle` instead of
echoing raw input bytes."* `docs/phase-1-stabilization-summary.md` §1b repeats it and scopes
Phase 1b around it.

**What is actually true.** Two things, both checkable.

**1. Fallback already echoes raw input bytes.** `src/core/fallback/index.ts` returns
`output: request.rawInput` when `validation.shouldFallback`. It is the **success** branch
that re-renders, joining `currentBundle.items` with newlines. Measured through the CLI at
`--target-reduction-ratio 0.3`, all four harness payloads fall back and all four emit output
byte-identical to their input:

```
sample_logs.txt : inBytes=10896 outBytes=10896 identical=true fallbackUsed=true
tool_output.json: inBytes=12036 outBytes=12036 identical=true fallbackUsed=true
codebase.py     : inBytes=16937 outBytes=16937 identical=true fallbackUsed=true
session.json    : inBytes=16193 outBytes=16193 identical=true fallbackUsed=true
```

**2. The −1.39% comes from the harness comparing two different strings.**
`tokendamper-benchmark/run_benchmark.py:75-77` special-cases session payloads:

```python
is_session = file_name.endswith(".json") and "session" in file_name
if is_session:
    messages = json.loads(raw_text)
    orig_tokens = count_tokens(json.dumps(messages))
```

`json.dumps` re-serializes and collapses the file's pretty-printing, so the "original" side
is measured on a **shorter string than the one TokenDamper was given**. TokenDamper receives
`raw_text` and, on fallback, echoes it back verbatim. Reproduced exactly:

```
raw file    chars=16131 tokens=6285   <- what TokenDamper received and echoed
json.dumps  chars=15785 tokens=6199   <- what the harness called "original"
=> reported reduction = -1.39%
```

That is `(6199 − 6285) / 6199`. The −1.39% is the pretty-printing the harness discarded, to
two decimal places.

**Why this matters beyond the number.** It is the same defect class as the estimator
mismatch recorded above — a ratio whose two sides measure different things — one layer up,
in the Python harness. It is the seventh instance of the project's recurring pattern.

**Consequence for Phase 1b.** Phase 1b is currently scoped as *"split fallback into raw
passthrough vs. bundle rendering"* on the strength of this figure. The figure does not
support it: the fallback path is already a raw passthrough. There may still be a case for
the split — the **success** path renders `items.join('\n')`, which is lossy for any
multi-item bundle and is why the Gateway must map `finalBundle` positionally instead
(invariant 9) — but that is a different defect with different evidence, and Phase 1b should
be re-derived from it rather than from Issue 5. **Not done here; flagged for decision.**

**Not changed:** the `-1.39%` figure in `tokendamper-benchmark/BENCHMARK_RESULTS.md`. It is
an accurate record of what that harness printed; the correction is to its interpretation.
