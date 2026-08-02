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
