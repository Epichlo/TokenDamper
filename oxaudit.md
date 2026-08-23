# TokenDamper — Critical Codebase Audit (`oxaudit.md`)

- **Audit date:** 2026-08-23
- **Audited tree:** working directory at commit `79aedef` ("feat(validation): a Go AST-lite validator…"), clean `git status`
- **Package version:** 1.6.0 (`package.json:3`, `src/version.ts:1`)
- **Auditor:** ox-alpha (independent full-source review; no code was modified)
- **Scope:** every file under `src/` (76 TS files), config/build surfaces (`package.json`, `tsconfig.json`, `eslint.config.mjs`, `.npmrc`, `.github/workflows/ci.yml`), docs (`README.md`, `ARCHITECTURE.md`, and cross-referenced DECISIONS sections), test layout, and repo hygiene.

## How to use this document

This file is written so another agent can act on it without re-deriving context. Each finding has:

- a stable ID (`OX-H*` high, `OX-M*` medium, `OX-L*` low/notes),
- exact file:line references into the current tree,
- the mechanism, why it matters, how to reproduce/verify, and
- constraints from the project's own decision records (DECISIONS §, invariants) that any fix must respect — this repo's history shows fixes that ignore those constraints get re-litigated.

Verification commands actually run during this audit (all passing):

```
npm run typecheck   # tsc -p tsconfig.json --noEmit  → clean
npm run lint        # eslint src test                → clean
npm test            # vitest run                     → 155 files / 1410 tests passed (~19s)
```

Note on the test count: it is inflated by duplicate suites from an untracked worktree copy — see OX-H3 before trusting coverage numbers or CI parity.

---

## 0. Executive summary

TokenDamper is in unusually good shape for its stated guarantees. The fail-open discipline is real, byte-fidelity is enforced structurally rather than by tests alone, and the codebase documents its own known defects with rare honesty (the README Gateway notice, the `[retired]` markers, `max_audit.md`). Typecheck, lint, and the full suite are green.

That said, this audit found:

| ID | Severity | One-line summary |
|---|---|---|
| OX-H1 | High | `tokendamper exec` always exits 0 — child exit code is computed then discarded |
| OX-H2 | High | Gateway hard-aborts at 30 s wall-clock, killing streaming LLM responses mid-generation |
| OX-H3 | High | No vitest config → duplicate test suites execute from untracked `.claude/worktrees/` copy |
| OX-H4 | High | OpenAI messages with `content: null` (tool-call turns) silently defeat the raw-body splice, zeroing Gateway savings per request |
| OX-H5 | High | `--trace-output` / `TOKENDAMPER_TRACE_OUTPUT` accepted, validated, stored — never read; trace is hardcoded to stderr. Exactly the H4 "dead knob" class this project claims to have removed; `--mode explain` is similarly inert |
| OX-M1 | Medium | Within-payload dedup only fires for blocks also seen in a *previous* turn; first-turn intra-payload duplicates are never elided (README table overstates) |
| OX-M2 | Medium | `--diff` silently ignored on multi-file/directory optimize runs |
| OX-M3 | Medium | Multi-file route ignores `--input-name`; applies `--language` blanket to every file (misclassification of mixed directories) |
| OX-M4 | Medium | Directory walk does not skip `.claude` — `optimize .` ingests the entire duplicated worktree under `.claude/worktrees/` |
| OX-M5 | Medium | `trimRegionsToCeiling` registers store blocks for candidate spans that are never elided (hasher pollution on long-lived MCP servers) |
| OX-M6 | Medium | Rehydration treats an empty ledger-candidate set as "rehydrate everything" — subtle and contrary to the targeted-candidates reading |
| OX-M7 | Medium | Debt baseline mixes pre-elision `originalBytes` with post-elision lengths across items — elision-ratio penalty skewed on mixed bundles |
| OX-M8 | Medium | Non-loopback gateway bind without a configured token = unauthenticated open relay; token enforcement is conditional on configuration, not on exposure |
| OX-M9 | Medium | No CORS/OPTIONS/Origin handling — browser DNS-rebinding/simple-request relay surface against localhost gateway |
| OX-M10 | Medium | `TOKENDAMPER_MINIMUM_CONFIDENCE` accepts any finite number (>1 permanently forces fallback) |
| OX-M11 | Medium | ARCHITECTURE.md diagram drift: wrong stage order, session-dedup mislabeled as using TokenHasher |
| OX-M12 | Medium | Stale comment in `bench/runner.ts`: claims token-hashing defaults to `new TokenHasher()` internally — the default was deliberately removed |
| OX-M13 | Medium | `--minimum-confidence` is nearly inert: validation confidence is binary 0/1, so only the (rarely supplied) ledger path can land between |
| OX-M14 | Low | Dropped-files warning gives self-contradictory advice about raising/lowering `--target-reduction-ratio` |
| OX-L1..L20 | Low | Assorted: timeout detection regex that cannot match, symlink skip, case-sensitive git path match, dead `limits` merge, version double-bookkeeping, etc. |

The highest-leverage theme: **the surfaces that report or wrap (exit codes, trace routing, bench duplication, splice effectiveness) lag behind the core pipeline's rigor.** Core elision/validation/drift logic survived review well.

---

## 1. System map (for orientation)

```
Entry points
  src/cli/main.ts            runCli(): optimize (single/multi-file), exec, bench, mcp
  src/adapters/cli           parse()/format() thin adapter -> createOptimizationRequest
  src/gateway/server.ts      GatewayServer (node:http, loopback, optional token)
  src/gateway/proxy.ts       handleProxyRequest: parse payload -> items -> engine -> splice back into raw bytes
  src/gateway/exec.ts        runExecCommand: spawn child w/ OPENAI_BASE_URL/ANTHROPIC_BASE_URL pointed at gateway
  src/adapters/mcp           McpStdioServer (JSON-RPC 2.0, newline-delimited) + tools.ts handlers

Core pipeline (engine/index.ts optimize())
  planner.plan()             mode selection: pass_through | topology_knapsack | session_dedup
    knapsack stage list: cleanup:constraint-preservation, pruning:topology-pruner,
                         compression:token-hashing, compression:delta-compression
    gateway pins:        cleanup:session-dedup only
  stages/*                   transforms; all routed through core/elision elideItem/elideRegions chokepoints
  validation                 AST-lite validators (ts/py/json/go), constraint directives, DriftTracker,
                             budget check, coverage/attribution reports
  ledger                     ConfidenceLedger (min-confidence), DebtTracker (D_k)
  fallback                   resolveFallback(): success renders bundle, fallback echoes request.rawInput
  trace                      buildTrace(): per-stage metrics/durations, coverage, itemsReverted

Support
  core/hashing/tokenizer     single estimator seam (estimateTokens/estimateBundleTokens)
  core/elision               markers (self-describing), JSON wrapper, region selectors (TS/Py only)
  core/topology              git inspector (execSync + TTL cache), dependency graph, scorer
  core/budget                resolveTokenCeiling: maxInputTokens vs targetReductionRatio -> min ceiling
  config                     file -> env -> CLI override chain; strict enum parsing
  bench                      runner + evaluator (spawns real python), bundled HumanEval/CodeXGLUE subsets
```

Key architectural facts a fixing agent must know:

- **Invariant 7:** pinned items bypass the knapsack entirely, so the budget *can* be exceeded by pins; when that happens the run usually ends in `BUDGET_EXCEEDED` → full fallback.
- **Invariant 8:** the Gateway plans only `cleanup:session-dedup`. Do not widen without reading the drift-gate notes in proxy.ts.
- **Invariant 3 / DECISIONS §35:** fallback must return caller bytes exactly; CLI keeps original `Buffer`s for this reason; Gateway splices replacements into the caller's raw body instead of re-serializing.
- Elision is only sub-item selectable for TypeScript/JavaScript and Python (`REGION_ELISION_LANGUAGES`, regions.ts:762-767). Everything else is whole-item-only and structurally refused by the drift gate — this is intended, reported via `languageSupport`.

---

## 2. Findings

Severity rubric:
- **High** — wrong observable behavior in a shipping path, silent data/effectiveness loss, or a defect class the project explicitly claims to have eliminated.
- **Medium** — real behavioral gap, misleading output/doc, security hardening gap, or measurable inefficiency; safe-direction failures included here when they cost users money/time.
- **Low** — hygiene, robustness edges, doc nits, dead code.

### OX-H1 (High) — `tokendamper exec` discards the child process exit code

- **Where:** `src/cli/main.ts:62-68` (exec branch returns 0 immediately), `src/cli/main.ts:363-366` (`main()` sets `process.exitCode` from that return), `src/gateway/exec.ts:92-109` (promise resolves the child's real code, nobody consumes it).
- **Mechanism:** `runCli` handles `exec` by firing `runExecCommand(...).catch(...)` and returning `0` synchronously. The process stays alive only because the spawned child holds stdio/stdout pipes. When the child exits, the promise resolves with its code — but `main()` already set `process.exitCode = 0`.
- **Impact:** any scripted use (`tokendamper exec -- aider ... && next-step`) observes success even when the wrapped tool failed. This is precisely the invariant-10 shape (a result that looks clean regardless of what happened) applied to the process boundary.
- **Repro:** `tokendamper exec -- node -e "process.exit(3)" ; echo %ERRORLEVEL%` → 0.
- **Fix direction:** make the exec branch await the promise and return the code (runCli would need to be async for that branch, or set a module-level captured code consumed by `main()`), while keeping the current fire-and-forget behavior only where tests rely on it.
- **Constraints:** `exec.ts`'s documented security boundaries (shell:true, base-URL interception) must not change; server stop-on-close ordering must be preserved.

### OX-H2 (High) — Gateway kills streaming responses after 30 seconds total

- **Where:** `src/gateway/proxy.ts:165-179` (`AbortSignal.timeout(30000)` combined into the fetch signal), stream pump in `src/gateway/server.ts:232-251`.
- **Mechanism:** the timeout signal is armed once per request and passed to `fetch`. It aborts not just connection establishment but the **entire body stream**: for `stream: true` payloads, `reader.read()` rejects ~30 s in and `writeProxyResult` destroys the client response mid-generation.
- **Impact:** LLM completions routinely exceed 30 s wall-clock, especially Anthropic long-form streams. Every such response is truncated/errored through the proxy. This makes the experimental Gateway unusable for exactly the traffic it intercepts by default.
- **Repro:** point any client at the gateway with `"stream": true` and a provider/model that takes >30 s (or a mock upstream that delays SSE chunks past 30 s).
- **Fix direction:** apply the timeout to headers/TTFB only (e.g., race fetch against the timer, then disarm/disconnect the signal for the body phase), keep the caller-disconnect `abortController` for the body, and consider making the budget configurable.
- **Constraints:** preserve the 504 TimeoutError mapping and the abort-on-client-close behavior (`server.ts:185-190`).

### OX-H3 (High) — vitest executes a duplicated suite from an untracked worktree copy

- **Where:** there is **no `vitest.config.*`** anywhere in the repo (glob verified); vitest's default include (`**/*.{test,spec}...`) therefore scans `.claude/worktrees/sharp-nightingale-5af38c/**`, which contains a full copy of `test/`.
- **Evidence:** this audit's `npm test` output includes files like `.claude/worktrees/sharp-nightingale-5af38c/test/unit/cli/m2_stress.test.ts` and `.claude/worktrees/sharp-nightingale-5af38c/test/unit/bench/runner.test.ts` running alongside the canonical copies (155 files / 1410 tests instead of the repo's own ~77 files).
- **Impact:** doubled local test wall-time; stale-worktree drift can produce false confidence (old tests passing/failing independently of the real tree); benchmark-ish tests run twice concurrently and inflate machine load, worsening the latency-sensitive assertions. CI is unaffected (fresh checkout lacks `.claude`), so local green ≠ what CI measures in duration characteristics.
- **Fix direction:** add a minimal `vitest.config.ts` pinning `include: ['test/**/*.test.ts']` (and `exclude` for `.claude`, `dist`, `node_modules`), or add `.claude` to eslint/vitest ignores. Optionally delete the stale worktree.
- **Constraints:** none conflicting; keep `types: ["node", "vitest/globals"]` working (tsconfig.json:18).

### OX-H4 (High) — `content: null` messages silently defeat the Gateway splice (savings lost per request)

- **Where:** `src/gateway/proxy.ts:564-568` (`flattenMessageContent`: non-string → `JSON.stringify(content)`; `null` → the string `"null"`), entries built at `proxy.ts:807-814` (OpenAI) and `947-951` (Anthropic), `spliceIntoRawBody` at `proxy.ts:647-665`, `forwardableBody` at `proxy.ts:705-718`.
- **Mechanism:** egress locates each message's text in the caller's raw bytes by searching for `JSON.stringify(text)`. For a message whose content was JSON `null` (the standard OpenAI shape for assistant tool-call turns), that search string is `"null"` (quoted), which does not appear where the body has bare `null`. `indexOf` returns −1 → `spliceIntoRawBody` declines → **the entire request is forwarded unchanged**, including the parts that did optimize.
- **Impact:** any conversation containing one assistant tool-call message (i.e., essentially every agentic OpenAI workload) gets 0 savings, silently, with metrics still recorded as if measured on the forwarded bytes (they are — `wireTokenMetrics(rawBody, finalBody)` — so numbers stay honest; the saving simply never happens). Fail-safe direction, but it neutralizes the product's headline value on the most common payload shape.
- **Repro:** POST to the gateway `/v1/chat/completions` a body with `messages: [{role:'system',content:'x x x'}, {role:'assistant',content:null,tool_calls:[...]}, ...]` plus a repeated block eligible for within-payload dedup; observe finalBody === rawBody.
- **Fix direction:** build splice entries keyed by position-aware anchors rather than value-search alone — e.g., record the byte offset of each message's content at parse time (a tiny tolerant JSON scanner or a second pass with a position-preserving parser), falling back to today's value search. Alternatively special-case nullish content to `{from: 'null'}` matched against the exact token `null` with word boundaries.
- **Constraints:** audit M7's rules stand — never re-serialize the payload; declining must stay the failure direction; the forward-cursor duplicate handling must survive any rewrite.

### OX-H5 (High) — `--trace-output` / `TOKENDAMPER_TRACE_OUTPUT` is a live dead knob; `--mode explain` too

- **Where:** flag parsed at `src/cli/main.ts:579-586`; stored via `ConfigOverrides.traceOutput` → `applyCliOverrides` (`src/config/load.ts:111-134`); env variant at `load.ts:227-229`; schema guard `src/config/schema.ts:100-102`. **Consumer: none.** The optimize paths write the trace with a literal: `io.stderr.write(JSON.stringify(result.trace, ...))` at `main.ts:213` and `main.ts:304`.
- **Also inert:** `AppMode = 'explain'` (`src/core/model/types.ts:24`) is accepted by `--mode` (`main.ts:553-563`) and by `TOKENDAMPER_APP_MODE`/config file, but nothing branches on `explain` — it stores a string and changes nothing.
- **Why this is High, not Low:** audit H4 (recorded in `README.md:160-165` and `core/model/types.ts:98-106`) removed `--max-output-tokens`, `--max-latency-ms`, and `--risk-tolerance` *precisely because* they were "wired end to end … while no stage read them." These two survivors are the same defect still shipping: validated input that reports success and does nothing. A user who sets `--trace-output stdout` to capture a trace in a pipe gets stderr anyway and concludes the tool ignored them — which it did.
- **Fix direction (two honest options):** (a) implement — honor `traceOutput` in both optimize paths and implement or refuse `explain`; or (b) withdraw both from the CLI/env/config-file surfaces exactly as H4 did, leaving the fields in the frozen model with their "unconsumed" doc comments.
- **Constraints:** if withdrawing, follow the H4 playbook (docs update + SUPPORTED_FLAGS removal + changelog); if implementing, note the MCP channel contract warning in `LanguageSupportReport.reason` (model/types.ts:294-302) about prepending prose to the stderr JSON stream.

### OX-M1 (Medium) — First-turn intra-payload duplicates are never deduplicated

- **Where:** `src/stages/cleanup/session-dedup.ts:92` — the dedup branch requires `sessionContext.previousBlockHashes.has(item.contentHash)`; rule 3 ("preserve first copy as referent") at lines 93-99 only runs inside that branch.
- **Mechanism:** within-payload repetition is handled *only* as a side condition of cross-turn matching. On turn 1 (empty `previousBlockHashes`) two identical blocks in one payload both survive. On turn N, a pair saves only if the hash was seen in some earlier turn.
- **Impact:** the README table (`README.md:13-19`) reads as "same block repeated within one payload → saves," unconditionally. The true rule is narrower. Not a correctness bug (fail-safe), but the advertised saving model overstates turn-1 behavior, and the Gateway's "0 bytes across turns" framing hides that even the within-payload win needs history.
- **Fix direction:** either relax the gate to trigger on intra-bundle `totalOccurrences > 1` regardless of prior turns (rule 3 already guarantees an intact referent survives in-payload, so `recoverable: true` remains verifiable), or correct the README wording to state the precondition.
- **Constraints:** DECISIONS §16/§41 reasoning about sole-copy elision must remain intact; `recoverable` must stay verifiable-in-payload.

### OX-M2 (Medium) — `--diff` silently ignored on multi-file/directory optimize

- **Where:** flag accepted for `optimize` (`main.ts:437-447`); single-file path honors it (`main.ts:203-206`); multi-file path `runMultiFileOptimize` (`main.ts:244-306`) handles only `--diff-html` and never checks `parsed.diff`.
- **Impact:** user asks for a visual diff on a directory run, pays for the flag, gets nothing — the exact "accepted then dropped" pattern the flag-support table (`main.ts:394-424`) was built to eliminate.
- **Fix direction:** render the diff in the multi-file branch too (`renderTerminalDiff(request.bundle, result.finalBundle)` works for bundles), or reject `--diff` with pointers like `rejectUnsupportedFlags` does.

### OX-M3 (Medium) — multi-file route: `--input-name` ignored; `--language` applied to every file

- **Where:** `runMultiFileOptimize` (`main.ts:262-267`) spreads `parsed.language` into *every* `RequestFileInput`; `parsed.inputName` is never consulted there. Parser permits both flags on `optimize` generally (`SUPPORTED_FLAGS`, `main.ts:437-450`).
- **Impact:** (a) `optimize ./dir --input-name foo.py` silently no-ops; (b) `optimize mixed-dir --language python` relabels `.ts`/`.json` files as Python — declaration outranks extension by design (`constructors.ts:154-157`), so this actively misroutes validators and elision for every non-Python file in the tree.
- **Fix direction:** error when `--language`/`--input-name` accompany multi-path ingestion (or scope `--language` to stdin/single-file only), consistent with the parser's own philosophy at `main.ts:775-780`.

### OX-M4 (Medium) — directory walk does not exclude `.claude` (and similar agent dirs)

- **Where:** `SKIP_DIRECTORIES` at `src/cli/ingest.ts:32-34` covers `node_modules/.git/dist/build/coverage/.next/.venv/__pycache__` but not `.claude`, `.agents`, `scratch`, `vendor`, `out`, `target`.
- **Impact (concrete, observed on this machine):** `tokendamper optimize .` ingests the full source copy under `.claude/worktrees/sharp-nightingale-5af38c/src/**` — duplicated content skews the token budget, prefix locking, and knapsack selection; outputs silently contain two copies of many files. Same risk for any user with agent worktree dirs.
- **Fix direction:** add `.claude`, `.agents`, and dot-directory-by-default policy (skip any entry starting with `.` except an allowlist), or document loudly. Dotfile-skip is the least surprising general rule.

### OX-M5 (Medium) — candidate-region markers pollute the TokenHasher store

- **Where:** `trimRegionsToCeiling` at `src/stages/compression/token-hashing.ts:436-445` calls `markerFor(...)` per candidate span *to price it*, and `markerFor` (lines 104-110) registers every priced block into the supplied hasher.
- **Impact:** on MCP/bench (reversible hasher, long-lived server instance in MCP), the store accumulates blocks for spans never emitted; memory grows with candidate counts, and `hasHash`/`expandBlockHash` can resolve placeholders that were never written into any output (harmless but misleading; slightly enlarges rehydration scan surface).
- **Fix direction:** split pricing from registration — compute marker bytes with `renderElisionMarker(hashContent(text), ...)` without `registerBlock`, and register only in the actual elide path.
- **Constraints:** marker bytes must remain identical between pricing and emission (they are a pure function of text), otherwise ceiling adherence shifts.

### OX-M6 (Medium) — empty rehydration-candidate set means "rehydrate everything"

- **Where:** `attemptAutomatedRehydration`, `src/core/engine/index.ts:526-531`: `candidates` is `null` without a ledger, else the low-confidence set; the guard `candidates && candidates.size > 0 && !candidates.has(item.id)` means a ledger with **zero** candidates fails the size check and every elided item becomes a rehydration target.
- **Impact:** when `shouldRehydrate` fires from debt (bytes/turn-age) but no individual elision is below the confidence threshold, the engine restores *all* elisions rather than none — a large semantic cliff hidden behind a small boolean. Possibly intended ("no specification → treat all as candidates"), but it contradicts the inline comment's "target those" reading and produces surprising output flips.
- **Fix direction:** make the intent explicit: `const scoped = candidates !== null && candidates.size > 0;` and skip items only when `scoped && !candidates.has(id)`.

### OX-M7 (Medium) — debt ratio mixes measurement baselines across items

- **Where:** `computeDebtBreakdown`, `src/core/engine/index.ts:484-489`: `totalBytes` adds `metadata.originalBytes` when present (transformed items) but current `content.length` otherwise (untouched items); `elidedBytes` adds `originalBytes` for elided items.
- **Impact:** on bundles where some items were elided and others untouched, the denominator mixes pre- and post-transform sizes, inflating `elisionRatio` (each elided item contributes its full original size against a shrunken total). Consequence: earlier `shouldRehydrate` triggers and overstated `debtScore` in traces/reports.
- **Fix direction:** track originals uniformly — e.g., have stages stamp `originalBytes` on untouched items too, or accumulate the pre-run bundle's sizes in the engine (it holds `request.bundle`).

### OX-M8 (Medium) — non-loopback bind without a token is an open relay

- **Where:** `src/gateway/server.ts:130-142` — the token gate runs only `if (this.config.gatewayToken && !isLoopbackPeer(req))`.
- **Impact:** configuring `host: '0.0.0.0'` (or any LAN bind) without setting `gatewayToken` yields an unauthenticated relay that forwards arbitrary bodies to upstream providers with whatever credentials the caller supplies. The docs say the token is "enforced only on a non-loopback bind" (README:154), but the code enforces it only *if provided*. Nothing warns or refuses an exposed bind without a token.
- **Fix direction:** refuse to start (or log a prominent warning + require explicit opt-in) when binding non-loopback with no token; alternatively auto-generate and print one.
- **Constraints:** keep loopback trust (audit C3 rationale) and the constant-time comparison.

### OX-M9 (Medium) — no CORS/OPTIONS/Origin handling on the Gateway

- **Where:** `GatewayServer.onRequest` (`server.ts:97-218`) answers only GET /health and the proxied POSTs; no OPTIONS handler, no Origin/Host validation.
- **Impact:** a malicious web page can issue "simple" cross-origin POSTs (text/plain) to `http://127.0.0.1:<port>/v1/chat/completions` from a victim's browser (DNS rebinding aside, localhost is reachable pre-flight-free with simple requests). The attacker cannot read responses (no CORS headers) and must supply their own API key, so impact is limited to using the victim's machine/network as a relay and provoking provider-side effects. Still undocumented attack surface for a localhost service.
- **Fix direction:** validate `Host`/`Origin` (reject foreign origins), answer OPTIONS with a restrictive CORS policy (default: none), and/or require the `x-tokendamper-token` header even on loopback for browser-initiated requests (browsers cannot set custom headers in simple requests — this cleanly splits browsers from local clients).

### OX-M10 (Medium) — `TOKENDAMPER_MINIMUM_CONFIDENCE` unvalidated

- **Where:** `parseNumber` at `src/config/load.ts:241-248` feeds `validation.minimumConfidence` directly; no range check anywhere (schema only type-checks number, `schema.ts:59-61`).
- **Impact:** `TOKENDAMPER_MINIMUM_CONFIDENCE=1.5` forces fallback on every optimized run (final ledger/confidence comparisons can never reach 1.5); negative values are meaningless. Contrast: budget fields throw descriptive errors via `validateBudget`.
- **Fix direction:** clamp-or-reject in `applyEnvOverrides`/`applyCliOverrides` with the same error style used for enums (audit L1 fix pattern).

### OX-M11 (Medium) — ARCHITECTURE.md pipeline diagram drift

- **Where:** `ARCHITECTURE.md:21-28` lists execution order "Session Deduplication (TokenHasher) → Delta Compression (Myers Diff) → Workspace Topology Pruning". Actual knapsack plan order (`src/core/planner/index.ts:43-49`): `cleanup:constraint-preservation → pruning:topology-pruner → compression:token-hashing → compression:delta-compression`; session-dedup is a separate Gateway-pinned plan and does **not** use TokenHasher (it uses the session store + `renderSessionElisionMarker`).
- **Impact:** this file declares itself "the canonical architecture reference… frozen"; agents and contributors wiring new stages will validate against a wrong order and a wrong dependency claim.
- **Fix direction:** update the diagram to the two real plan shapes (knapsack list above; `session_dedup` single-stage), and drop "(TokenHasher)".

### OX-M12 (Medium) — stale claim in BenchmarkRunner comment contradicts deliberate code change

- **Where:** `src/bench/runner.ts:45-57` says "`token-hashing` falls back to `new TokenHasher()` internally when none is supplied". `src/stages/compression/token-hashing.ts:52-69` removed that default deliberately (the fabricated-store defect) and now leaves hasher absent ⇒ irreversible elision.
- **Impact:** the repo's core discipline is that comments carry decisions; a comment asserting removed behavior invites someone to "simplify" the runner back into relying on the nonexistent default, silently re-creating the M-class defect described in token-hashing.ts.
- **Fix direction:** update the comment to describe the current contract (runner supplies the hasher precisely because the stage no longer fabricates one).

### OX-M13 (Medium) — `--minimum-confidence` is nearly inert

- **Where:** `confidence` is binary in validation (`src/core/validation/index.ts:230`: `passed ? 1 : 0`); the only fractional confidences come from `ConfidenceLedger.getOverallConfidence` when a ledger is supplied (CLI supplies none; Gateway creates a fresh same-turn ledger where scores sit at 1.0).
- **Impact:** any value in (0,1) behaves identically to 1 except in embedder setups with a persistent ledger — i.e., the dial mostly does nothing, again brushing the H4 pattern (consumed, barely effective, undocumented nuance).
- **Fix direction:** either document precisely (help text + README) that the knob gates ledger confidence only, or derive a graded confidence from validation signals (coverage, drift margin) so the dial has meaning.

### OX-M14 (Low→Medium) — dropped-files warning advice is self-contradictory

- **Where:** `warnAboutDroppedFiles`, `src/cli/main.ts:337-342`: *"Raise --target-reduction-ratio's budget (a lower ratio prunes less)…"*
- **Impact:** "raise … (a lower ratio…)" reads backwards; a confused user may do the opposite of intended.
- **Fix direction:** "Lower `--target-reduction-ratio` (e.g. 0.3 → 0.1) or raise `--max-input-tokens` to prune less."

### OX-M15 (Medium) — plain `tokendamper bench` spawns Python subprocesses by default

- **Where:** `BenchmarkRunner.run` defaults `evaluateQuality = true` (`src/bench/runner.ts:32`); evaluator executes fixture code via `python -c` (`src/bench/evaluator.ts:183-226`). CLI bench wiring passes no override (`main.ts:95-105`).
- **Impact:** an "offline, deterministic" harness (`ARCHITECTURE.md` Benchmark Philosophy) reaches for interpreters and executes dataset code on every user-invoked bench. Latency metrics are unaffected (measured around `optimize()` only), but determinism/portability claims and user expectations are not; escape hatch exists only as an undocumented env (`TOKENDAMPER_BENCH_DISABLE_PYTHON`).
- **Fix direction:** default `evaluateQuality` off for the CLI surface (keep on for the regression suites), or document the env switch in README.

### OX-M16 (Medium) — cross-platform order determinism gap in directory ingestion

- **Where:** `expandPath` builds paths with `path.join` (native separators) then sorts the native strings (`src/cli/ingest.ts:59-75`).
- **Impact:** sort order of `a\b` vs `a/b` styles differs across OSes; bundle order feeds prefix-locking (`invariant 6/7`), so the *same directory* can select different pinned/pruned sets on Windows vs Linux. Deterministic per platform, not across platforms — worth stating or normalizing (sort on POSIX-normalized keys, emit normalized labels).

### OX-L findings (hygiene/edges)

- **OX-L1 — decorative planner fields.** `expectedSavings` hardcoded `0.45` (`planner/index.ts:57`); `_stageCatalog` unused (`planner/index.ts:17`); exported `planOptimizationMode` appears test-only. Either wire or mark clearly as placeholder.
- **OX-L2 — `stableSerialize` collapses `undefined` → `'null'`** (`constructors.ts:804`), so `{a: undefined}` and `{a: null}` hash identically. Harmless today; noted for hash-provenance reasoning.
- **OX-L3 — language alias `'h' → 'c'`** (`constructors.ts:679`): declaring C for a header file is fine, but the alias silently maps a header extension onto a language; harmless, surprising.
- **OX-L4 — symlinked files skipped silently** (`ingest.ts:60-67`): `Dirent.isFile()` is false for symlinks, so `optimize link-to-file.ts` in a directory walk drops it without a word. Explicitly-named symlinks resolve via `statSync` (follows links) — inconsistent between the two routes.
- **OX-L5 — case-sensitive git path matching** (`git-inspector.ts:30-40`, `topology-scorer.ts:107`): on Windows/macOS case-insensitive filesystems, differently-cased paths miss dirty/recent sets, quietly lowering topology scores.
- **OX-L6 — hardcoded `MAX_SEEN_BLOCK_HASHES = 1000`** (`session-store.ts:224`) amid configurable neighbors; eviction is insertion-order refresh via delete+add (fine), but the cap should join `GatewayConfig`.
- **OX-L7 — MCP buffer overflow discards buffered complete lines** (`adapters/mcp/server.ts:54-66`): on overflow the whole buffer is cleared after one parse error; complete requests already in the buffer following the oversized line are lost (connection is effectively dead anyway — acceptable, but say so in the error or drain line-by-line first).
- **OX-L8 — MCP shutdown flush race** (`cli/main.ts:49-54`): `process.exit(0)` in the SIGINT handler can truncate a just-written stdout frame; prefer `server.stop()` then allow natural exit or flush-and-exit.
- **OX-L9 — dead `limits` merge with unsafe casts** (`bench/fixtures/loader.ts:86-96`): `ResolvedConfig` has no `limits` field; the branch can never fire. Delete.
- **OX-L10 — substring dataset routing** (`fixtures/loader.ts:32-38`): `includes('humaneval')` can hijack custom filenames containing the word; prefer exact-name-first with substring as last resort.
- **OX-L11 — naive extension extraction** (`constructors.rs:565` analog: `sourcePath.split('.').pop()`): dotted directory names degrade classification to probes; use basename-after-last-slash then last dot (as `ingest.extensionOf` already does correctly — reuse it).
- **OX-L12 — version double-bookkeeping** (`package.json:3` vs `src/version.ts:1`): manual sync; a release script or a build-time read of package.json removes the drift class.
- **OX-L13 — `/health` exposes sessionCount; no rate limiting** (`server.ts:101-110`): trivial info leak, loopback-mitigated; note for non-loopback binds.
- **OX-L14 — elision chokepoint post-condition is currently non-firing by design** (`core/elision/index.ts:121-152`): the doc comment is admirably precise; keep it adjacent whenever validators tighten, as it instructs.
- **OX-L15 — DriftTracker symbol regex noise** (`drift-tracker.ts:439-607`): `get`/`set`/`static` method matches and import regexes harvest mentions in comments/strings; affects R_AST precision, accepted tradeoff — but any future tightening should start from the Go block's anchoring discipline.
- **OX-L16 — deep `freeze()` cost** (`constructors.ts:491-507`): recursive freeze on every constructor call is O(payload); fine at current scales, hot if bundles grow; consider dev-only freezing behind a flag if profiling ever points here.
- **OX-L17 — architecture import rules are unpoliced** (`eslint.config.mjs` is minimal): the strict module boundaries in ARCHITECTURE.md are convention-only. `eslint-plugin-boundaries` or dependency-cruiser in CI would make violations compile-failure-loud, matching the repo's own "make it a compile error" ethos.
- **OX-L18 — no coverage tooling configured** despite vitest; cheap add (`--coverage`) given the suite breadth.
- **OX-L19 — `.gitignore` is Python-template noise** (245 lines, most irrelevant to a TS package): harmless but buries the meaningful Node entries at the bottom; prune to relevant entries.
- **OX-L20 — bulky local artifacts present but ignored**: `repomix-output.xml`, `scratch/`, `tokendamper-benchmark/{venv,__pycache__}`, `diff_report.html`, `.venv/`. Ignored, so invisible to git — but `repomix-output.xml` is a full-repo snapshot; avoid committing or sharing it accidentally.

---

## 3. Security review summary

Overall posture is strong for a local tool: constant-time token compare (`server.ts:22-30`), loopback-only trust with socket-derived peer checks (`server.ts:15-19`), secrets stripped from response headers (`proxy.ts:228-245`), forward-header allowlist (`proxy.ts:283-321`), byte-exact pass-through for non-UTF-8 bodies (`proxy.ts:376-399`, `server.ts:144-183`), sanitized child-process errors (`exec.ts:104-108`), 10 MB body caps on both HTTP and MCP channels, and HTML report escaping (`html-reporter.ts:324-331`).

Gaps, in priority order: OX-M8 (token optional on exposed binds), OX-M9 (browser relay surface), OX-H2 (DoS-ish truncation of long streams), plus the noted `shell: true` trust boundary in `exec` (documented; keep it that way) and fixture-code execution in bench (trusted-input assumption; keep offline).

---

## 4. Test-suite observations

- Breadth is genuinely impressive (unit + integration + adversarial CLI formatting + fuzz for diff/debt + milestone challenger suites). Green at audit time.
- **But see OX-H3:** the executed set currently includes a mirrored worktree copy; until vitest is pinned, treat any "155 files" number as ~2× reality and beware editing tests in the canonical tree while stale copies keep old expectations alive.
- Coverage gaps noticed (not exhaustive):
  - No test exercises `exec`'s exit-code propagation (would have caught OX-H1).
  - No Gateway test with a >30 s upstream (would have caught OX-H2).
  - No Gateway splice test with `content: null` messages (OX-H4).
  - Multi-file route has no assertion that `--diff`/`--input-name` are honored or rejected (OX-M2/M3).
  - No test for turn-1 intra-payload duplicate pairs (OX-M1).
- The suite's own philosophy (pin behavior loudly, e.g. `fallback-render.test.ts`) is the right model for the fixes above.

---

## 5. Documentation accuracy spot-check

- README's "What validation actually checks" table is accurate against the validators as written (bracket/quote integrity, relative post-condition, JSON being the only real parse).
- README's Gateway savings table slightly overstates within-payload dedup (see OX-M1).
- ARCHITECTURE.md diagram drift (OX-M11) and the runner comment rot (OX-M12) are the only factual errors found; the rest of the decision-trail comments sampled (engine, elision, drift, token-hashing, proxy) matched the code they annotate.

---

## 6. Suggested fix order (for whoever picks this up)

1. OX-H3 (vitest config) — five minutes, unblocks trustworthy test signal for everything else.
2. OX-H1 (exec exit code) — small, pure win for scripting users.
3. OX-H5 (dead knobs: trace-output/explain) — decide implement-vs-withdraw per the H4 precedent.
4. OX-H4 (content:null splice) — biggest Gateway value unlock; design the offset-anchor approach before touching code.
5. OX-H2 (streaming timeout) — split TTFB timeout from body lifetime; add a slow-stream integration test.
6. OX-M1/M2/M3/M4 (behavioral honesty in CLI/dedup surfaces).
7. OX-M5..M15 as capacity allows; L-items opportunistically.

Each fix should land with the test that would have caught it, per the repo's own convention.

---

## Appendix A — Files reviewed (complete `src/` inventory)

cli/{main, ingest, html-reporter, diff-renderer, bench-table-renderer}; adapters/{cli/index, mcp/index, mcp/server, mcp/tools, mcp/types}; gateway/{server, proxy, exec, session-store, types}; core/{model/{types, constructors, index}, engine, planner/{index, knapsack, cache-aware}, budget, elision/{index, marker, regions}, hashing/{tokenizer, token-hasher}, validation/{index, language-support, ast/{index, types, ts-validator, python-validator, json-validator, go-validator}}, ledger/{drift-tracker, debt-tracker, confidence-ledger, index}, topology/{topology-scorer, git-inspector, dependency-graph}, stage-registry, constraints/directives, fallback, trace, render, utils/myers-diff}; stages/{cleanup/{session-dedup, constraint-preservation}, pruning/topology-pruner, compression/{token-hashing, delta-compression}}; bench/{runner, evaluator, types, index, fixtures/{loader, humaneval, codexglue, bundled-path, types, index}}; config/{load, schema, types, index}; version.ts; index.ts.

Repo surfaces: package.json, tsconfig.json, eslint.config.mjs, .npmrc, tokendamper.cmd, .gitignore, .github/workflows/ci.yml, README.md, ARCHITECTURE.md, docs/ listing, max_audit.md (prior audit, 525 lines), DECISIONS.md (3,235 lines, section references used throughout).

## Appendix B — Commands and results

| Command | Result |
|---|---|
| `npm run typecheck` | pass, no output |
| `npm run lint` | pass, no output |
| `npm test` | 155 files / 1410 tests passed, ~19 s (inflated by OX-H3 duplicates) |
| `git status` | clean at `79aedef` |
