# Phase 1 Stabilization — Summary Report

> ## ⚠️ Point-in-time record — not a live specification
>
> This document records the state of Phase 1.0 **as of 2026-08-02**, at commit `61bd685`.
> It is a historical account of what was done and why. It is **not** a description of
> current behavior and it is **not** a spec to implement against.
>
> Planning docs in this repo have twice been mistaken for current state after going stale.
> Before relying on any statement here, verify it against the source. Where this document
> and the code disagree, **the code is right and this document is out of date.**
>
> The load-bearing decisions from this report are duplicated into `CLAUDE.md` (invariants)
> and into comments at the relevant call sites, because those are read and this is not.

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

## 8. Suggested next step

**Issue 2 — content-type as a first-class `ContextBundle` tag**, set at ingestion and
consulted by the planner before transforms run. It is the gate on both the Gateway's stage
scope (limitation 1) and the roadmap feature work scheduled on top of a pipeline that
currently 0%-fails on structured payloads.
