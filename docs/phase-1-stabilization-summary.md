# Phase 1.0 and Issue 2 — Summary Report

> ## ⚠️ Scope: this is **not** all of Phase 1
>
> This document covers **Phase 1.0** (Gateway stabilization, `1.0a` + `1.0b`) and
> **Issue 2** (the content-type contract). Those are the parts that are done.
>
> The original Phase 1 brief also contains **1b** (byte-identical fallback), **1c**
> (per-stage checkpointing) and **1d** (the drift-threshold investigation). None of those
> are covered here, and as of `4335c31` none of them have been started. See
> §8 "Outstanding work" for the real list — and read that section before treating anything
> here as a statement about Phase 1 as a whole.

> ## ⚠️ Point-in-time record — not a live specification
>
> This document records work done **2026-08-01 → 2026-08-02**, across commits
> `4b11d7e..4335c31`. It is a historical account of what was done and why. It is **not** a
> description of current behavior and it is **not** a spec to implement against.
>
> Planning docs in this repo have twice been mistaken for current state after going stale.
> Before relying on any statement here, verify it against the source. Where this document
> and the code disagree, **the code is right and this document is out of date.**
>
> The load-bearing decisions from this report are duplicated into `CLAUDE.md` (invariants)
> and into comments at the relevant call sites, because those are read and this is not.
>
> ### Superseded: the drift-exemption rationale in §5.3 and §2.1
>
> §5.3 justifies exempting dedup elisions from drift on the grounds that a marker is a
> pointer to restorable content. **That rationale does not hold on the Gateway path**, and
> the §2.1 measurement showing dedup at `S_k = 0.0000` was therefore reporting a pass that
> had not been earned.
>
> The Gateway's consumer is a stateless provider API. It has no rehydration mechanism, never
> calls `rehydrate_context`, and has no memory of a previous turn's request. Content elided
> from an outbound payload is not pointed at — it is deleted, and the model cannot resolve
> the marker by any means available to it. Cross-turn elision of a sole copy is lossy
> compression, and drift scoring it 0.60 was correct all along.
>
> Corrected in Commit B: `recoverable: true` is now set only when an intact copy survives
> elsewhere in the **same outbound payload**, which is the only version of the claim the
> stage can verify. See §9 for the measured cost.

Covers Phase **1.0a** and **1.0b** of the Gateway stabilization work, plus the supporting
commits landed alongside them.

**Status:** both phases complete, merged to `main`, CI green.
**Range:** `4b11d7e..61bd685` (2026-08-01 → 2026-08-02).

> **Naming note.** The `1.0a` / `1.0b` labels originate in commit messages, not in
> `ROADMAP.md`. The roadmap's own "Phase 1" list was dropped as already-fixed (see
> `ROADMAP.md:207`). Treat these labels as a work-stream sequence, not a released
> milestone numbering.

---

## 1. The problem both phases address

`src/gateway/proxy.ts` called `runSessionDedupStage()` directly. It never invoked the
planner, the validators, `DriftTracker`, `ConfidenceLedger`, `DebtTracker`, or the
fallback resolver.

Consequences before this work:

- Invariant 3 (**fail-open fallback**) and invariant 5 (**drift threshold `S_k <= 0.40`**)
  held for CLI and MCP modes only. They did not exist on the Gateway path.
- `cleanup:session-dedup` was the only stage that ever ran on production Gateway traffic,
  and it ran with **zero** syntax/drift safety net.
- The Gateway also violated invariant 4 (**only `stage-registry` imports concrete
  stages**).
- `fallbackUsed: false` in the Gateway trace was a **hardcoded literal**, surfaced to MCP
  clients verbatim through the `tokendamper://session/{id}` resource.

Phase 1.0a addressed the dishonest reporting. Phase 1.0b fixed the underlying gap.

---

## 2. Commit timeline

| Commit | Date | Summary |
|---|---|---|
| `4b11d7e` | 08-01 | `fix(planner)`: knapsack mode triggers on `targetReductionRatio` (precursor) |
| `ed4d141` | 08-02 | **Phase 1.0a** — stop asserting `fallbackUsed` on the proxy path |
| `1e839a2` | 08-02 | `docs`: correct v1.1.0 baseline, gateway-bypass limitation, tiktoken status |
| `b932180` | 08-02 | `docs`: add `CLAUDE.md` + stabilization planning docs |
| `2042ce6` | 08-02 | `chore`: add TokenDamper vs. Headroom benchmark harness |
| `aba84df` | 08-02 | `fix(test)`: tolerate expected fallback on Python fixtures (CI repair) |
| `61bd685` | 08-02 | **Phase 1.0b** — route the proxy path through `core/engine.optimize()` |

---

## 3. Phase 1.0a — stop asserting an unevaluated safety property

**Commit:** `ed4d141` · 3 files, +34 / −3

### Problem

Both proxy recording sites wrote `fallbackUsed: false` into every `SessionTurn`. Because
`src/adapters/mcp/index.ts` serializes `session.turns` verbatim, that literal reached MCP
clients as though it were a computed result. It claimed a safety property that had never
been checked.

### Change

- `SessionTurn.fallbackUsed` made **optional** (`src/gateway/types.ts`).
- The field is **omitted** at both proxy recording sites rather than set to `false`.
- Rationale: an absent field is honest ("not evaluated"); a `false` is not.

### Verification

Regression test added to `test/unit/gateway.test.ts` asserting the field is absent —
failing before the change, passing after.

### Deliberate non-goal

1.0a did **not** attempt to make the Gateway safe. It only stopped the codebase from
lying about it, and explicitly deferred the repair to 1.0b.

---

## 4. Interlude — CI repair (`aba84df`)

Not part of either phase, but it blocked them.

The precursor commit `4b11d7e` made the planner enter knapsack mode on
`targetReductionRatio`, fixing Issue 1 (budgets supplying only `--target-reduction-ratio`
silently resolved to `pass_through` with zero stages and guaranteed 0% reduction).

That fix had a known, documented consequence: the knapsack stages now genuinely execute
against the humaneval Python fixtures and trip the `S_k <= 0.40` drift threshold
(Issue 3). Five tests hard-asserting `fallbackRate === 0` on those fixtures began failing
across all three Node matrix jobs.

**Resolution:** updated the assertions in `test/integration/bench.test.ts`,
`test/unit/bench/m1_reverification.test.ts` and `test/unit/bench/runner.test.ts` to expect
the now-real 100% fallback rate on code content, each commented back to Issue 3. No
production logic changed.

---

## 5. Phase 1.0b — route the proxy through the engine

**Commit:** `61bd685` · 12 files, +435 / −87

### 5.1 Two landmines found during investigation

Both would have shipped silently if the change had been made naively.

**(a) It would have turned the Gateway into a no-op.**
`DEFAULT_CONFIG.budget` is `targetReductionRatio: 0` with no `maxInputTokens`
(`src/config/schema.ts:20`), so `plan()` returns `pass_through` with an **empty**
`stageIds`. Separately, `plan()` never listed `cleanup:session-dedup` at all. Routing
through `optimize()` as-is would have run **zero stages** and removed the Gateway's only
working feature.

**(b) Drift would have vetoed deduplication on exactly the payloads it helps most.**
Drift is `1 − (0.6·symbolRetention + 0.4·markerRetention)`, computed bundle-wide.
Replacing a message with `[TokenDamper Elided: ref=…]` drops every AST symbol that message
contributed, so the score scales with *how much* was deduplicated. A representative code
payload measured **`S_k = 0.60`** against the 0.40 threshold — a forced fallback.

### 5.2 Changes

| File | Change |
|---|---|
| `src/core/model/types.ts` | Added `'session_dedup'` to `OptimizationMode` (additive union member) |
| `src/core/planner/index.ts` | New `session_dedup` mode planning exactly `['cleanup:session-dedup']`, selected via `config.planner.defaultMode`, taking precedence over budget-derived knapsack |
| `src/stages/cleanup/session-dedup.ts` | Tags its elisions `recoverable: true` |
| `src/core/ledger/drift-tracker.ts` | `resolveRecoverableElisions()` substitutes pre-optimization content for recoverable items before scoring |
| `src/gateway/proxy.ts` | Builds an `OptimizationRequest` and calls `optimize()`; shared `runGatewayOptimization()` helper replaces duplicated stage-call blocks in both provider paths |
| `src/gateway/types.ts` | `fallbackUsed` comment updated — now a computed value |
| `test/unit/planner.test.ts` | `session_dedup` mode plans only the dedup stage, even with a knapsack-triggering budget |
| `test/unit/drift-tracker.test.ts` | Recoverable elision exempt; lossy elision still scored |
| `test/unit/gateway.test.ts` | Fail-open byte-identity test; code-payload dedup test; 1.0a test inverted to assert a computed `fallbackUsed` |
| `CHANGELOG.md`, `DECISIONS.md`, `CLAUDE.md` | Documentation (DECISIONS §16 records the drift rationale) |

### 5.3 Key design decisions

**Planner pinned to `session_dedup`.** Cross-turn deduplication is the only transform
currently safe for live provider payloads. `compression:token-hashing` writes bare
`<BLOCK_HASH:…>` markers into JSON-shaped message content (Issue 2), so broadening the
Gateway's stage list is gated behind content-type tagging. Pinning the mode also gave
`config.planner.defaultMode` — previously dead config — a real purpose.

**Drift exempts recoverable references, not lossy ones.** A dedup marker is a *pointer*:
the full text is retained in the session store under `originalContentHash` and is
restorable on demand. Nothing is irrecoverably lost, so nothing should be scored as loss.
The exemption keys on an **explicit `recoverable` flag**, deliberately not inferred from
`elided` or `originalContentHash` — `token-hashing` sets both and must stay fully scored.
Full rationale and alternatives considered in `DECISIONS.md` §16.

**Gateway uses `finalBundle`, never `emittedOutput`.** The fallback resolver renders a
bundle by joining item contents with newlines, which is not a valid provider API payload
(this is the mechanism behind Issue 5). Mapping `finalBundle` items positionally back onto
the parsed request preserves payload shape, and because the engine returns the *original*
bundle whenever fallback fires, the request body is reproduced byte-for-byte. The Gateway
therefore sidesteps Issue 5 structurally rather than by test enforcement.

**`ConfidenceLedger` is per-request, not session-scoped.** Confidence decays as
`initialConfidence × 0.9^(currentTurn − lastAccessedTurn)`. A persistent ledger would drop
earlier turns below `validation.minimumConfidence` (default `1`) and force a fallback on
every turn after the first. Cross-turn confidence decay needs its own threshold policy and
was deliberately excluded.

### 5.4 Verification

Behavior was probed against the built output **before** the tests were written, so the
assertions encode observed behavior rather than assumptions.

Gateway, two-turn sessions with repeated content:

| Scenario | `fallbackUsed` | Elided | Body byte-identical | Tokens saved |
|---|---|---|---|---|
| Plain prose | `false` | yes | no | 4 |
| Imperative constraint directive | **`true`** | no | **yes** | 0 |
| Symbol-dense code | `false` | yes | no | 8 |

Drift exemption, identical elision content:

| Elision type | `S_k` | Fallback |
|---|---|---|
| `session-dedup` (recoverable) | **0.00** | no |
| `token-hashing` (lossy) | **0.60** | **yes** |

The constraint-directive row is the guarantee that did not previously exist: validation
detects the dropped directive and the caller receives their original payload unchanged.
The drift table confirms the exemption is load-bearing — without it the code payload would
have fallen back — while lossy compression remains fully policed.

**Suite:** 283 tests passing (up from 279; +4 new). `typecheck`, `lint`, `build` all clean.

---

## 6. Net effect

- Invariants 3 and 5 now hold on **all three entry modes**, not just CLI and MCP.
- Invariant 4 restored for the Gateway — it no longer imports a concrete stage.
- `fallbackUsed` carries a genuinely computed value on the proxy path again.
- Gateway reduction behavior is **unchanged** on the happy path; the change adds a safety
  net rather than altering what gets compressed.
- `config.planner.defaultMode` is now functional instead of inert.

---

## 7. Known limitations after Phase 1

Carried forward deliberately, not oversights:

1. **Gateway runs one stage only.** Broadening to the knapsack set is gated on Issue 2
   (content-type tagging), which would otherwise corrupt JSON payloads in production.
2. **No cross-turn confidence decay** on the Gateway, for the `minimumConfidence` reason
   above.
3. **Issue 5 unfixed for CLI/MCP.** The Gateway avoids it structurally, but the shared
   fallback path still re-renders the bundle rather than echoing raw input bytes.
4. **Still a single global validate→fallback gate.** A failing stage discards all prior
   valid reductions; per-stage checkpointing remains outstanding.
5. **`npm run format` fails on 94 files** repo-wide. Pre-existing, and not part of the CI
   workflow (which runs typecheck → lint → build → test).

## 9. Addendum (2026-08-02) — measured cost of correcting the drift exemption

Commit B narrowed `recoverable: true` to elisions whose referent demonstrably survives in
the same outbound payload. Measured through the real Gateway proxy path, two turns per
session, `--mock-upstream`:

**Cross-turn dedup — sole copy, no surviving referent (what the Gateway did before):**

| Payload | Saved | Fallback |
|---|---|---|
| `tool_output.json` | 2,987 / 3,013 = **99.14%** | no |
| `codebase.py` | 0 / 4,238 = **0.00%** | **yes** |
| `sample_logs.txt` | 0 / 2,728 = **0.00%** | **yes** |

**Within-payload duplication — a copy is preserved (what still deduplicates):**

| Payload | Saved | Fallback |
|---|---|---|
| `tool_output.json` | 5,974 / 9,031 = **66.15%** | no |
| `codebase.py` | 8,434 / 12,707 = **66.37%** | no |
| `sample_logs.txt` | 5,413 / 8,176 = **66.21%** | no |

**Reading these honestly.** Code and logs went from ~99% "savings" to 0% and a fallback.
That is not a regression: the prior number depended on sending the model markers it had no
way to resolve, and the fallback is the system correctly declining a lossy transform it
cannot justify. The real number replaced an inflated one.

The `tool_output.json` cross-turn row still shows 99.14%, and that is **not** a sign the
exemption survives there — it is the §2.2 vacuity again. `contentType` is still hardcoded
`text` on that path, so `extractSymbols` harvests nothing from JSON and drift is 0.00 by not
looking. **Commit C (the relabel) is expected to flip that row to 0% and a fallback**, for
the same reason the Python row already does. It is listed here so the change is attributable
when it happens rather than read as a regression introduced by the relabel.

**What this means for the Gateway.** After Commit C, cross-turn deduplication will
effectively stop contributing on any symbol-bearing content, which is most realistic agent
traffic. Within-payload exact duplication does occur — repeated tool schemas, a file pasted
into several messages — but it is not the common shape of a conversation, where each message
appears once.

Said plainly: **the Gateway's near-term dedup value is likely close to zero.** That does not
make the Gateway pointless; it relocates its value to cache-aware prefix stability and to
the knapsack stages, which Issue 2 is the gate on. It does mean cross-turn deduplication
should not be cited as a headline capability until there is a mechanism that lets the model
resolve a marker — which, on a stateless provider API, there currently is not.

## 8. Outstanding work

> Replaces the former "Suggested next step" section, which named Issue 2. Issue 2 is now
> **done** (`29f66b3`, `e9ea50d`, `b11dcb0`, `642abcb`, `ac16cec`, `4335c31`) — though not
> at the seam it was specified at; see `NOTES-FOR-DOCS.md`. The §9 prediction about the
> `tool_output.json` row was confirmed on landing, also recorded there.

Everything below is **not started** as of `4335c31`, verified against source rather than
recalled. Phase 1 is not finished.

### 1b — byte-identical fallback (Issue 5)

`session.json` emits **−1.39%** on fallback: the output is *larger* than the input, because
the fallback path re-renders `currentBundle` by joining item contents with newlines instead
of echoing the original bytes.

The Gateway sidesteps this structurally — `src/gateway/proxy.ts` maps `result.finalBundle`
back onto the parsed payload and never touches `emittedOutput` — but that is a local
workaround on one path, not a fix. **The CLI and MCP paths still re-render.** The agreed
direction is to split fallback into raw passthrough (byte-identical echo, bypassing the
bundle render model) and bundle rendering (success path only), so byte-identity is
structural rather than test-enforced.

### 1c — per-stage checkpointing

Still a single global validate→fallback gate: one failing stage discards every prior valid
reduction. Cited twice as the reason elision refusal must skip an item and continue rather
than abort the stage (`docs/issue-2-content-type-contract-design.md` §3.4.1, and the
`elideItem` doc comment) — aborting today would convert a placeholder defect into a
whole-pipeline fallback.

**Design input discovered during Issue 2, and it complicates the premise.**
`src/core/validation/index.ts` runs `validateBundleAst(after)` over **every item in the
final bundle**, not only the items a stage changed. Per-stage checkpointing assumes a
validation failure can be attributed to the stage that caused it. Sometimes it cannot:

- A validation failure can originate in an item **no stage touched**. This is not
  hypothetical — it is exactly how the fenced-prose defect in `DECISIONS.md` §17 was found.
  With `contentType` newly computed, a message quoting a code snippet failed the TypeScript
  validator on **turn 1**, where `cleanup:session-dedup` has no previous block hashes and
  cannot elide anything. Nothing had been transformed, so no rollback could have fixed it.
- Two of the four checks in `validate()` are **bundle-scoped, not item-scoped**: constraint
  directive retention compares `before` against all `after` content joined, and
  `DriftTracker` computes `S_k` over whole-bundle symbol sets. Neither yields a per-stage or
  per-item attribution as written.

So "roll back only the failing stage" needs a prior answer to *which stage failed*, and for
a class of failures the honest answer is "none of them." A checkpointing design that assumes
attributability will silently roll back an innocent stage. Recommended first step is to
establish attribution — validate the delta a stage produced, not the whole bundle — before
building rollback on top of it. Recorded in `CLAUDE.md` as a gotcha as well, since that is
what gets read.

### 1d — drift threshold investigation

The brief: `codebase.py` aborts on `S_k = 0.60 > 0.40`; investigate what drives the score
and decide whether the threshold should be content-type-specific rather than shared across
prose, logs and code. **Not started** — no investigation of what drives the score exists,
and `DriftTracker` still has a single scalar `maxDriftThreshold` (default `0.40`,
`drift-tracker.ts:83`) with no content-type branching. `--max-drift` is the only override.

Three things are adjacent but are **not** 1d, and should not be counted as it:
`tokendamper-headroom-known-issues.md` Issue 3 states the problem and then *retracts* its
main supporting evidence (Headroom did not independently choose `router:noop`; it hit a
20-second backend timeout); `aba84df` changed tests to tolerate the abort rather than
investigate it; and `DECISIONS.md` §16 rejected a *path*-specific threshold for a different
problem. `docs/issue-2-content-type-contract-design.md` §4 explicitly puts threshold changes
out of scope.

**Anything measured for 1d before now must be re-measured.** `b11dcb0` narrowed the drift
exemption and `ac16cec` made `DriftTracker` see JSON as JSON for the first time, so drift
does not behave as it did when 1d was written.

One observation that fell out of the bench run for `4335c31`, offered as a starting point
rather than as analysis: at `targetReductionRatio: 0.30`, **nine of the ten bundled bench
fixtures fall back at exactly `S_k = 0.60`** — Python, TypeScript and JavaScript alike. That
value is what `1 - (0.60 × R_AST + 0.40 × R_struct)` yields when `R_AST = 0` and
`R_struct = 1`, i.e. total AST-symbol loss with structural markers fully intact. The
constant recurrence across languages suggests the score is being driven by one mechanism,
not by per-fixture content.

### Phase 2 — security audit

Not started.
