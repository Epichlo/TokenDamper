# TokenDamper — Critical Audit

**Date:** 2026-08-07
**Commit audited:** `f93c385` (branch `phase-c-code-is-not-typescript`), **plus uncommitted working-tree changes** to `CLAUDE.md` and `src/core/validation/ast/index.ts`
**Auditor method:** source review + empirical reproduction. Every quantitative claim below was produced by running the code, not by reading it. Reproduction commands are in Appendix A.

---

## 0. How this audit was conducted

Three passes:

1. **Read** — full read of `src/` (12,639 lines across 64 TypeScript files), the three adapters, all five stages, both ledgers, the three AST-lite validators, and the config/trace/fallback layers.
2. **Run** — the project was compiled to a scratch `outDir` (typecheck clean, lint clean) and driven through all three entry modes: CLI (`optimize`, `bench`), Gateway (real HTTP server, real sockets), and the MCP tool layer. The existing `dist/` was left untouched.
3. **Measure** — a frozen corpus of the repository's own 64 tracked `src/**/*.ts` files was copied to a scratch directory (per `CLAUDE.md`'s own instruction to freeze before measuring), plus a synthetic 13-language matrix and hand-built Gateway conversations.

Where a finding contradicts the repository's own documentation, both the documentation and the measurement are quoted.

**A note on what this audit is not.** It is not a rebuttal of the project's engineering culture. The in-source commentary in this codebase is among the most honest I have read — a majority of the findings below are, in some form, *already written down somewhere in the repo*. The problem is not that the team does not know; it is that the knowledge lives in 528 KB of markdown, is contradicted by the user-facing docs, and has not been converted into either fixes or guardrails. Several findings are genuinely new and none of them are recorded anywhere: C1, C2, C3, C4, H1 (as a measured number), H3.

---

## 1. Verdict

TokenDamper is a **carefully-reasoned engine wrapped around a product that does not currently work on any of its three advertised integration paths.**

The core insight is sound and the safety machinery is real. But:

| Entry mode | What it advertises | What it measurably does |
|---|---|---|
| **CLI** (`optimize <file>`) | Deterministic context reduction with syntactic guarantees | **14.04%** aggregate on this repo's own TypeScript; **42 of 64 files (65.6%) reduce by exactly 0%**. Works on 3 of the 19 languages it claims to recognize. **Silently deletes markdown documents in their entirety** and reports success. |
| **Gateway** (`exec`, HTTP proxy) | Transparent interception with cross-turn dedup | **0 bytes saved, 100% fallback** on every realistic conversation tested. **Corrupts non-ASCII request bodies** before forwarding them upstream. And `tokendamper exec` — the documented way to start it — **returns HTTP 401 to every request the child process makes**. |
| **MCP** (`tokendamper mcp`) | Optimization tools for Claude Desktop / Cursor | The default `optimize_context` call has **no budget parameter**, so it is a guaranteed 0% no-op. One of its four tools (`rehydrate_context` session path) contains a regex that **cannot match the marker format the product emits**. |

The project's own benchmark command, run today, prints:

```
Aggregate Token Reduction:  0.0%
Fallback Count & Rate:      4 (40.0%)
Syntax Pass Rate:           100.0%
Pass@1 Rate:                100.0%
```

…and the regression test suite that guards this passes.

**The single most important finding is C1**: a markdown document handed to the CLI is replaced in its entirety by a 72-byte marker, with `fallbackUsed: false`, `validation.passed: true`, and a drift score comfortably under the gate. On the CLI this is irreversible. This is precisely the failure mode `DriftReport.measurementGate`'s own doc comment says the two-gate split was introduced to prevent — the split shipped, and neither gate catches it.

---

## 2. Findings by severity

### CRITICAL

---

#### C1 — A markdown document is deleted whole, and every gate reports green

**Severity: Critical (silent, irreversible data loss on the primary entry mode)**

**Location:** `src/core/ledger/drift-tracker.ts:203-246`, interacting with `collectMarkers` (`:446`) and `findUnwitnessedItems` (`:290`).

**What happens.** For any markdown item, `compression:token-hashing` replaces the entire content with a marker, and the drift gate passes it.

Measured, on the file route:

```
input  : 1415 bytes (3 headings + prose)
output :   72 bytes  →  [TokenDamper: 12 markdown lines elided, 1415 bytes, sha256:649fd90e9a55]
fallbackUsed : false
validation.passed : true
issues : info:AST_VALIDATION_SKIPPED
S_k = 0.3000   R_AST = 1.0   R_struct = 0.2500   gates: pass / pass
```

**Why it passes.** `S_k = 1 − (0.6·R_AST + 0.4·R_struct)`.

- `R_AST = 1.0` is the **empty-set default**. Prose has no symbols; `astMeasured: false`. 60% of the metric contributes a free 0.60 to the retention score.
- `R_struct = 1/(N+1)` where N is the heading count — because `collectMarkers` adds a `filepath:` marker derived from `item.path`, and *no content transform can destroy it*. The one marker that survives is the one that was never at risk.
- Therefore `S_k = 0.6·0 + 0.4·(N/(N+1)) = 0.4·N/(N+1)`, which **approaches 0.40 from below and never reaches it**, for any N.
- The gate is `driftScore > this.maxDriftThreshold` (strict `>`, threshold 0.40). **It can never fire for markdown.**

Confirmed across heading counts:

| Document | Result | S_k | Fallback |
|---|---|---|---|
| 1 heading, with path | 327 B → 70 B | 0.2000 | false |
| 3 headings, with path | 983 B → 71 B | 0.3000 | false |
| 50 headings, with path | 16,439 B → 74 B | 0.3922 | false |
| Same, no path (stdin) | 16,439 B → 16,439 B | 0.0000 | **true** |
| Plain prose, no headings | 1,872 B → 1,872 B | 0.0000 | **true** |

**The safety property is inverted.** Unstructured prose is protected (no content markers → measurement gate refuses). A document *with* structure is destroyed. The more headings a document has, the closer to the gate it gets — and it never crosses it. A real runbook with a bullet list is deleted on both the file route and the stdin route:

```
$ tokendamper optimize runbook.md --target-reduction-ratio 0.5
[TokenDamper: 13 markdown lines elided, 330 bytes, sha256:200bf2683331]

$ cat runbook.md | tokendamper optimize - --language markdown --target-reduction-ratio 0.5
[TokenDamper: 13 markdown lines elided, 330 bytes, sha256:200bf2683331]
```

**On the CLI this is unrecoverable.** `runTokenHashingStage` receives no `TokenHasher` from the CLI (documented and deliberate, `token-hashing.ts:33-50`), so `metadata.reversible: false` and the removed bytes exist nowhere. The marker's 12-hex-character digest resolves to nothing.

**The accidental protection.** This repository's own `README.md` survives — not by design, but because it contains the words "never", "must" and "do not", which trip `CONSTRAINT_DIRECTIVE_LOST` (see H6). Whether a user's document survives depends on whether they happened to write an imperative sentence in it.

**Why the existing machinery misses it.** The `DriftReport.measurementGate` doc comment (`drift-tracker.ts:111-125`) names this exact configuration:

> `0.400` is reachable from two structurally opposite configurations: `R_AST = 1` as an empty-set default with `R_struct = 0` (nothing measured, everything destroyed) …

The gates were split to separate those. But `findUnwitnessedItems` asks *"did evidence exist before?"*, not *"did any of it survive?"* — so an item with three headings before and zero after is "witnessed" and exempt. And the retention gate's `>` comparison means the boundary value is a pass. Both halves of the fix aim at the case, and the case walks between them.

**Direction.** The measurement gate is asking the wrong question. It should refuse when an item changed and the *surviving* witness set for that item is empty — i.e. per-item `R_struct_content = 0` with `astMeasured: false` is a refusal regardless of what the before-set held. Separately, `filepath:` should not be counted in `R_struct` at all; `extractContentMarkers` already exists for exactly this distinction and is used only for reporting.

---

#### C2 — The Gateway corrupts non-ASCII request bodies before forwarding them upstream

**Severity: Critical (silent corruption of live provider traffic; violates invariant 3 on the only path that carries it)**

**Location:** `src/gateway/server.ts:102-112`

```js
let body = '';
req.on('data', (chunk) => {
  body += chunk;          // <-- Buffer implicitly .toString('utf8') per chunk
```

Each chunk is decoded independently. A multi-byte UTF-8 sequence split across a TCP/stream chunk boundary becomes two U+FFFD replacement characters. Node chunks at ~64 KB by default, so on any body large enough to be chunked — which is every non-trivial agent payload — this occurs by chance, and deterministically for a body split at the wrong offset.

**Reproduced** by writing a 89-byte body in two writes with the split inside `é`:

```
sent bytes: 89 | response body: {"model":"m","messages":[{"role":"user","content":"h��llo — ünïcode ✓ 日本語"}]}
byte-identical to input?  false
```

Nothing was elided on this turn (turn 1, empty `previousBlockHashes`). The corruption happens at the socket, before the pipeline exists, and the corrupted string is what is forwarded to the provider.

**This is the same defect class the project just closed in the CLI.** Phase B (DECISIONS §35, commit `f93c385`) rewrote `src/cli/main.ts` to read a `Buffer` and keep it, on exactly this reasoning:

> `rawInput` is a *decoded string*, so `readFileSync(path, 'utf8')` turned invalid bytes into U+FFFD before any stage ran

The fix was applied to the one adapter that reads from disk and not to the one that reads from a socket. The CLI now guarantees byte-identity (measured 4/4 below); the Gateway silently does not.

**Blast radius.** Accented names, curly quotes, em-dashes, emoji, CJK, box-drawing characters in captured terminal output — all common in coding-agent traffic. The user sees no error; the model receives mangled input.

**Direction.** Accumulate `Buffer[]`, `Buffer.concat` on `end`, decode once. Then apply the CLI's own round-trip check (`Buffer.from(str,'utf8').equals(buf)`) and force the fail-open path if it fails.

---

#### C3 — `tokendamper exec` returns 401 to every request the child process makes

**Severity: Critical (the flagship integration is non-functional end-to-end)**

**Location:** `src/gateway/exec.ts:33-58` vs `src/gateway/server.ts:85-100`

`runExecCommand` generates a per-run token and puts it in the child's environment:

```js
const gatewayToken = randomBytes(16).toString('hex');
const server = new GatewayServer({ port: options.port ?? 0, gatewayToken });
...
env.TOKENDAMPER_GATEWAY_TOKEN = gatewayToken;
env.OPENAI_BASE_URL = `${gatewayUrl}/v1`;
env.ANTHROPIC_BASE_URL = `${gatewayUrl}`;
```

The server then requires that token on **every** non-`/health` request, as an `x-tokendamper-token` header or a `?token=` query parameter.

The child process is `aider`, `claude`, `codex`, `curl` — third-party software that has never heard of `TOKENDAMPER_GATEWAY_TOKEN`. It sends `Authorization`/`x-api-key` and nothing else. There is **no code anywhere in `src/` that reads `TOKENDAMPER_GATEWAY_TOKEN`** (verified by grep — it is written in `exec.ts` and read nowhere), and the base URLs carry no `?token=`.

**Reproduced:**

```
exec-style request WITHOUT x-tokendamper-token -> 401 {"error":"Unauthorized: Invalid or missing gateway token"}
```

The README documents this as the primary usage:

```bash
tokendamper exec -- aider --message "fix the bug"
```

**Secondary defect in the same function.** `exec.ts` also sets `HTTP_PROXY` and `HTTPS_PROXY` to the gateway URL. `GatewayServer` implements neither HTTP proxy semantics (absolute-form request URIs) nor the `connect` event required for `CONNECT` tunnelling. Any child that honours `HTTPS_PROXY` — which is most HTTP clients — will fail to reach the provider at all, in a way unrelated to the 401.

**Direction.** Either append `?token=` to the injected base URLs (works today, leaks the token into logs), or drop the token gate for loopback-bound servers and rely on the `127.0.0.1` bind, or stop setting `HTTP(S)_PROXY` and document base-URL interception as the only supported mechanism. Whichever is chosen, an end-to-end test that actually spawns a child and makes a request would have caught this.

---

#### C4 — Structured message content is flattened to a string, producing API-invalid payloads

**Severity: Critical when reached (currently masked by H1)**

**Location:** `src/gateway/proxy.ts:483` and `:540-556` (OpenAI), `:621` and `:666-682` (Anthropic)

Ingestion stringifies non-string content:

```js
const textContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
```

Egress writes the optimized item back as a **string**, regardless of the original shape:

```js
return { ...msg, content: updatedItem.content };
```

So a message whose content was `[{"type":"tool_result","tool_use_id":"toolu_01ABC","content":"…"}]` comes out as `content: "[TokenDamper Elided: ref=… bytes=… kind=conversation]"`. The Anthropic Messages API requires a `tool_use` block to be answered by a `tool_result` block carrying the matching `tool_use_id`; a plain string in that position is a `400 invalid_request_error`. The same shape breaks OpenAI multimodal content parts.

Tool-heavy traffic is the *entire* target market — "AI coding assistants" per the README's first line.

**Why this is not currently firing:** the drift gate rejects the elision first (H1), so the payload falls back unchanged. That is luck. Any relaxation of the drift gate — which the roadmap and several docs contemplate — turns this into live 400s.

**Two adjacent defects in the same mapping:**

- **Positional drift.** Items are built with `if (!msg) continue;` (`:481`, `:619`) but mapped back by `messages.map((msg, idx) => outcome.finalBundle.items[idx])`. A single falsy entry in `messages` shifts every subsequent item onto the wrong message. Invariant 9 explicitly relies on this mapping being positional; the `continue` breaks the precondition.
- **The Anthropic `system` item is never mapped back.** It is pushed as `items[0]` (`:602`) and `updatedMessages` starts at `itemOffset`. If the system item ever changed, the change is dropped from `finalBody` — while `optimizedTokens` (and therefore the reported `tokensSaved` and `dedupRatio`) still counts it as saved.

**Direction.** Carry the original content shape on the item (`metadata.contentShape`) and refuse to elide any item whose content was not a plain string, until a structure-preserving substitution exists. Build the item list with a stable index rather than a filtered push.

---

### HIGH

---

#### H1 — The Gateway saves nothing on realistic traffic

**Severity: High (the only mode on live traffic reduces 0%)**

**Measured** on a real `GatewayServer` over real sockets, two-turn conversations repeating identical content across turns:

| Scenario | Request bytes | Response bytes | Saved | `fallbackUsed` |
|---|---|---|---|---|
| Repeated prose | 664 | 664 | **0** | true |
| Repeated JSON tool result | 723 | 723 | **0** | true |
| Repeated TypeScript | 636 | 636 | **0** | true |

**Mechanism.** `cleanup:session-dedup` is the only stage the Gateway plans (invariant 8). It marks an elision `recoverable: true` **only when an intact copy survives elsewhere in the same outbound payload** (`session-dedup.ts:100`, DECISIONS §16). Cross-turn dedup of a *sole* copy — the ordinary case, and the entire premise of "cross-turn deduplication" — is `recoverable: false`, is therefore scored in full by `DriftTracker`, and exceeds the gate. Fallback. Every time.

The only case that saves anything is content duplicated **within a single request** *and* seen in a previous turn:

```
within-payload dup: in=1233B out=759B saved=474B  dedupRatio=0.431  fallbackUsed=false
```

`CLAUDE.md` records this honestly ("The Gateway keeps within-payload dedup and loses cross-turn sole-copy dedup"). What is not recorded is the magnitude: for ordinary conversation shapes the practical saving is **zero**, and the feature named in the README as "Cross-turn Session Deduplication" does not fire.

**This is a design conflict, not a bug.** Phase A correctly concluded that a marker the model cannot resolve is deletion, not reference. That conclusion is right. Its consequence is that the Gateway has no remaining transform. The honest resolution is either (a) implement provider-side resolvability — which does not exist — or (b) state that the Gateway is a metrics/pass-through shim today. Silence is the worst option, and it is the current one.

---

#### H2 — Three of nineteen languages can pass the pipeline

**Severity: High (advertised coverage vs. actual coverage)**

`isCodeExtension` (`constructors.ts:1081`) recognises 19 extensions. `DeclaredLanguage` offers 19 spellings. Measured end-to-end, at `targetReductionRatio: 0.5`, one file per language, identical body shape:

| Language | in → out (tokens) | Reduction | Fallback | Reason |
|---|---|---|---|---|
| TypeScript | 336 → 65 | **80.7%** | false | — |
| JavaScript | 324 → 53 | **83.6%** | false | — |
| Python | 339 → 53 | **84.4%** | false | — |
| Markdown | 523 → 19 | **96.4%** | false | ← **this is C1, not a feature** |
| Go | 324 → 324 | 0.0% | true | `SEMANTIC_DRIFT_UNMEASURABLE` |
| Rust | 327 → 327 | 0.0% | true | `SEMANTIC_DRIFT_UNMEASURABLE` |
| C | 324 → 324 | 0.0% | true | `SEMANTIC_DRIFT_UNMEASURABLE` |
| C++ | 324 → 324 | 0.0% | true | `SEMANTIC_DRIFT_UNMEASURABLE` |
| Java | 332 → 332 | 0.0% | true | `SEMANTIC_DRIFT_EXCEEDED` |
| Shell | 318 → 318 | 0.0% | true | `SEMANTIC_DRIFT_UNMEASURABLE` |
| SQL | 184 → 184 | 0.0% | true | `SEMANTIC_DRIFT_UNMEASURABLE` |
| CSS | 311 → 311 | 0.0% | true | `SEMANTIC_DRIFT_UNMEASURABLE` |
| JSON | 728 → 728 | 0.0% | true | `SEMANTIC_DRIFT_EXCEEDED` |

**Two independent gates produce this, and both are single-language-family:**

1. `selectElisionRegions` (`regions.ts:365`) returns `[]` unless `selectValidator(item).language` is `typescript` or `python`. Everything else can only be elided whole.
2. `DriftTracker.extractSymbols` (`drift-tracker.ts:329`) is eight regexes covering JS/TS declarations, Python `def`/`class`/`import`, and JSON keys. A Go `func`, a Rust `fn`, a C function, a shell function, a SQL statement, a CSS rule — none of them yield a single symbol. So `astMeasured: false`, and a whole-item elision is by definition unwitnessed → refused.

The result is structural: **for 12 of 19 recognised extensions, the pipeline cannot produce a non-zero reduction under any flag combination.** This is not tunable via `--max-drift` (verified: `--max-drift 0.99` on a fallback file still returns it unchanged, because the measurement gate is not threshold-controlled).

**Note on the in-flight Phase C change.** The uncommitted `CONTENT_TYPE_VALIDATORS.code = null` is the right call — a TypeScript lexer's verdict on Perl is noise, and the comment quantifies it (perl 39/40 false positives). But it does not widen coverage; it only stops manufacturing false failures. The languages above were already at 0%.

---

#### H3 — The regression suite passes while the product's own benchmark reports 0%

**Severity: High (the guardrail is structurally incapable of detecting total failure)**

Run the shipped command:

```
$ tokendamper bench --target-reduction-ratio 0.5
Aggregate Token Reduction:  0.0%
Fallback Count & Rate:      4 (40.0%)
Syntax Pass Rate:           100.0%
Pass@1 Rate:                100.0%
Total Validation Issues:    4
```

Now run the regression suite that is supposed to guard it — it passes. Per-fixture measurement explains why:

```
humaneval  trr=0.3  n=5  avgReduction=0.00%  fallbackRate=0.0
humaneval  trr=0.5  n=5  avgReduction=0.00%  fallbackRate=0.0
codexglue  trr=0.3  n=5  avgReduction=0.00%  fallbackRate=0.8
codexglue  trr=0.5  n=5  avgReduction=0.00%  fallbackRate=0.8
```

And the tests:

- **`baseline.json` sets `minTokenReductionRatio: 0.40`.** But **Test 2 does not use the shipped fixtures.** It constructs a private two-fixture set inline (`bench.test.ts:91-145`) with `maxInputTokens: 50` — an artificially tiny budget on two hand-written Python functions — and asserts 40% against that. The real datasets are never checked for reduction.
- **`baseline.json` sets `maxFallbackRate: 0.0`.** **Test 3 runs only `humaneval`**, the one dataset where the fallback rate is 0 *because nothing happens*. `codexglue`, at 0.8, would fail this assertion immediately. It is never run.
- **`syntaxPassRate` is 100%** with a 40% fallback rate, because syntax is evaluated on the emitted output, and the emitted output on fallback is the input. A metric that is 1.0 whenever the engine does nothing cannot distinguish success from inaction.

So the suite asserts a green number derived from a set the product does not ship, while never asserting anything about the set it does. This is the exact shape `CLAUDE.md` invariant 10 exists to prohibit — *"a green result from a check that never executed is worse than a red one — it has happened **nine** times in this project already."* This is the tenth, and it is in the regression baseline itself.

**Direction.** Point Test 2 and Test 3 at `loadBenchmarkFixtures()` (the combined set the CLI actually uses). Accept that they will fail. Set the thresholds to the measured truth and let them ratchet upward.

---

#### H4 — Four documented knobs have no effect on any output

**Severity: High (documented functionality that does not exist)**

Traced by grep for every read of each budget field outside constructors and config, then verified by execution:

| Knob | Documented as | Actually read by | Verified effect |
|---|---|---|---|
| `--target-reduction-ratio` | "target reduction ratio" | `planner/index.ts:40` — **only as `> 0`** | `0.01` and `0.99` produce **byte-identical output** (4,408 bytes both) |
| `--max-debt` / `TOKENDAMPER_MAX_DEBT` | "Fails validation if optimization debt exceeds this threshold" | `engine` → `DebtTracker` → `attemptAutomatedRehydration`, which returns immediately on `if (!hasher && !ledger)` — the CLI supplies neither | `--max-debt 1` (extreme) is **byte-identical** to the default |
| `--max-output-tokens` | budget flag | **nothing** | no effect |
| `--max-latency-ms` | budget flag | **nothing** | no effect |
| `riskTolerance` (flag + `TOKENDAMPER_RISK_TOLERANCE`) | README: "Sets optimization aggressiveness (`low`/`medium`/`high`)" | `cli/bench-table-renderer.ts:97` — **the table renderer only** | no effect on optimization |

`--target-reduction-ratio` is the one every doc and example uses. It is a boolean named like a dial: it decides *whether* the knapsack stage list runs, and nothing downstream reads its value. A user who sets `0.9` and gets 14% has no way to learn that the number was never consulted.

Additionally, on the CLI the debt subsystem is arithmetically inert even before the rehydration guard: with no ledger, `overallConfidence = 1.0` → `confidencePenalty = 0`; on turn 1, `turnAgePenalty = 0`; `elisionRatioPenalty` is capped at `0.35 × 100 = 35`. Maximum achievable `D_k` on the CLI is **35**, against a default threshold of **75**.

**Direction.** Either implement them or remove them. A flag that parses, validates its range, and is then discarded is the pattern DECISIONS §30 was written to eliminate — it was applied to *which command* accepts a flag, not to *whether the accepting command reads it*.

---

#### H5 — The architectural centerpiece is unreachable on every shipping path

**Severity: High (≈1,000 LOC of dead weight; invariant 6 is unimplemented in practice)**

`ARCHITECTURE.md`, `README.md` and `CLAUDE.md` all put a "Stateless 0/1 Knapsack Planner" at the centre of the diagram, and invariant 6 promises *"selection preserves pinned-prefix ordering and 1,024-token block boundaries"* as the differentiator against competitors.

The knapsack is not in the planner. `plan()` (`planner/index.ts:13-59`) ignores its `_stageCatalog` argument and returns a hardcoded four-element array. The actual solver lives in `pruning:topology-pruner`, which reaches `solve01Knapsack`, `applyCacheAwarePrefixLocking`, `scoreBundleTopology`, `buildDependencyGraph` and `inspectGitWorkspace`.

**That stage cannot prune anything on any shipping path:**

- `createContextBundle` produces **exactly one item** for CLI, MCP and bench (`constructors.ts:142`, `const items = freeze([item])`).
- `applyCacheAwarePrefixLocking` pins every item inside the first 1,024 tokens — so on a one-item bundle, item 0 is always `isPinned: true`.
- `solve01Knapsack` places pinned items outside the candidate set and always selects them.
- `itemsPruned === 0` → `changed: false`.

**Verified** with a 4,600-token file and `maxInputTokens: 10`:

```
pruner @ maxInputTokens=10 on 1-item bundle -> changed=false
notes="All items fit within token budget; no pruning required."
```

Note the note is **factually false** — 4,600 tokens do not fit in 10. It reports "no pruning required" for a case where pruning was impossible.

The only multi-item bundle producer in `src/` is `gateway/proxy.ts` (verified by grep), and the Gateway pins the planner to `session_dedup`, which never plans the pruner.

**Therefore:** `topology/git-inspector.ts`, `topology/dependency-graph.ts`, `topology/topology-scorer.ts`, `planner/knapsack.ts` and `planner/cache-aware.ts` — and with them the entire cache-alignment guarantee — have **no effect on any output the product can produce**. They are exercised only by unit tests that construct multi-item bundles via `createBundleFromItems`, a function no production code calls.

**Direction.** Either give the CLI a multi-item ingestion path (a directory, a manifest, a conversation file) so the knapsack has something to solve, or move it behind a clearly-labelled "not yet reachable" boundary. Right now the diagram describes an ambition and the docs describe it in the present tense.

---

#### H6 — A nine-word substring match is the dominant reason real code cannot be optimized

**Severity: High (the leading cause of the 62.5% zero-reduction rate)**

**Corpus:** the repository's own 64 tracked `src/**/*.ts` files, frozen at `f93c385`, `targetReductionRatio: 0.5`.

```
files = 64
aggregate reduction = 14.04%
mean per-file reduction = 15.80%
files that reduced = 22   |   files at exactly 0% = 42

fallback causes:
  CONSTRAINT_DIRECTIVE_LOST                          14
  CONSTRAINT_DIRECTIVE_LOST + SEMANTIC_DRIFT_EXCEEDED 10
  SEMANTIC_DRIFT_EXCEEDED                             11
  SEMANTIC_DRIFT_UNMEASURABLE                          5
```

**24 of 40 fallbacks (60%) involve `CONSTRAINT_DIRECTIVE_LOST.`**

The mechanism (`validation/index.ts:54-66` + `constraints/directives.ts:1-2`): every line of the *input* is scanned for

```
must | must not | never | always | only if | do not | required | except when | make sure to | critical
```

Each matching sentence-or-clause becomes a directive, and the check is a plain `afterContentCombined.includes(directive)` over the joined output. Elide a function body containing any of those words in a comment — or the identifier `required:` in a JSON-schema literal, a form validator, or a TypeScript type — and the whole pipeline falls back to 0%.

`src/adapters/mcp/tools.ts` contains `required: ['rawInput']`. `src/gateway/proxy.ts` contains `// DO NOT switch this to result.emittedOutput`. Both are unoptimizable, by their own comments.

**Two structural problems:**

1. **It is a bundle-wide substring check with no attribution.** A directive extracted from item A satisfies the check if the string appears anywhere in item B. And a directive lost anywhere fails the *entire* run — there is no per-item or per-stage rollback (this is the un-started Phase 1c).
2. **It cannot distinguish prose from code.** The keyword list is designed for natural-language system prompts. Applied to source, `required` and `critical` are ordinary identifiers.

**The interaction with C1 is the worst part.** This check is currently the *only* thing preventing markdown documents from being deleted — and it fires on whether the author happened to use one of nine words.

**Direction.** Scope directive extraction by content type (prose/markdown/prompt kinds only, not `code`), and make the retention check per-item rather than over the joined blob.

---

### MEDIUM

---

#### M1 — The "AST-lite validator" for TypeScript is a bracket matcher

**Location:** `src/core/validation/ast/ts-validator.ts`

It is a well-written lexer — it tracks strings, template interpolation, comments, and (unusually) regex literals with a considered `regexMayFollow` rule. But it builds no AST and detects exactly two error classes: unbalanced brackets and unterminated strings/comments.

Probed directly:

| Input | Verdict |
|---|---|
| `const x = ;` | **PASS** |
| `function f(a: , b) { return 1; }` | **PASS** |
| `import from "x";` | **PASS** |
| `let 123abc = 5;` | **PASS** |
| `const a = 1 +++++ 2;` | **PASS** |
| `ceci nest pas du code` (English prose) | **PASS** |
| `# heading\n\nSome markdown text.` | **PASS** |
| `super(; }` (unbalanced) | FAIL |

`PythonValidator` is meaningfully stronger (catches missing colons, malformed `def`, bad dedent, leading indentation) but also passes plain English prose. `JsonValidator` is a real parser and is correct.

**Consequence.** The product's headline differentiator — *"preserving syntax validity"* — means **"bracket and quote balance is preserved"** for TypeScript and JavaScript, which is the language family where the compression actually runs. The code is honest about this internally (`elision/index.ts:110-117`: *"the TypeScript and Python AST-lite validators both accept a bare marker … placeholder injection into TypeScript or Python content would NOT be caught"*). The user-facing docs are not.

**Direction.** Say "bracket/quote integrity", not "syntax validity". The real fix — wiring the actual TypeScript compiler API, which is already a transitive dependency — is a much larger change and probably conflicts with the 5 ms latency posture.

---

#### M2 — The working tree is red and half-migrated

**Severity: Medium (process)**

`src/core/validation/ast/index.ts` is modified but uncommitted, setting `CONTENT_TYPE_VALIDATORS.code = null`. As a result:

- **Two tests fail** (`npm test`: 479 passed, **2 failed**, 54 files):
  - `test/unit/declared-language.test.ts:128` — *"pins why the two fields must move together: contentType alone picks TypeScript"*
  - `test/unit/bench/evaluator.test.ts:151` — *"dispatches on language, which is why the tag change moves no benchmark number"*

  Both are deliberate **hazard-pinning** tests that assert the old behaviour as a recorded trap. The change removes the trap; the tests were not updated. CI (`npm test` on push/PR to `main`) would block this.
- **`dist/` is stale** — it still contains `code: tsValidator`. Anyone running `npm start` or the installed `tokendamper` binary gets the old behaviour while the source says otherwise.
- **The change contradicts live doc comments in three places** that were not updated:
  - `constructors.ts:90-92` — *"Setting only `contentType: 'code'` is worse: `CONTENT_TYPE_VALIDATORS.code` maps to the **TypeScript** validator"*
  - `constructors.ts:650-654` — *"`CONTENT_TYPE_VALIDATORS.code` is the TypeScript validator, so Rust is bracket-checked as TypeScript either way … pinned in `test/unit/declared-language.test.ts`"*
  - `docs/phase-4b-pathless-code-scope.md` §6.3, referenced by the now-failing test

The change itself is correct (see H2). The migration is incomplete.

---

#### M3 — The published license is wrong

**Severity: Medium (legal)**

| Source | States |
|---|---|
| `package.json` `"license"` | **MIT** |
| `LICENSE` (373 lines) | **Mozilla Public License Version 2.0** |
| `README.md` | "TokenDamper is now licensed under the Mozilla Public License 2.0 (MPL-2.0)" |
| `CLAUDE.md` | "TypeScript, CommonJS, Node >=18, **MIT**" |

`package.json` is `"private": false` with a `files` array and a `prepublishOnly` script — it is meant to be published. npm surfaces the `license` field as the authoritative signal; consumers and license scanners will read **MIT** and receive **MPL-2.0** copyleft obligations (file-level source disclosure on modification).

The README also carries "Copyright (c) 2026 Ojas Sugur. **All rights reserved.**" directly above an open-source license grant, which is at best confusing.

**Direction.** Pick one. If MPL-2.0, set `"license": "MPL-2.0"` in `package.json`, fix `CLAUDE.md`, and drop "All rights reserved". Note that the change from MIT to MPL is itself worth recording in `DECISIONS.md`, which does not mention it.

---

#### M4 — The README is materially wrong in both directions

**Severity: Medium**

**Understates (stale warning, now false):**

> **Gateway proxy limitation:** The local Gateway HTTP proxy mode … currently bypasses TokenDamper's validation pipeline. It does not run AST/syntax validation, semantic-drift checking, the confidence ledger, or the fail-open fallback path. The trace field `fallbackUsed` is hardcoded `false` on this path.

This was fixed in Phase 1.0b. Verified: `runGatewayOptimization` routes through `core/engine.optimize()`, and I observed `fallbackUsed: true` computed on live requests. The warning has survived its own fix and now defames the product.

**Overstates (never was true, or no longer is):**

- *"Reversible Token Hashing: Safely elides repetitive files by injecting `<BLOCK_HASH>` placeholders, **recovering them transparently**"* — irreversible on the CLI by design (`token-hashing.ts:33-50`), and the `<BLOCK_HASH>` format is no longer what is emitted.
- *"0/1 Knapsack Planning: … optimally packs them under strict token budgets"* — unreachable (H5).
- *"Cross-turn Session Deduplication"* — measured 0 bytes saved (H1).
- *"`TOKENDAMPER_RISK_TOLERANCE` — Sets optimization aggressiveness"* — no effect (H4).
- *"`TOKENDAMPER_GATEWAY_TOKEN` — Auth token for gateway proxy requests"* — never read by anything (C3).
- The architecture diagram's note *"the AST Validators and Explicit Fallback steps run in CLI and MCP modes. Gateway mode does not execute them"* — false since Phase 1.0b.

---

#### M5 — Two MCP defects: no budget parameter, and a rehydration regex that cannot match

**Location:** `src/adapters/mcp/tools.ts:17-102`, `:202-220`

**(a) `optimize_context` has no reduction-budget parameter.** Its `inputSchema` exposes `rawInput`, `language`, `path`, `maxInputTokens`, `riskTolerance`, `preserveKinds`. There is **no `targetReductionRatio`**, and `riskTolerance` does nothing (H4). Default config ships `targetReductionRatio: 0` and no `maxInputTokens`, so:

```
no budget: planMode=pass_through  stages=0  reduction=0.00%
```

An MCP client calling the tool as documented — with only `rawInput` — gets a guaranteed 0% no-op that reports `reductionRatio: 0` and no error. The tool description says "Compress and optimize prompt context using TokenDamper pipeline". Nothing tells the caller that a budget is mandatory. `CLAUDE.md` flags this trap for humans (*"This is not a bug; it has repeatedly been mistaken for one"*) but the tool schema does not flag it for machines.

**(b) `rehydrate_context`'s session path is dead code.** It looks for:

```js
const elisionRefPattern = /<ELIDED:\s*ref=([A-Za-z0-9_-]+)[^>]*>/g;
```

`cleanup:session-dedup` emits (`session-dedup.ts:103`):

```js
`[TokenDamper Elided: ref=${refId} bytes=${originalLength} kind=${item.kind}]`
```

Square brackets and a different literal prefix. The regex **cannot match any marker the product produces**. Session-store rehydration through MCP has never worked and cannot.

**Minor, same file:** `traceStore` is a module-level `Map` shared across all server instances in a process; `get_session_metrics` and `resources/read` call `getOrCreateSession`, so *reading* creates state; `MCP_PROTOCOL_VERSION` is pinned to `2024-11-05` and `initialize` returns it unconditionally rather than negotiating against the client's requested version.

---

#### M6 — The explainability trace does not explain

**Location:** `src/core/trace/index.ts:24-29`

```js
const stageTraces = stageResults.map((stage) => ({
  stageId: stage.stageId,
  status: stage.status,
  durationMs: 0,        // <-- always
  changed: stage.changed,
}));
```

Every stage reports `durationMs: 0`. Every stage's `metrics` (`itemsHashed`, `bytesSaved`, `regionsHashed`, `irreversibleElisions`, `skippedPostConditionRejected`) and every stage's `notes` are **discarded**. The stages compute rich, carefully-designed telemetry and the trace throws all of it away.

So a user reading the trace can see *that* `compression:token-hashing` ran and changed something, but not what it did, how much it removed, whether the elisions were reversible, or how long anything took. The `--diff` and `--diff-html` reporters partially compensate for the CLI; the MCP `get_optimization_trace` tool and the Gateway have nothing else.

Combined with the `topology-pruner`'s false "All items fit within token budget" note (H5), the trace is currently the least trustworthy surface in the system — which is a problem for a product whose thesis is auditability.

---

#### M7 — Gateway savings are measured against an abstraction, not against the bytes sent

**Location:** `src/gateway/proxy.ts:390-412`, `:551-556`

`rawTokens` and `optimizedTokens` come from `initialBundle.summary.tokenEstimate` and `finalBundle.summary.tokenEstimate` — the newline-joined item render. The bytes actually forwarded are:

```js
finalBody = JSON.stringify({ ...parsedPayload, messages: updatedMessages });
```

Three consequences:

1. **Re-serialization mutates the client's request.** Pretty-printing is lost, numeric literals are normalized (`1.0` → `1`, `1e3` → `1000`), integers beyond 2⁵³ lose precision, and duplicate keys collapse. This is the *exact* mechanism the project identified as the source of the phantom "-1.39%" in the Python harness (`run_benchmark.py:75-77`) — reproduced here in production code.
2. **JSON structural overhead is invisible.** Savings are computed over content strings; the payload also carries `model`, `system`, role wrappers and escaping.
3. **Nothing asserts `finalBody.length <= rawBody.length`.** Combined with the un-mapped Anthropic `system` item (C4), `tokensSaved` can be non-zero for content that was not removed from the wire.

---

#### M8 — Two environment branches in production code suppress forwarding and auth

**Location:** `src/gateway/proxy.ts:61-74`, `:90-103`, `:204-206`

```js
if (optimized.statusCode !== 200 || shouldUseMockUpstream()) { return optimized; }
if (!hasAuthHeaders(cleanHeaders)) {
  if (process.env.NODE_ENV === 'test') { return optimized; }
  return 401;
}
```

- `TOKENDAMPER_MOCK_UPSTREAM=true` makes the proxy return the optimized request body **as if it were the provider's response**, with a 200. Set in the wrong environment, an agent receives its own prompt back as a completion.
- `NODE_ENV === 'test'` bypasses the missing-credentials 401. `NODE_ENV=test` is set by a great many CI systems and some process managers.

Neither is documented. Test seams belong in injected options (`ProxyHandlerOptions` already exists and already carries `upstreamOpenAiUrl`), not in ambient environment reads inside the request path.

---

#### M9 — Request headers, including credentials, are returned as response headers

**Location:** `src/gateway/proxy.ts:570-575`, `:696-701`, reached via `server.ts:142`

```js
return { statusCode: 200, headers: { ...headers, 'content-type': 'application/json' }, body: finalBody, session };
```

`headers` is `cleanHeaders`, which strips only `host` and `content-length` — `authorization` and `x-api-key` are retained. `writeProxyResult` writes them out with `res.writeHead(result.statusCode, result.headers)`.

**Reproduced** (mock-upstream mode): the response carried `x-api-key: sk-test`.

Today this is only reachable via `TOKENDAMPER_MOCK_UPSTREAM` (M8), because the normal path replaces these headers with the upstream response's. That makes it a latent leak rather than a live one — but it is one env var away, and the fix is to construct response headers explicitly rather than by spreading the request's.

---

#### M10 — The published `bench` command fails outside the repository

**Location:** `src/bench/fixtures/humaneval.ts` (and `codexglue.ts`), `DEFAULT_HUMANEVAL_PATH = 'test/fixtures/bench/humaneval-subset.json'`

The path is resolved against `process.cwd()`. `test/` is not in `package.json`'s `files` array, so it is not published. Reproduced by running from any other directory:

```
Error: HumanEval dataset file not found at test/fixtures/bench/humaneval-subset.json
```

`tokendamper bench` — a documented top-level command — throws for every installed user.

---

#### M11 — 4.1 : 1 documentation-to-code ratio, with internal contradictions

**Severity: Medium (process risk)**

```
markdown (root + docs/):  527,849 bytes
TypeScript (src/):        127,452 bytes
```

`DECISIONS.md` is 104 KB. `CHANGELOG.md` is 56 KB. `NOTES-FOR-DOCS.md` is 39 KB. `CLAUDE.md` is 26 KB and contains a nested sub-outline of its own §33/§34 argument.

The prose is high quality — genuinely better reasoning than most codebases contain. But at this volume it has become a second system requiring its own maintenance, and it is already inconsistent with itself: README vs CLAUDE.md on the Gateway, README vs LICENSE on licensing, `constructors.ts` comments vs the working tree on validator dispatch, `CLAUDE.md`'s "19.27% with `--language`" vs today's measured 14.04%.

A concrete symptom: `CLAUDE.md` contains a standing note reading *"Version is reconciled at 1.1.0 — **closed 2026-08-04, stop re-listing it**"* — a note whose existence is itself the problem it describes. Two files (`study.md`, `purposed architecture changes.md`) are tracked planning artifacts in the repository root.

**Direction.** The invariants and the measured baselines earn their place. The narrative argument for each superseded phase does not — it belongs in the commit that made the change, where git already keeps it.

---

### LOW

| # | Finding | Location |
|---|---|---|
| L1 | `parsePlannerMode` accepts only `'pass_through'` from the environment; `TOKENDAMPER_PLANNER_MODE=session_dedup` is silently ignored, while the equivalent CLI flag throws. Inconsistent with DECISIONS §30. | `config/load.ts:191` |
| L2 | Gateway token compared with `!==` (not constant-time) and accepted via `?token=` query string, which lands in access logs and shell history. | `gateway/server.ts:85-100` |
| L3 | `Buffer.byteLength(body, 'utf8')` is recomputed over the whole accumulated string on every chunk — O(n²) on large bodies. Moot once C2's Buffer fix lands. | `gateway/server.ts:107` |
| L4 | `constraint-preservation` recomputes `contentHash` as `hashContent({...item, metadata})`, which folds the *previous* hash in. After this stage, `item.contentHash` is no longer a hash of `item.content` — an invariant several other modules implicitly assume. | `stages/cleanup/constraint-preservation.ts:63-66` |
| L5 | `ConfidenceLedger` stores each record under both `itemId` and `blockHash` in one `Map`, so a collision between one item's id and another's block hash silently overwrites. `getOverallConfidence` returns the **minimum**, not an aggregate, despite the name and doc comment. | `ledger/confidence-ledger.ts:69-70`, `:112-126` |
| L6 | `solveKnapsackGreedy`'s "Branch & Bound heuristic check" is a single best-single-item comparison — neither branch-and-bound nor a bound. The DP reconstruction itself is correct (verified by inspection). | `planner/knapsack.ts:100-114` |
| L7 | `scanPythonDefBodies` computes `bodyIndent` from `lineAt(i+1)`; when the first body line is blank the indent is 0, the marker lands at column 0, and `PythonValidator` rejects it. Fails safe (skip) but silently loses the region. | `elision/regions.ts:~317` |
| L8 | `TypeScriptValidator` advances `i += 2` on escapes without incrementing `line`, so reported line numbers drift in files with escaped newlines. Cosmetic. | `validation/ast/ts-validator.ts:153,172` |
| L9 | `renderElisionMarker` embeds only a 12-hex-character digest prefix. `TokenHasher.resolve` handles prefix collisions correctly (resolves to nothing), but at 48 bits a busy session store has a birthday-bound collision probability that makes silent non-resolution more likely than the comment's "48 bits is ample" implies for the *identity* use. | `elision/marker.ts:11`, `hashing/token-hasher.ts:172-182` |

---

## 3. Cross-cutting themes

### 3.1 The safety gates are correct in isolation and wrong in composition

Each gate is defensible on its own terms. Together they produce a distribution with a large mass at exactly zero. On the 64-file corpus: **42 files at exactly 0.0%**, and the 22 that reduce spread across **5.6% – 77.6%** (median ≈ 44%). There is no gradual response to pressure — a file either survives every gate and gets most of its function bodies removed, or it trips one gate and reverts entirely.

That is not a tuning problem. It follows from three whole-item decisions:

- `createContextBundle` makes a **one-item bundle**, so `R_AST` is close to a boolean.
- The constraint check is **bundle-wide substring matching** with no attribution.
- The fallback is **all-or-nothing** (per-stage checkpointing, Phase 1c, is not started).

Any one failure anywhere reverts the entire run. The design docs identify all three; none is fixed.

### 3.2 `R_struct` does 40% of the arithmetic and none of the work

This is the load-bearing defect behind C1, and DECISIONS §18 already names it. For code, the only marker is `filepath:`, taken from `item.path`, which elision cannot touch — so `R_struct = 1.0` pinned, contributing a free 0.40. For markdown, `filepath:` is one survivor among N+1, so `R_struct = 1/(N+1)` and the *total* is still bounded below the gate.

Consequences that follow directly from the arithmetic:

- **For code:** the maximum symbol loss that can pass is `1 − 0.40/0.60 = 66.7%`. You can destroy two-thirds of every symbol in a file and pass. Observed live: `src/core/engine/index.ts` reduced 76% at `S_k = 0.3934`, i.e. `R_AST = 0.344` — **65.6% of its symbols destroyed**, gate passed.
- **For markdown:** whole-document deletion is *always* under the gate (C1).

`extractContentMarkers` already exists and already excludes `filepath:`. It is used only for the `structMeasured` boolean. Using it in `R_struct` would fix both cases at once — and would move every published number, which is presumably why it has not been done.

### 3.3 Invariant 10 is being applied to the code but not to the product

`CLAUDE.md` invariant 10 — *"When a check passes, confirm it ran"* — is enforced with real rigour inside the engine: `AstValidatorResult.validated`, `trace.astCoverage`, `trace.driftCoverage`, `measurementGate`/`retentionGate`. This is genuinely good work and it is unusual.

The same discipline is not applied one level up:

- `syntaxPassRate: 100%` alongside a 40% fallback rate (H3) — a metric that is 1.0 whenever nothing runs.
- The regression suite's reduction assertion measures a fixture set the product does not ship (H3).
- `--target-reduction-ratio` accepts, validates and discards its value (H4).
- The trace reports `durationMs: 0` for every stage (M6).

Every one of these is a green signal from something that did not happen — the exact pattern the invariant exists to prohibit.

### 3.4 Byte-level fidelity was fixed on one adapter and not audited on the others

Phase B's reasoning — *"`rawInput` is a decoded string; the evidence is gone by the time a request exists"* — is correct and generalizes. It was applied to the CLI. The Gateway has the identical defect at the socket (C2) and it is worse there, because the corrupted bytes are forwarded to a provider rather than printed to a terminal. The MCP transport (`server.ts:52`, `this.input.setEncoding('utf8')`) is safe, because Node's `StringDecoder` holds partial sequences across chunks — the Gateway's manual `body += chunk` is precisely what bypasses that.

---

## 4. What is genuinely good

An audit that lists only defects is not an audit. These are real and should be protected:

1. **Determinism holds.** Identical input produced byte-identical output across repeated runs (verified). No `Math.random` or `Date.now` in any stage or validator. Module-level `/g` regexes are correctly re-instantiated at every use site rather than shared (checked all four).
2. **Fail-open byte-identity holds on the CLI.** All fallback outputs were byte-identical to input across the corpus (4/4 spot-checked with `Buffer.compare`, plus the corpus run). The Phase B `Buffer` fix is correct and well-reasoned.
3. **The elision chokepoint is a good design.** Routing all three eliding stages through `elideItem`/`elideRegions`, resolving syntax from the *same* `selectValidator` the checker will use, is correct-by-construction rather than check-after-the-fact. The doc comment is scrupulous about which of the two mechanisms is load-bearing.
4. **Region-based elision genuinely works.** On TypeScript/JavaScript/Python it produces valid, useful output: imports, signatures, types and doc comments retained; bodies replaced by a self-describing marker. The `scanBraceSpans` regex-literal tracking, the `FUNCTION_HEADER` shape test that deliberately excludes class bodies, and the byte-exact region boundary rule (found by measurement, not reasoning) are all careful work.
5. **`isSubstantiveRegion` is an unusually honest guard.** It defends against the measured `HumanEval/0` docstring case and its own comment says so: *"it defends against **that case**, not against the class."*
6. **The test suite is substantial** — 11,153 lines, 481 tests, 54 files, including property/fuzz and stress suites. `typecheck` and `lint` are clean under `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. The problem is what the tests point at (H3), not their construction.
7. **The in-source commentary is exceptional.** Comments explain *why*, cite measurements, retract superseded claims by name, and mark non-firing code as non-firing. `token-hashing.ts:33-50` and `elision/index.ts:96-126` are models of the form.

---

## 5. Recommended order of work

Ordered by (harm prevented) ÷ (effort), not by severity alone.

**Stop the bleeding — days**

1. **C1** — fix the drift measurement gate to require a *surviving* witness, and drop `filepath:` from `R_struct`. This is the only finding that silently destroys user data.
2. **C2** — accumulate `Buffer[]` in `gateway/server.ts`; apply the CLI's round-trip check.
3. **M3** — set `package.json` `"license": "MPL-2.0"`.
4. **M2** — finish or revert Phase C: update the two hazard tests, the three stale doc comments, and rebuild `dist/`.
5. **M4** — delete the stale Gateway warning from the README; remove or qualify the four feature claims that are not true.

**Make the guardrails able to fail — days**

6. **H3** — point bench Tests 2 and 3 at the shipped fixture set. Let them fail. Record the real numbers as the baseline.
7. **M6** — carry stage `metrics` and `notes` into the trace; measure `durationMs`; fix the pruner's false "All items fit" note.
8. **H4** — either implement `targetReductionRatio` as a real target, or rename it and remove `--max-debt`, `--max-output-tokens`, `--max-latency-ms` and `riskTolerance` from the surface.

**Decide what the product is — weeks**

9. **C3 / H1** — the Gateway is the differentiated integration and it currently does nothing and cannot be started. Either fix the token handoff and find a transform that survives the gates, or label it experimental and stop leading the README with it.
10. **H6** — scope constraint extraction to prose content types; make retention per-item.
11. **H5** — give the CLI a multi-item ingestion path so the knapsack has a job, or move it behind an explicit boundary.
12. **C4** — preserve content shape on Gateway items before any transform can reach structured messages.

**Reconsider — as a decision, not a task**

13. **H2** — three languages is a defensible v1 scope. Nineteen in `isCodeExtension` and `DeclaredLanguage` is not, because it invites users to declare a language and receive a silent 0%. Either narrow the accepted set to what works, or make the pipeline report *why* a declared language cannot be optimized instead of falling back mutely.
14. **M11** — retire the phase narratives to git history; keep invariants and measured baselines.

---

## Appendix A — Reproduction

All commands run from the repository root, against a scratch build (`npx tsc -p tsconfig.json --outDir <scratch>/build --declaration false --sourceMap false`, exit 0).

**C1 — markdown deletion**
```bash
printf '# Runbook\n\nSteps when the queue backs up:\n\n- Check the lag dashboard at https://internal/dash\n- Scale the consumer group to 12 workers\n- Verify the DLQ is draining\n\n## Escalation\n\nPage the platform on-call if lag exceeds 30 minutes.\n' > rb.md
node <scratch>/build/src/cli/main.js optimize rb.md --target-reduction-ratio 0.5
# -> [TokenDamper: 13 markdown lines elided, 330 bytes, sha256:200bf2683331]
```

**C2 — Gateway UTF-8 corruption** — POST a body in two `req.write()` calls split inside a multi-byte character; compare the echoed body to the sent bytes with `Buffer.compare`.

**C3 — exec 401**
```js
const s = new GatewayServer({ port: 0, gatewayToken: 'abc123' }); await s.start();
await fetch(`http://127.0.0.1:${s.port}/v1/messages`, { method:'POST',
  headers:{'content-type':'application/json','x-api-key':'sk-test'}, body:'{"model":"m","messages":[]}' });
// -> 401
```

**H1 — Gateway savings** — two-turn conversation, identical content in both turns, inspect `sessionStore.getOrCreateSession(id).turns.at(-1)`.

**H2 — language matrix** — one file per extension, identical body shape, `targetReductionRatio: 0.5`, read `trace.tokenBefore/tokenAfter` and `validation.issues`.

**H3 — bench**
```bash
node <scratch>/build/src/cli/main.js bench --target-reduction-ratio 0.5
```

**H4 — dead flags**
```bash
F=src/core/engine/index.ts
for r in 0.01 0.5 0.99; do node <scratch>/build/src/cli/main.js optimize $F --target-reduction-ratio $r > r_$r.out 2>/dev/null; done
cmp r_0.01.out r_0.99.out && echo IDENTICAL
```

**H6 — corpus** — `git ls-files 'src/**/*.ts'` copied to a scratch directory (64 files at `f93c385`), each run through `optimize()` at `targetReductionRatio: 0.5`, tallying `trace.tokenBefore/tokenAfter` and the error-severity issue codes on fallback.

**M1 — validator probes** — `new TypeScriptValidator().validate(src).valid` over the table in M1.

---

## Appendix B — Measured summary

| Metric | Value | Source |
|---|---|---|
| Source | 12,639 lines / 127,452 bytes, 64 files | `wc -l src/**/*.ts` |
| Tests | 11,153 lines, 481 tests, 54 files, **2 failing** | `npx vitest run` |
| Docs | 527,849 bytes markdown (**4.1:1** vs source) | `wc -c *.md docs/**/*.md` |
| Typecheck / lint | clean | `npm run typecheck`, `npm run lint` |
| CLI reduction, own TS corpus @ `trr=0.5` | **14.04%** aggregate, 15.80% mean | 64 frozen files @ `f93c385` |
| Files reducing 0% | **42 / 64 (65.6%)** | same |
| Leading fallback cause | `CONSTRAINT_DIRECTIVE_LOST` — 24 / 40 | same |
| Shipped bench, all fixtures | **0.0%** reduction, **40%** fallback, 100% "syntax pass" | `tokendamper bench` |
| Gateway, cross-turn dedup | **0 bytes saved**, 100% fallback | live HTTP, 3 content types |
| Gateway, within-payload dup | 474 bytes saved (43.1%) | live HTTP |
| Languages reaching non-zero reduction | **3** (+ markdown, which is C1) of 19 declared | language matrix |
| Determinism | byte-identical across repeats | ✅ |
| CLI fail-open byte-identity | byte-identical, 4/4 | ✅ |
