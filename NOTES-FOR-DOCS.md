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
session, same methodology as §9:

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
