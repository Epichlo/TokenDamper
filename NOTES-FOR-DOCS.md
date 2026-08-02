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
