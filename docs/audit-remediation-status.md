# Audit remediation — status and next steps

Working state for the `max_audit.md` remediation. **Read this before picking up audit work**;
it records what is done, what is measured, and what the next batch actually requires.

Last updated 2026-08-09, at `main` = `dd540fe`. Suite: **525 passing**, typecheck and lint clean.

---

## 1. Where things stand

| Wave | Items | Status |
|---|---|---|
| **0** | H3, M3, M4a | ✅ merged |
| **1** | C1a, C1b, C2, M6 | ✅ merged |
| **2** | M5a, M5b, H4, M8, M9, M10 | ⬜ **not started — next** |
| **3** | C3/H1 ✅, H6 ✅, H5 ✅, C4 ⬜ | mostly merged |
| Decisions | H2, M1, M11 | ⬜ not addressed |

Wave 2 was skipped when work jumped straight from Wave 1 to the Gateway. Its items are small,
independent, and include the highest harm-prevented-per-line still on the board.

### Corresponding DECISIONS entries

§36 license · §37 C1a · §38 C2 · §39 M6 · §40 C1b · §41 C3/H1 · §42 H6 · §43 H5

---

## 2. Measured baseline

Recorded 2026-08-09 at `main` = `dd540fe`, via `tools/corpus-harness`, 295 files / 590 rows,
both routes. **These are the numbers to compare against; do not re-derive them from memory.**

| bucket | route | n | reduced | fallback | saved |
|---|---|---|---|---|---|
| python | file | 45 | 30 | 14 | **23.14%** |
| python | stdin | 45 | 28 | 13 | **22.66%** |
| typescript | file | 59 | 33 | 19 | **25.35%** |
| typescript | stdin | 59 | 0 | 0 | 0.00% |
| prose | file/stdin | 28 | 0 | 8 | 0.00% |
| shell, perl, tcl, c, rust, css | both | — | 0 | — | 0.00% |

**The 25.35% is not comparable to the 29.55% quoted in `DECISIONS` §43.** Same engine; the
corpus grew by the two files H5 added (`src/cli/ingest.ts`, `src/core/render/index.ts`), so the
denominator changed. This is the trap CLAUDE.md's "this repo is its own corpus" note describes,
and it is why the harness pins bucket counts and refuses on a mismatch.

### Re-measuring

```bash
node tools/corpus-harness/collect.js <scratch-dir>          # freeze + hash + pin engine
node tools/corpus-harness/measure.js <scratch-dir> --variant <label>
```

Two rules that have both been broken before: **freeze the corpus first** (never point the CLI at
the live repo), and for an A/B, **compare over the rows that reduce under every arm** — a variant
that converts fallbacks into reductions changes the denominator and can make a strictly worse
rule look better on the mean.

---

## 3. Wave 2 — what to do

All six verified still open at `dd540fe`. Roughly half a day for the batch.

### M5a — `optimize_context` has no budget parameter *(highest value)*

**`src/adapters/mcp/tools.ts`**, `TOOL_DEFINITIONS`. The schema exposes
`rawInput, language, path, maxInputTokens, riskTolerance, preserveKinds` — and **no
`targetReductionRatio`**.

With no budget the planner returns `pass_through` with an empty `stageIds`, so an MCP client
calling the tool as documented gets a **guaranteed 0% no-op** reporting `reductionRatio: 0` and
no error. One of three advertised entry modes currently does nothing.

`maxInputTokens` *is* exposed and would engage the knapsack — but nothing tells a caller that a
budget is mandatory, and the tool description promises compression unconditionally. Add
`targetReductionRatio` and make the description state that a budget is required.

Safe to do now: it was gated on C1a (§37) so that turning MCP on could not start deleting
markdown documents. C1a is merged.

### M5b — `rehydrate_context`'s session path cannot match

**`src/adapters/mcp/tools.ts:210`** looks for `/<ELIDED:\s*ref=([A-Za-z0-9_-]+)[^>]*>/g`.
**`src/stages/cleanup/session-dedup.ts:103`** emits
`` `[TokenDamper Elided: ref=${refId} bytes=${originalLength} kind=${item.kind}]` ``.

Square brackets, different prefix. The regex cannot match any marker the product produces, so
session rehydration through MCP has never worked. Fix the pattern, and add a test that builds the
marker from the emitting code rather than restating it as a literal — restating it is how the two
drifted apart.

### M5 minor (same file)

- `traceStore` is a module-level `Map` shared across all server instances in a process.
- `get_session_metrics` and `resources/read` call `getOrCreateSession`, so **reading creates state**.
- `MCP_PROTOCOL_VERSION` is pinned to `2024-11-05` and `initialize` returns it unconditionally
  rather than negotiating against the client's requested version.

### H4 — knobs that are parsed, validated, then discarded

Verified consumers:

| knob | read by |
|---|---|
| `--max-output-tokens` | **nothing** |
| `--max-latency-ms` | **nothing** |
| `riskTolerance` | `src/cli/bench-table-renderer.ts:97` — the table renderer only |
| `--max-debt` | reaches `DebtTracker`, but `attemptAutomatedRehydration` returns immediately on `if (!hasher && !ledger)`, and the CLI supplies neither |
| `--target-reduction-ratio` | `src/core/planner/index.ts:40` — **only as `> 0`** |

Removing the first three is cheap and honest. `--target-reduction-ratio` is the hard one: every
doc and example uses it, it is a boolean named like a dial, and making it a real target is a
planner change, not a flag change. Recommend removing the dead three now and treating the dial as
its own decision.

Note the debt subsystem is also arithmetically inert on the CLI: with no ledger
`overallConfidence = 1.0` → `confidencePenalty = 0`; on turn 1 `turnAgePenalty = 0`; and
`elisionRatioPenalty` caps at 35 against a default threshold of 75.

### M8 — environment branches inside the request path

**`src/gateway/proxy.ts:77, 109, 228`**. `TOKENDAMPER_MOCK_UPSTREAM=true` makes the proxy return
the optimized request body as if it were the provider's response; `NODE_ENV === 'test'` bypasses
the missing-credentials 401. Neither is documented, and `NODE_ENV=test` is set by many CI systems.

`ProxyHandlerOptions` already exists and already carries `upstreamOpenAiUrl` and `rawBodyBytes` —
test seams belong there, not in ambient environment reads. **Note:** the byte-fidelity and exec
tests added in Waves 1/3 set `TOKENDAMPER_MOCK_UPSTREAM`, so they must move to the injected option
in the same change.

### M9 — request headers returned as response headers

**`src/gateway/proxy.ts:622, 748`** spread `cleanHeaders` into the response, and `cleanHeaders`
strips only `host` and `content-length` — so `authorization` and `x-api-key` are retained.
Reproduced under mock upstream: the response carried `x-api-key: sk-test`.

Latent rather than live, because the normal path replaces these with the upstream response's
headers — but it is one env var away (M8). Construct response headers explicitly.

### M10 — `bench` fails outside the repository

**`src/bench/fixtures/humaneval.ts:8`** and `codexglue.ts` resolve
`test/fixtures/bench/…` against `process.cwd()`, and `test/` is not in `package.json`'s `files`
array. `tokendamper bench` therefore throws for every installed user.

Adjacent, found while measuring and not fixed: `loadBenchmarkFixtures('test/fixtures/bench')`
throws `EISDIR` when handed a directory directly. The CLI works around it at
`src/cli/main.ts:70` by detecting the directory and passing `undefined`, so only direct API
callers hit it.

---

## 4. Traps specific to this codebase

Learned the hard way during Waves 0–3.

- **`baseline.json` assertions are equality, not floors.** They fire on *improvement* as loudly
  as on regression, by design — a `>=` against a measured floor of 0.0 can never fail. If a
  change moves the shipped-fixture numbers, record the new ones deliberately.
- **Hazard-pinning tests exist and will fail on purpose.** Several tests assert current behaviour
  *because it is wrong*, with a comment saying so. Four were updated across Waves 1–3. Read the
  comment before "fixing" the test — it usually names the finding and why it was pinned.
- **Verify a new test fails against the unfixed code.** Every fix in Waves 0–3 did this, and it
  caught a test that would have passed either way.
- **Item `id` is content-derived at construction and preserved by the transforms.** Drift's
  retained-item scoping depends on that correspondence and guards against its absence (§43); do
  not introduce a stage that rebuilds items with fresh ids.
- **The MCP transport is safe from the chunk-splitting defect** because `setEncoding('utf8')`
  installs a `StringDecoder`. Do not "optimise" it into manual concatenation (§38).

---

## 5. Beyond Wave 2

- **§3.1 / Phase 1c — per-item fallback.** Now the binding constraint on multi-file value: on the
  45-file Python corpus, drift is 0.0359 and AST is clean, yet **26 constraint failures across 14
  items revert all 45**. Phase 1c's stated prerequisite was attribution, and that now exists —
  constraint failures name their item (§42), unwitnessed items name theirs (§37), AST issues carry
  `itemId`. Drift remains bundle-scoped and would need its own rule.
- **C4 — structured message content flattened to a string** (`src/gateway/proxy.ts`). Still
  masked by the drift gate refusing the elision first. **It stops being masked the moment anyone
  relaxes cross-turn drift to chase the saving H1 withdrew** — the two are coupled.
- **H2 — language coverage.** 3 of 19 declared languages can produce a non-zero reduction.
  Decision, not a task: narrow the accepted set, or make a declared-but-unsupported language
  report *why* instead of falling back mutely.
- **M1 — "AST-lite validator".** The TypeScript validator is a bracket/quote matcher. Say that in
  user-facing docs, or wire the real compiler API.
- **M11 — documentation volume.** 4.1:1 against source. This file is meant to *replace* scattered
  status prose, not add to it; retire superseded phase narratives to git history.
