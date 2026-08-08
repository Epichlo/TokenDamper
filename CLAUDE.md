# CLAUDE.md — TokenDamper

Context file for Claude Code. Read this before touching the codebase.

## What this is

TokenDamper is a **deterministic context optimization engine** for AI coding assistants
(Claude Code, Codex, Gemini CLI, Aider). TypeScript, CommonJS, Node >=20.19, MIT.
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
`--diff`, `--diff-html <path>`, `--report-json <path>`, `--config <path>`, `--quiet`,
`--language <name>`, `--input-name <name>`.

**Flags are command-scoped and enforced (DECISIONS §30).** `SUPPORTED_FLAGS` in
`src/cli/main.ts` is keyed by what `runCli` actually consumes; anything else is a parse error
naming where it does apply. `bench` takes the config/budget flags plus `--report-json` and
`--quiet`; `mcp` takes the config/budget flags (it silently took **none** before — its branch
read `parsed.configPath` and the parser never set it); `exec` forwards everything to the child.

**Second critical flag, for stdin:** `--language`. Without it a piped payload has no filename,
classification falls to content probes, no validator covers the item and reduction is ~0%
(0.07% on this repo's TypeScript vs 19.27% with it, cl100k, DECISIONS §29). `--input-name`
declares a filename instead and is equivalent. Pathless MCP calls take `language`/`path` on
`optimize_context`. Unrecognized names are rejected, never ignored.

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
    is worse than a red one — it has happened **nine** times in this project already. Read
    `AstValidatorResult.validated` and `trace.astCoverage`, not `valid`, when the question is
    whether anything looked (DECISIONS §23). The same now applies to drift: read
    `trace.driftCoverage` (`measured`, `astMeasured`, `unwitnessedItems`), **not `driftScore`**
    — `0.0000` means "retained everything" and "found nothing to look at" indistinguishably.
    The ninth and tenth instances are **both closed by Phase A** (DECISIONS §33 and §34), and
    it took both halves — read this if you are tempted to revert either.
    - **§33 — the measurement gate no longer asks whether a validator was watching.** Any item
      that changed, was not pruned away, and yields neither symbols nor content markers is
      refused. §28 had scoped that rule to validator-covered items to protect prose; measured,
      the scope protected the wrong population. All 25 real markdown documents carry content
      markers and were never in reach of it, while what it excluded was uncovered **code** —
      `Unicode_Collate_Locale_ja.pl` at **57,037 → 19 tokens (100%)** on the *file-argument*
      route, `S_k = 0`, `measured: false`, `fallbackUsed: false`, because nothing covers `.pl`.
      `DriftReport` now carries `measurementGate` and `retentionGate` separately, so `0.400`
      stops being one comparison arbitrating two opposite configurations.
    - **§34 — a bare `#` line no longer makes a document.** That is what closed §32's
      "the coverage report itself is the thing that lies": `tclConfig.sh`'s 79 "headings" were
      all `#` shell comments, and they **forged the very evidence §33 checks**. Shell over stdin
      was byte-identical under §33 alone. §34 without §33 would merely have moved those files
      from the forged failure to the honest one. A *shape* discriminator (not the count
      threshold §32 imagined — counts point the wrong way) takes code misclassified as markdown
      from **114 of 264 files to 12** with **zero** prose casualties.
    - **Measured end state:** every uncovered-language bucket goes to **0.00%** reduction, and
      **258 of 258** rows in the AST-covered and prose buckets are **byte-identical** to
      baseline. `docs/phase-0-measurement-baseline.md`, DECISIONS §33–§34.
    - **The Gateway keeps within-payload dedup and loses cross-turn sole-copy dedup.**
      `resolveRecoverableElisions` substitutes recoverable elisions back before the gate runs,
      so they are structurally invisible to it. The lost case is the one §9 of
      `docs/phase-1-stabilization-summary.md` already called a marker the model cannot resolve.
    - **Still open:** a symbol-free code file the **pruner** removes is invisible to drift (the
      `!after` branch is a deliberate exemption — selection is not elision); and
      `isCodeExtension` remains a hardcoded 19-entry list that decides whether a real source
      file is validated at all. `.pl`, `.tcl`, `.rb`, `.lua`, `.swift`, `.kt` are outside it.
      What changed is that falling outside it now yields a **refusal** rather than a silent
      deletion.
    Historical, and still worth knowing: Phase 4b.1 (§29) established that "validator-covered"
    was itself route-dependent — the same barrel file was deleted unwitnessed over stdin because
    nothing covers a pathless item. §33 makes coverage irrelevant to the refusal, so both routes
    now behave the same; what a declaration still buys is *coverage*, not the refusal.

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
  Three things to know before building on this:
  - **The classification half of this fix was partial, and this entry used to overstate it.**
    It closed JSON. It did not close code: `classifyContent` answered `html` for TypeScript
    (46 of this repo's 57 sources), `selectValidator` has no `html` branch, and a pathless
    item — the Gateway shape — therefore got **no validator at all**, returning
    `valid: true, issues: 0` on a file with an unterminated string literal. That is the same
    vacuity Phase 1a is recorded as having closed, arriving by a different route. Fixed in
    Phase 1.5: DECISIONS §22 (the classifier) and §23 (an unvalidated item now reports
    `validated: false` and shows on `trace.astCoverage` instead of reading as a pass).
    Pathless code is closed for **Python** and for anything **declared**. Phase 4b.1
    (DECISIONS §29) added `--language` / `--input-name` and the MCP `language` / `path`
    properties; Phase 4b.2 (§31) added a Python content probe that sets `contentType` and
    `language` together and **only claims content `PythonValidator` already accepts**, so a
    detection can never make an item less valid than leaving it alone. Undeclared, undetected
    pathless code — every non-Python language over stdin, the Gateway and MCP — is still
    unchecked and still visible on `trace.astCoverage`. There is deliberately **no TypeScript
    probe**: §4 measured TS positives (0.283–1.000) overlapping prose negatives (to 0.333),
    because this repo's prose is documentation *about* TypeScript. `--language` is what TS
    over stdin gets.
  - The load-bearing mechanism is **correct-by-construction rendering**, not the
    post-condition check. Only `JsonValidator` rejects a bare placeholder; the TS and
    Python AST-lite validators accept it, so `post_condition_rejected` is unreachable
    today. Placeholder injection into TS/Python content is caught only by drift.
  - This did **not** make `token-hashing` safe to run on the Gateway. It is lossy, sets no
    `recoverable` flag, and measures `S_k = 0.60` on JSON — so it now fails the drift gate
    instead of the AST gate. Invariant 8 still stands.
- **Issue 5 — the premise is wrong; Phase 1b needs re-deriving.** The claim was: *"on
  fallback, `session.json` emits -1.39% — output is larger than input, because fallback
  re-renders `currentBundle` instead of echoing raw input bytes."* Measured 2026-08-03,
  both halves fail.
  - `src/core/fallback/index.ts` returns `output: request.rawInput` when
    `shouldFallback` — fallback **already** echoes raw bytes. All four
    `tokendamper-benchmark/test_data` payloads fall back through the CLI and emit
    byte-identical output. It is the **success** branch that re-renders
    (`items.join('\n')`).
  - The **-1.39%** is a benchmark-harness artifact. `run_benchmark.py:75-77` special-cases
    session payloads and sets `orig_tokens = count_tokens(json.dumps(messages))`, a
    re-serialization that drops the file's pretty-printing (15,785 chars) while TokenDamper
    is handed and echoes back the raw file (16,131 chars). Reproduces to two decimals.
  A case for splitting fallback may still exist — the success path's newline join is lossy
  for multi-item bundles, which is why the Gateway must map `finalBundle` positionally
  (invariant 9) — but it is a **different defect with different evidence**. Do not scope
  Phase 1b from the -1.39%. See `NOTES-FOR-DOCS.md`.
  **Phase B settled both halves (DECISIONS §35).** The live one was neither: `rawInput` is a
  *decoded string*, so `readFileSync(path, 'utf8')` turned invalid bytes into U+FFFD before any
  stage ran and the fallback echo could not restore them — a Latin-1 `vimspell.sh` came back
  **1,462 → 1,466 bytes with `fallbackUsed: true`**. The CLI now keeps the `Buffer`, writes it
  on fallback, and forces a fallback when input fails a UTF-8 round-trip. Fallback
  byte-identity went **502/504 → 504/504**. The newline join turned out to have **no live
  consumer** — CLI, MCP and bench are all single-item via `createContextBundle`, and the
  Gateway bypasses `emittedOutput` — so it is pinned by `test/unit/fallback-render.test.ts`
  rather than fixed.
- **Issue 3 / Phase 1d — investigated 2026-08-03, threshold unchanged, remedy undesigned.**
  Full record: `docs/phase-1d-drift-investigation.md`; read §10 and §12 before citing any
  benchmark number from it. **The threshold is not the defect; do not tune it.**
  - Bench reality at `targetReductionRatio: 0.30`: `avgReduction` **0.00%**,
    `fallbackRate` 0.40, all ten fixtures byte-identical. The 7.82% that briefly appeared
    was the estimator mismatch, not a saving (§12, DECISIONS §19).
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
  - **The semantic gate was investigated 2026-08-04 and precondition (a) is disposed of:
    `docs/phase-1d-semantic-gate-disposition.md`. Nothing implemented.** §18's proposed
    markers for code (brace balance, function/class boundaries, imports) are measured to be
    near-constants under the shipped selector — it preserves them by construction — so they
    would replace one decorative constant with four. Only comments and docstrings vary.
    Three findings to carry: `HumanEval/0` is **already caught** (`selectElisionRegions`
    returns `[]`, `S_k` pins at 0.60, input echoed) so stop citing it as the live hole;
    `R_AST` and `R_struct` **default to 1.0 when the *before* set is empty**, which scored
    "nothing to measure" as "perfect retention" and let `src/index.ts` be deleted whole at
    86.15% with `S_k = 0.0000` — **fixed 2026-08-05, DECISIONS §28**, for validator-covered
    items only; prose and pruner-removed items are still unwitnessed, now reported on
    `trace.driftCoverage` rather than enforced; and on real Python **86% of
    elided function bodies contribute no symbols**, so the drift gate is nearly inert there
    and it is `cleanup:constraint-preservation` that catches docstring loss — only when the
    prose is phrased as an imperative.
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
3. ~~Split fallback into **raw passthrough** vs. **bundle rendering**.~~ **DONE (Phase B,
   DECISIONS §35)** — though the live defect was not the one this item names. The fallback
   branch already returned `request.rawInput`; what made that *not* byte-identical was that
   `rawInput` is a decoded string, so non-UTF-8 input was corrupted at read time. The CLI now
   keeps the `Buffer` and writes it on fallback, and input failing a UTF-8 round-trip forces a
   fallback through the engine (`EngineOptimizationOptions.inputNotRepresentable`) — through
   the engine, because an adapter that returns early emits no trace, which is indistinguishable
   from a crash. Byte-identity **502/504 → 504/504**. The success-path newline join has no live
   consumer and is pinned, not fixed; see §35's last two sections before changing it.

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
- **This repo is its own corpus. Freeze it before measuring, or the measurement moves under
  you.** Every reduction figure in this project is measured over `src/**/*.ts` and the
  repository's own `*.py` — the same files a session edits while it works. A re-run after
  three commits is not a re-run: a previous session read movement as a behavioral change when
  it was reading its own edits. **Copy the corpus to a scratch directory, record the commit
  and a `sha256sum` manifest, and point the CLI at the copy.** `tools/corpus-harness/` does
  exactly this — `collect.js` freezes and pins (commit, `dist` hash, `dirty` flag), `measure.js`
  re-verifies every hash and runs both routes, and both assert their counts. Use it rather than
  hand-rolling the loop; the hand-rolled ones have been wrong twice (the repo moving mid-run,
  and a 4b.3 glob that silently measured 132 of 144 files). Then vary only the engine —
  patch `dist/` and restore it — never the input. Two corollaries that have both bitten:
  a paired comparison must be made over the files that reduce under *every* variant (a variant
  that converts fallbacks into reductions changes the denominator and can make a strictly
  worse rule look better on the mean); and the corpus is ~94% TypeScript, which is not a
  neutral sample for anything language-dependent — a docstring rule that costs 0.45pp here
  costs 6.8pp on real Python (`docs/phase-1d-semantic-gate-disposition.md` §2).
- **Classification has a blast radius over items no stage touched.** `validate()` runs
  `validateBundleAst` over *every* item in the final bundle, so changing what
  `classifyContent` returns can fail an item nothing transformed. To see it, measure
  **turn 1** of a Gateway session: `cleanup:session-dedup` has no previous block hashes
  there and cannot elide anything, so any fallback is a false positive by construction.
  That is how the fenced-prose defect in DECISIONS.md §17 was found.
- **Version is reconciled at 1.1.0 — closed 2026-08-04, stop re-listing it.** `src/version.ts`
  is the single source (`TOKENDAMPER_VERSION = '1.1.0'`); `package.json`, `CLI_ADAPTER_VERSION`,
  `MCP_ADAPTER_VERSION`, `SERVER_VERSION` and `config.appVersion` all derive from it, and the
  `v1.1.0` tag exists. ROADMAP.md:6 already carries its own correction retracting the v1.0.3
  baseline. There was never a code discrepancy — only this note outliving the fix, which put it
  on every status list for weeks.
- `configSchemaVersion` **already exists** in `src/config/types.ts`, despite the roadmap
  listing it as a v1.1.0 item to add.
- **Token counting goes through exactly one place: `estimateTokens` /
  `estimateBundleTokens` in `src/core/hashing/tokenizer.ts`.** `countTokens` is called from
  nowhere else, and there is no inline `ceil(len / 4)` left. Do not add a second estimator —
  until `1b1e999` there were two (tokenizer on a bundle's input side, `ceil(len / 4)` on
  every output side) and every reduction ratio compared one against the other, so
  byte-identical output reported an 11–22% saving. DECISIONS.md §19;
  `test/unit/token-estimator-unity.test.ts` guards it.
- The default estimator is `EnhancedHeuristicTokenizer`, and it is **not** the more accurate
  one. Scored against real `cl100k_base`, it has 24% mean absolute error against
  `ceil(len / 4)`'s 17%. It is the default because `TokenizerAdapter` is the seam a real BPE
  tokenizer plugs into and the planner already denominates cache blocks in adapter units.
  Anything needing exact token boundaries (e.g. `cache_control` placement) still cannot be
  exact until `createTiktokenAdapter` is wired to a real encoder — which is now a one-line
  change to `DEFAULT_TOKENIZER`.
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
