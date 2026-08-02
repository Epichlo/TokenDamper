# CLAUDE.md — TokenDamper

Context file for Claude Code. Read this before touching the codebase.

## What this is

TokenDamper is a **deterministic context optimization engine** for AI coding assistants
(Claude Code, Codex, Gemini CLI, Aider). TypeScript, CommonJS, Node >=18, MIT.
It sits between a developer tool and an LLM provider API and reduces token count while
preserving syntax validity and provider prompt-cache alignment.

Three entry modes: **CLI**, **local Gateway HTTP proxy**, **MCP server (stdio)**.

The differentiator vs. LLMLingua/Headroom/summarizers is *determinism + syntactic
guarantees + fail-open fallback* — not the raw reduction percentage. Any change that
weakens determinism or the fallback guarantee defeats the point of the project.

## Commands

```bash
npm run build       # tsc -p tsconfig.json
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src test
npm run format      # prettier --check .
npm test            # vitest run
npm run test:watch  # vitest
```

Run the CLI: `node dist/src/cli/main.js` (or `npm start`), bin name `tokendamper`.

```
tokendamper optimize <input-file|->
tokendamper bench [dataset-path]
tokendamper exec -- <command>
tokendamper mcp
```

Key `optimize` flags: `--max-input-tokens`, `--max-output-tokens`,
`--target-reduction-ratio`, `--max-latency-ms`, `--risk-tolerance`, `--preserve-kinds`,
`--max-debt`, `--max-drift`, `--planner-mode`, `--minimum-confidence`, `--trace-output`,
`--diff`, `--diff-html <path>`, `--report-json <path>`, `--config <path>`, `--quiet`.

**Critical:** with no budget flag, the planner returns `pass_through` with an empty
`stageIds` array — zero stages run and reduction is guaranteed 0%. This is not a bug;
it has repeatedly been mistaken for one (see benchmark Issue 1). Always pass a budget
when testing reduction.

Config file: `tokendamper.config.json` (not `.tokendamperrc`).

## Architecture

Linear pipeline. **No DAG.** The architecture is frozen — `ARCHITECTURE.md` describes
what must be implemented, not what should be redesigned.

```
Raw Input
  -> Adapter (CLI / Gateway / MCP)
  -> OptimizationRequest -> ContextBundle + OptimizationBudget
  -> Stateless 0/1 Knapsack Planner
  -> Linear Engine (stages in order)
  -> Validators (ConfidenceLedger, DebtTracker, DriftTracker)
  -> Fallback if unsafe
  -> Output + explainability trace (stderr / JSON)
```

| Path | Role |
|---|---|
| `src/core/model/` | Frozen immutable domain model. Source of truth. |
| `src/core/planner/` | `index.ts` (mode selection), `knapsack.ts` (0/1 solver, DP + greedy), `cache-aware.ts` (1,024-token block quantization) |
| `src/core/engine/` | Orchestration: plan → stages → validate → fallback → trace |
| `src/core/stage-registry/` | Only module allowed to import concrete stages |
| `src/core/validation/` | Validators + AST-lite validators under `validation/ast/` (ts, python, json) |
| `src/core/fallback/` | Fallback-to-raw path |
| `src/core/hashing/` | `TokenHasher` (`<BLOCK_HASH:sha256>` placeholders), tokenizer |
| `src/core/ledger/` | `ConfidenceLedger`, `DebtTracker` (D_k), `DriftTracker` (S_k) |
| `src/core/topology/` | `git-inspector.ts`, `dependency-graph.ts`, `topology-scorer.ts` |
| `src/stages/` | `cleanup/session-dedup`, `cleanup/constraint-preservation`, `pruning/topology-pruner`, `compression/token-hashing`, `compression/delta-compression` |
| `src/adapters/mcp/` | stdio JSON-RPC 2.0 server + `tools.ts` (`TOOL_DEFINITIONS`) |
| `src/gateway/` | Local proxy (`server.ts`, `proxy.ts`, `session-store.ts`, `exec.ts`) |
| `src/bench/` | Benchmark harness, fixtures, `evaluator.ts` (has `computeTokenSimilarity`) |
| `tokendamper-benchmark/` | Python harness comparing TokenDamper vs. Headroom |

Knapsack-mode stage order (from `src/core/planner/index.ts`):
`cleanup:constraint-preservation` → `pruning:topology-pruner` →
`compression:token-hashing` → `compression:delta-compression`.
Note `cleanup:session-dedup` is in the registry catalog but **not** in this list — it never
runs via the CLI or MCP paths (both call `core/engine.optimize()`, which only executes
`plan.stageIds`). It runs only under the `session_dedup` planner mode, which the Gateway
pins via `config.planner.defaultMode`; that mode plans exactly `['cleanup:session-dedup']`
and takes precedence over budget-derived knapsack selection.

MCP tools: `optimize_context`, `rehydrate_context`, `get_session_metrics`,
`get_optimization_trace`. Resources: `tokendamper://config`,
`tokendamper://session/{sessionId}`.

## Invariants — do not break these

1. **Stages are pure, deterministic, side-effect free.** Same input → same bytes out.
2. **Validators must not mutate the bundle.**
3. **Fallback means the user gets usable output, never a crash** (fail-open).
4. **Only `stage-registry` imports concrete stage implementations.**
5. **Drift threshold `S_k <= 0.40`** triggers `SEMANTIC_DRIFT_EXCEEDED` and fallback
   (`src/core/validation/index.ts`, override via `--max-drift`).
6. **Cache alignment:** selection preserves pinned-prefix ordering and 1,024-token block
   boundaries. Reordering the prefix busts provider prompt caches, which usually costs
   more than the tokens saved.
7. **Pinned items (`isPinned`) bypass the knapsack and are always included.**
8. **The Gateway plans exactly one stage (`cleanup:session-dedup`) on purpose** — it is
   Issue 2 containment, not an unfinished implementation; do not widen that stage list.
9. **The Gateway maps `finalBundle` back onto the parsed payload, never `emittedOutput`** —
   `emittedOutput` is a newline-joined blob, and using it reintroduces Issue 5.
10. **When a check passes, confirm it ran.** A green result from a check that never executed
    is worse than a red one — it has happened four times in this project already.

## Known bugs — highest-priority work

Full detail in `tokendamper-headroom-known-issues.md`; proposed fixes in
`purposed architecture changes.md`. Summary:

- **~~Gateway bypasses validation entirely~~ — FIXED (Phase 1.0b).** `src/gateway/proxy.ts`
  now routes through `core/engine.optimize()`, so validators, `DriftTracker`,
  `ConfidenceLedger`, `DebtTracker` and the fallback resolver all run on proxy traffic and
  `fallbackUsed` is a computed value. Invariants 3 and 5 now hold on all three entry modes.
  The Gateway pins the planner to `session_dedup` mode, so `cleanup:session-dedup` is still
  the only stage that runs on live traffic — deliberately, because `token-hashing` would hit
  Issue 2 on JSON payloads. Two constraints to know before changing this path: the Gateway
  maps `result.finalBundle` items back onto the parsed payload and must **not** use
  `emittedOutput` (the fallback resolver renders a newline-joined blob, not a valid API
  payload); and it passes a **per-request** `ConfidenceLedger`, because a session-scoped one
  decays earlier turns below `validation.minimumConfidence` (default 1) and would force a
  fallback on every turn after the first.
- **~~Issue 2: eliding stages corrupt JSON content~~ — FIXED (Commits 29f66b3, e9ea50d,
  b11dcb0, 642abcb, Commit C).** All three eliding stages now route through
  `core/elision.elideItem`, which resolves the syntax from the same `selectValidator` the
  checker uses and renders the marker validly for it — JSON elisions become
  `{"__td_block__":"<marker>"}`, and `TokenHasher.rehydrateText` unwraps them. The Gateway
  no longer hardcodes `contentType: 'text'`; message content is classified, so
  `selectValidator` and `DriftTracker.extractSymbols` finally see JSON as JSON.
  Two things to know before building on this:
  - The load-bearing mechanism is **correct-by-construction rendering**, not the
    post-condition check. Only `JsonValidator` rejects a bare placeholder; the TS and
    Python AST-lite validators accept it, so `post_condition_rejected` is unreachable
    today. Placeholder injection into TS/Python content is caught only by drift.
  - This did **not** make `token-hashing` safe to run on the Gateway. It is lossy, sets no
    `recoverable` flag, and measures `S_k = 0.60` on JSON — so it now fails the drift gate
    instead of the AST gate. Invariant 8 still stands.
- **Issue 5:** on fallback, `session.json` emits **-1.39%** — output is *larger* than
  input. Fallback re-renders `currentBundle` instead of echoing raw input bytes.
- **Issue 3 / Phase 1d — investigated 2026-08-03, threshold unchanged, remedy undesigned.**
  Full record: `docs/phase-1d-drift-investigation.md`. **The threshold is not the defect;
  do not tune it.**
  - `S_k = 0.60` is a **formula constant** — `w_AST` exactly — produced whenever
    `R_AST = 0` and `R_struct = 1`. It is not a measurement of how much was lost, and it is
    the **ceiling** for code, not a midpoint.
  - `extractSymbols` returns empty on the optimized side **correctly**: `token-hashing`
    replaces the item's whole content with a 77-byte placeholder. No validator is involved
    in extraction — it is regex over `item.content`, identical under all five contentType
    tags. Only the `jsonkey:` branch reads the tag.
  - Cause is **granularity**: `token-hashing` is whole-item and `createContextBundle` makes
    a single-item bundle for CLI/bench, so `R_AST` is a boolean. A single-item code bundle
    with ≥1 symbol can never pass. (Symbol-free files pass trivially — `R_AST` defaults to
    1.0 when `symbolsBefore` is empty.)
  - For code, `R_struct` is pinned at 1.0 — the only marker is `filepath:`, from
    `item.path`, which elision never touches. 40% of the metric does no work. DECISIONS §18.
  - The old "Headroom independently chose `router:noop`, so this is probably correct" claim
    is **retracted** — on re-run Headroom hit a 20-second backend timeout and failed open.
    Same 0%, different mechanism. Do not cite it as corroboration.
- **Issue 4 (not a bug):** constraint-preservation correctly refused to drop a planted
  imperative-tagged line in `sample_logs.txt`. `BLUE-PANDA-992` is a synthetic test
  string, not a credential.

Issues 2 and 5 are the same class of failure: a **round-trip invariant violation**.
The agreed direction is three scoped changes (no rewrite):

1. ~~Content-type becomes a first-class tag on `ContextBundle`.~~ **Done, but not at that
   seam.** The tag belongs on `ContextItem`, where it already existed — `selectValidator`
   dispatches per item, so a bundle-level tag would key the transform and the check at
   different granularities, reproducing Issue 2's shape while appearing to fix it. Bundles
   are heterogeneous (a 12 KB JSON tool result next to a one-line question), and
   `statistics.contentTypeCounts` is already the bundle-level view. See `NOTES-FOR-DOCS.md`.
   The planner-level gate (§3.6 of the design doc) is still **not** implemented: nothing in
   `src/core/planner/` reads `contentType`.
2. Per-stage checkpointing replacing the single global validate→fallback gate (**Phase 1c,
   not started**) — roll back only the failing stage, keep prior valid reductions. Requires
   extending the trace with per-stage status. **Read this before designing it:** the plan
   assumes a validation failure is attributable to a stage, and sometimes it is not.
   `validate()` runs `validateBundleAst` over *every* item in the final bundle, so a failure
   can originate in an item no stage touched (that is how DECISIONS.md §17 was found, on
   turn 1 with nothing transformed). Constraint retention and drift are also bundle-scoped
   set comparisons with no per-stage attribution. Establish attribution first. See
   `NOTES-FOR-DOCS.md` and `docs/phase-1-stabilization-summary.md` §8.
3. Split fallback into **raw passthrough** (byte-identical echo, bypasses the bundle
   render model) vs. **bundle rendering** (success path only). Make byte-identity
   structural, not test-enforced. (**Phase 1b / Issue 5, not started.** The Gateway
   sidesteps it structurally via `finalBundle`; CLI and MCP still re-render.)

Do this before roadmap feature work. `tokendamper-roadmap-v1.1-v2.0.md` schedules BM25
scoring, MMR, AST folding and Prometheus metrics on top of a pipeline that currently
0%-fails on structured payloads.

## Conventions

- TypeScript strict, CommonJS output to `dist/`. Prettier + ESLint enforced in CI
  (`.github/workflows/ci.yml`).
- Tests: vitest, under `test/unit/` and `test/integration/`. There is a property/fuzz
  suite (`test/unit/fuzz-diff-debt.test.ts`) and stress tests
  (`knapsack-stress`, `m2_stress`, `bench-table-stress`) — extend these rather than
  adding parallel harnesses.
- Every behavioral change should be reflected in `CHANGELOG.md`; architectural decisions
  go in `DECISIONS.md`.

## Gotchas

- `DriftTracker` exempts elisions tagged `recoverable: true` by substituting their
  pre-optimization content before scoring. `cleanup:session-dedup` sets that flag **only
  when an intact copy of the content survives elsewhere in the same outbound payload** — it
  preserves the first occurrence and elides the copies after it. A sole copy is still
  elided but carries `recoverable: false` and is scored in full. The earlier rationale
  ("the session store can restore it, so the marker is a pointer") does **not** hold on the
  Gateway path: the consumer is a stateless provider API with no rehydration mechanism, so
  elided content is deleted, not referenced. Do not infer the exemption from `elided` or
  `originalContentHash`; `token-hashing` sets both and must stay fully scored.
  See DECISIONS.md §16 and the §16 entry in `NOTES-FOR-DOCS.md`.
- **Classification has a blast radius over items no stage touched.** `validate()` runs
  `validateBundleAst` over *every* item in the final bundle, so changing what
  `classifyContent` returns can fail an item nothing transformed. To see it, measure
  **turn 1** of a Gateway session: `cleanup:session-dedup` has no previous block hashes
  there and cannot elide anything, so any fallback is a false positive by construction.
  That is how the fenced-prose defect in DECISIONS.md §17 was found.
- `package.json` and `src/version.ts` say **1.1.0**, but the roadmap treats **v1.0.3** as
  the baseline. Reconcile before cutting a release; don't assume either is right.
- `configSchemaVersion` **already exists** in `src/config/types.ts`, despite the roadmap
  listing it as a v1.1.0 item to add.
- Token counting is currently `content.length / 4`. It is an estimate, not exact. Anything
  needing precise token boundaries (e.g. `cache_control` placement) cannot be exact until
  a real tokenizer adapter lands.
- Benchmark latency numbers are **not** apples-to-apples: TokenDamper is timed through a
  Node process spawn via `subprocess.run()`, Headroom via an in-process Python call.
- Headroom's `target_ratio` is a soft hint, not an enforced budget — don't compare
  target-adherence naively.
- Several items in the roadmap's Phase 1 were already fixed in the codebase (fallback
  output bug, unbounded `traceStore`, missing SIGINT/SIGTERM, gateway body-size cap).
  Verify against source before implementing anything from a planning doc.

## Reference docs in repo

`ARCHITECTURE.md` (canonical, frozen) · `ROADMAP.md` · `DECISIONS.md` · `CHANGELOG.md` ·
`docs/architecture/milestone_*.md` · `docs/v1_deployment_audit.md` ·
`tokendamper-benchmark/BENCHMARK_RESULTS.md`
