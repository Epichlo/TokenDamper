# Proposed Architecture Changes — TokenDamper

## Context
Current architecture (MVP, linear pipeline, no DAGs):

```text
Raw Input (JSON/Text)
  -> Adapter (CLI / HTTP Gateway / MCP)
  -> ContextBundle + OptimizationBudget
  -> Stateless 0/1 Knapsack Planner
  -> Linear Engine
      -> Session Deduplication (TokenHasher)
      -> Delta Compression (Myers Diff)
      -> Workspace Topology Pruning
  -> Validators (ConfidenceLedger, DebtTracker, DriftTracker)
  -> Fallback (if safety thresholds violated)
  -> Final Output (Optimized Context or Raw Input)
  -> Explainability Trace (stderr / JSON)
```

This shape is a reasonable MVP skeleton. The bugs surfaced during benchmarking (see
`tokendamper-headroom-known-issues.md`) trace back to two specific architectural gaps in
this pipeline, not implementation typos. These changes are scoped fixes, not a rewrite —
the linear shape and knapsack planner should stay as-is.

---

## Change 1 — Make content-type a first-class planning input, not a post-hoc validation discovery

**Problem:** The planner allocates *how much* to compress but has no awareness of *what
kind* of content it's compressing. `compression:token-hashing` writes a
`<BLOCK_HASH:sha256>` placeholder into JSON content, and only the downstream AST/JSON
validator discovers this broke syntax — after the transform has already run. This is the
root cause of the self-inflicted JSON corruption bug (Issue 2 in the known-issues file).

**Proposed fix:** `ContextBundle` should carry a content-type tag (e.g. `json`, `code`,
`prose`, `logs`) determined at ingestion, and the Knapsack Planner should consult this tag
when selecting eligible stages — before any transform runs, not after. Concretely, either:
- Skip `compression:token-hashing` entirely for `json`-tagged bundles, or
- Change the hashing stage's placeholder format so it's syntactically valid for the
  detected content type (e.g. a quoted string token instead of a bare `<...>` tag).

Content-awareness belongs in the planning stage, not discovered downstream in validation.

---

## Change 2 — Replace the single global validate→fallback gate with per-stage checkpointing

**Problem:** `Validators` currently runs once, after the entire `Linear Engine` completes,
and `Fallback` is a single global action. This means if any one stage (e.g. stage 3 of 4,
token-hashing) produces invalid output, the *entire* pipeline's work is discarded —
including safe, valid reductions already achieved by earlier stages (Session Dedup, Delta
Compression). This is why `tool_output.json` and `session.json` landed at 0%/-1.39%
instead of partial reductions: every observed fallback discarded compute that was already
valid.

**Proposed fix:** Validate incrementally after each stage in the Linear Engine, not just
once at the end. On a stage-level validation failure, roll back only that stage's
transform and keep the output of prior stages. This doesn't require a full DAG rewrite —
it's a checkpoint-and-partial-rollback mechanism within the existing linear sequence. This
alone would likely convert at least 2 of the current 0%-fallback cases into partial
reductions.

---

## Change 3 — Guarantee the fallback path is byte-identical to raw input

**Problem:** The -1.39% anomaly on `session.json` (Issue 5 in the known-issues file)
indicates "Fallback" currently means "re-render `currentBundle`" rather than "return the
untouched raw input bytes." Re-rendering from an internal bundle model is how a fallback
ends up a different size than the original even when nothing was supposed to change.

**Proposed fix:** Split "fallback" into two distinct code paths:
1. **Raw passthrough** — bypasses the bundle/render model entirely and echoes the
   original input verbatim. This should be the actual fallback path.
2. **Bundle rendering** — used only for genuinely successful (non-fallback) output.

Byte-identical fallback should be a structural guarantee (impossible to violate by
construction), not something enforced only by testing.

---

## What to keep unchanged
- The linear (non-DAG) pipeline shape — no need for a full rewrite.
- The Knapsack Planner's budget-allocation logic.
- The explainability trace (`planMode`, `stageCount`, `tokenBefore`/`tokenAfter`,
  `fallbackReason`) — this should be **extended** to report per-stage status once
  checkpointing (Change 2) is added, not redesigned.

---

## Net effect of these three changes
Same overall architecture, but:
- Content-type flows into planning decisions instead of being discovered as a failure.
- A single bad stage no longer wipes out otherwise-valid upstream compression.
- Fallback output is guaranteed identical to raw input, closing the -1.39% class of bug.

These are scoped, additive changes to the existing pipeline — appropriate to hand to
Claude Code alongside `tokendamper-headroom-known-issues.md` as follow-up implementation
work.
