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
- **Issue 2 (blocker):** `compression:token-hashing` writes bare `<BLOCK_HASH:...>` into
  JSON content; the downstream JSON/AST validator then correctly rejects it and the whole
  pipeline falls back. This 0%-fails on **any** JSON-shaped payload. The stage has no
  content-type awareness.
- **Issue 5:** on fallback, `session.json` emits **-1.39%** — output is *larger* than
  input. Fallback re-renders `currentBundle` instead of echoing raw input bytes.
- **Issue 3 (probably correct behavior):** drift 0.60 > 0.40 aborts on `codebase.py`.
  Headroom independently chose `router:noop` on the same file. Confirm intent before
  "fixing"; may want a code-specific threshold rather than one shared with prose/logs.
- **Issue 4 (not a bug):** constraint-preservation correctly refused to drop a planted
  imperative-tagged line in `sample_logs.txt`. `BLUE-PANDA-992` is a synthetic test
  string, not a credential.

Issues 2 and 5 are the same class of failure: a **round-trip invariant violation**.
The agreed direction is three scoped changes (no rewrite):

1. Content-type (`json` / `code` / `prose` / `logs`) becomes a first-class tag on
   `ContextBundle`, set at ingestion and consulted by the planner *before* transforms run.
2. Per-stage checkpointing replacing the single global validate→fallback gate — roll back
   only the failing stage, keep prior valid reductions. Requires extending the trace with
   per-stage status.
3. Split fallback into **raw passthrough** (byte-identical echo, bypasses the bundle
   render model) vs. **bundle rendering** (success path only). Make byte-identity
   structural, not test-enforced.

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

- `DriftTracker` exempts elisions tagged `recoverable: true` (currently only
  `cleanup:session-dedup`) by substituting their pre-optimization content before scoring —
  a dedup marker is a reference to text still in the session store, not semantic loss. Do
  not infer the exemption from `elided` or `originalContentHash`; `token-hashing` sets both
  and must stay fully scored. See DECISIONS.md §16.
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
