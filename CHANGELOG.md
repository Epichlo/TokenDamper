# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

Commits on `main` beyond the `v1.1.0` tag (`807f6f0`). Not yet tagged or released; run
`git log v1.1.0..HEAD` to confirm current scope before relying on this list.

### Added
- **Sub-item hashing granularity (DECISIONS §20)**: `compression:token-hashing` now elides
  **function bodies** within an item and keeps the declarations around them, falling back to
  whole-item hashing only where no region can be selected (prose, logs, JSON, truncated code).
  New: `core/elision.elideRegions` (chokepoint) and `core/elision/regions.selectElisionRegions`
  (selection + the docstring guard).

  Whole-item hashing could never succeed on a single-item code bundle — it replaces every
  byte, so `R_AST` was a boolean and `S_k` pinned at the formula constant `0.60`, over the
  `0.40` gate every time. For code the gate reduces exactly to **`R_AST ≥ 1/3`**.

  Measured over 52 real source files through the CLI: **22 reduce with no fallback, mean
  52.99%**, byte-identical output across fresh processes (6/6). `codebase.py`:
  16,937 → 11,360 bytes, 5,029 → 3,281 tokens, **34.76%**, no fallback.

  ~~every elision reversible through the existing recovery valve~~ — **withdrawn.** That
  sentence read as a property of the CLI run it was attached to, and it is not one. The
  reversibility measurement injected a `TokenHasher`; the CLI injects none, so the recovery
  valve returns at its first line (`if (!hasher && !ledger) return undefined`) and the
  emitted markers resolve to nothing. Measured on `codebase.py` through the real binary: 19
  placeholders emitted, **0** resolvable. See the `reversible` entry under Fixed.

  Remaining fallbacks are the safety net working, not failures: 17 on constraint-directive
  retention (an imperative comment inside an elided body), 11 on drift over `0.40`, 2 on the
  regex-literal validator defect noted below.

  **The bundled bench corpus stays at 0.00%, deliberately.** Five HumanEval fixtures are
  docstring-only prompts refused by the guard; four CodeXGLUE fixtures are truncated stubs
  with no complete body. It is a completion benchmark, not a compression corpus.

  The **docstring guard** is the Phase 1d precondition: `HumanEval/0` otherwise elides to
  55.66% at `S_k = 0.0000`, AST-valid and reversible, with the function's entire
  specification removed — drift cannot see it, because docstrings carry no symbols and
  `R_struct` is inert for code. The guard defends that case, **not the class**.

### Changed
- **Elision markers say what they replaced (DECISIONS §24)**: `compression:token-hashing`
  emitted `<BLOCK_HASH:` + a 64-character digest + `>`, which on the CLI resolved to nothing
  and therefore told its reader that *something* had been removed and nothing else. Both the
  sub-item and whole-item paths now emit
  `[TokenDamper: <N> <kind> lines elided, <B> bytes, sha256:<12 hex>]` through one shared
  renderer. In place of a function body a reader now gets:

  ```
      def __init__(self, failure_threshold: int = 5, recovery_timeout: float = 30.0):
          [TokenDamper: 5 function-body lines elided, 202 bytes, sha256:4af59ca48228]
  ```

  **It costs nothing in bytes** — `codebase.py` through the real CLI goes 16,937 → **11,328**
  where it went → 11,360 before, because a 12-character digest buys back more than the words
  cost. In tokens the two estimators disagree in *sign* on one real marker
  (`EnhancedHeuristicTokenizer` +1, `ceil(len / 4)` −1); a controlled A/B on a frozen 80-file
  corpus keeps the same 22 files with the same fallback causes and moves the mean over kept
  55.50% → 55.09%. That −0.41pp is the less accurate estimator's opinion (§19).

  `<BLOCK_HASH:…>` is still *read*, so text captured earlier still round-trips. `TokenHasher`
  resolves the truncated digest through a prefix index and refuses an ambiguous prefix rather
  than substituting the wrong content.

  Whole-item elision on prose and logs was proposed for removal as "compute that can only
  produce fallbacks". Measured, it is not: prose alone passes at `S_k = 0.00` saving 78.4%
  and a log tail 97.5%. The 16/16 prose failures in this repository are engineering documents
  dense with imperative directives, which is a property of the corpus. See §24.

### Fixed
- **`compression:token-hashing` no longer fabricates the store that makes it "reversible" (DECISIONS §25)**:
  line 23 was `options?.tokenHasher ?? new TokenHasher()`. That default registered every
  elided block into a store that was garbage-collected when the stage returned, so on the
  CLI — which supplies no hasher — the emitted `<BLOCK_HASH:…>` markers referred to content
  held by nothing. Measured on `codebase.py` through the real binary: 19 placeholders, **0**
  resolvable by any store in the process or out of it. The engine's own
  `detectCorruptedPlaceholders` reported clean, because it reads
  `if (hash && hasher && !hasher.hasHash(hash))` and there is no hasher.

  The hasher is now used only if the caller supplies one. Reversibility is recorded on the
  item (`metadata.reversible`) and in the stage metrics (`irreversibleElisions`), and stated
  in the stage notes. Emitted bytes are unchanged and do not depend on whether a hasher was
  passed. Reversibility on the CLI is not unimplemented but unachievable — a one-shot pipe
  has nowhere for a store to live — so the marker itself has to carry the information.

- **An unvalidated item no longer reads as a passing item (DECISIONS §23)**: `valid: true`
  meant both "a validator examined this and found no syntax errors" and "no validator covers
  this content type, so nothing was examined". `AstValidatorResult.validated` now separates
  them, `BundleAstValidationResult.unvalidatedItemIds` lists the uncovered items, and
  `ValidationReport`/`OptimizationTrace` carry `astCoverage` — which is what makes this
  visible on the CLI, whose only validation output is the stderr trace.

  **This partially reopens Phase 1a.** Replacing the Gateway's hardcoded `contentType: 'text'`
  with `classifyContent` (`ac16cec`) closed the JSON half of "no validator runs at all on
  Gateway items" and is recorded as closing the whole thing. It did not: `classifyContent`
  answered `html` for TypeScript, `selectValidator` has no `html` branch, and a pathless item
  carrying a file with an unterminated string literal returned `valid: true, issues: 0`.
  `selectValidator`'s content-type dispatch is now a total `Record<ContentType, …>`, so a tag
  dispatch has never heard of is a compile error. Pathless code stays unchecked by design
  (§17) — it is now reported as unchecked. `passed` is scoped to `severity: 'error'` so a
  coverage report cannot force a fallback.

- **Content classification no longer answers `html` for TypeScript (DECISIONS §22)**:
  `classifyContent` ran its content probes *before* its extension checks, and two of those
  probes were wrong. Measured on this repository: **46 of 57 TypeScript sources classified as
  `html`**, every markdown document as `html` or `yaml`, and a 75-line file of pure log
  output as `text`.

  Three causes: `looksLikeHtml`'s `/<\/?[a-z][\s\S]*>/i` matched from the first `<letter` to
  the **last** `>` in the input, so any generic parameter sufficed; `isCodeExtension` was
  consulted fifth, after four probes that could pre-empt it; and `looksLikeLogs` missed
  ISO-8601 both ways — it required the level before the date, and `\b\d{2}:\d{2}:\d{2}\b`
  cannot match `T19:00:01` because `T` and `1` are both word characters.

  Now: every recognized extension resolves first; `looksLikeHtml` requires a matched
  open/close tag pair; `looksLikeLogs` requires a majority of lines to carry a clock time
  plus either a severity token or a leading timestamp. Regression fixtures are the
  repository's own files (`test/unit/content-classification.test.ts`).

- **Latency budget no longer decides a syntax verdict (DECISIONS §21)**: `validateItemAst`
  returned `valid: false` with `AST_SLA_EXCEEDED` when validation exceeded 5ms. Identical
  bytes therefore produced different verdicts depending on machine load — measured on a 16 KB
  Python file across six fresh processes: `valid(4.06ms) INVALID(5.28ms) INVALID(6.86ms)
  INVALID(8.04ms) INVALID(14.70ms) INVALID(17.58ms)`. It also fell the engine back on large
  valid files, reporting a syntax error that did not exist. The breach is now reported on
  `AstValidatorResult.slaExceeded` and does not touch `valid` or `issues`.

- **One Token Estimator (DECISIONS §19)**: every reduction figure the CLI, MCP and bench
  paths report was computed across a seam between two independent token estimators —
  `EnhancedHeuristicTokenizer` on a bundle's input side, inline `Math.ceil(len / 4)` on
  every output side. The heuristic runs 11–22% above `len / 4` on this corpus, so
  **byte-identical output registered as an 11–22% saving**. All measurement now routes
  through `estimateTokens` / `estimateBundleTokens` in `src/core/hashing/tokenizer.ts`;
  `countTokens` is called from exactly one place.

  Eleven sites changed: `core/model/constructors.ts` (×2 bundle constructors),
  `core/trace/index.ts`, `core/engine/index.ts` (`attemptAutomatedRehydration`),
  `core/planner/cache-aware.ts`, `gateway/proxy.ts` (×2), and the four stages that build a
  bundle. `session-dedup` and `delta-compression` also reported `tokenEstimateSaved` as
  `ceil(bytesSaved / 4)` — a third unit — now derived from the two bundle estimates.

  **The bundled bench corpus reduces by 0.00%, not 7.82%.** All ten fixtures emit
  byte-identical output; the 7.82% was the estimator gap. Measured before → after, at
  `targetReductionRatio: 0.30`:

  | Fixture | In bytes | Out bytes | Identical | Reported before | Reported after |
  |---|---|---|---|---|---|
  | `HumanEval/0` | 348 | 348 | yes | 17.92% | **0.00%** |
  | `HumanEval/1` | 504 | 504 | yes | 13.70% | **0.00%** |
  | `HumanEval/2` | 328 | 328 | yes | 9.89% | **0.00%** |
  | `HumanEval/3` | 446 | 446 | yes | 11.11% | **0.00%** |
  | `HumanEval/4` | 386 | 386 | yes | 11.01% | **0.00%** |
  | `CodeXGLUE/py/101` | 192 | 192 | yes | 0.00% | **0.00%** |
  | `CodeXGLUE/py/102` | 164 | 164 | yes | 14.58% | **0.00%** |
  | `CodeXGLUE/ts/201` | 130 | 130 | yes | 0.00% | **0.00%** |
  | `CodeXGLUE/ts/202` | 49 | 49 | yes | 0.00% | **0.00%** |
  | `CodeXGLUE/js/301` | 112 | 112 | yes | 0.00% | **0.00%** |

  `avgReduction` 7.8210% → **0.0000%**. `fallbackRate` (0.40) and `totalValidationIssues`
  (4) are unchanged — neither was computed across the seam. The four rows already reading
  0.00% are the fallbacks, where the *bench* ratio compared two tokenizer-derived numbers;
  their `trace.tokenAfter` was still inflated, so MCP reported a saving on them too
  (`CodeXGLUE/py/101`: 53 → 48, a phantom 9.4% on a pure fallback). That is now 53 → 53.

  **Gateway results in this repo are unaffected and should not be re-corrected.** The
  figures recorded in `docs/phase-1-stabilization-summary.md` §9 and `NOTES-FOR-DOCS.md`
  (66%, 98.59%, 0%) were derived from HTTP body byte lengths, not from these counters. The
  Gateway's internal `rawTokens`/`optimizedTokens` do change unit — measured 8,470 → 10,059
  on a 36 KB payload — but its `dedupRatio` moves only 49.79% → 49.82%, because both of its
  sides already used the same estimator.

- **Regression guard**: `test/unit/token-estimator-unity.test.ts` pins byte-identical
  input and output to exactly 0% reduction on the engine path, on the fallback path, and
  for every stage in the catalog. Verified to fail against the pre-fix source (`expected 87
  to be 106` on `HumanEval/0`), not merely to pass against the fixed one.

### Changed
- **Bench Evaluator Classifies Instead of Hardcoding (Issue 2, follow-up)**:
  `src/bench/evaluator.ts` hardcoded `contentType: 'code'` on the two items it builds for
  AST quality checks. Both now call `classifyContent`, completing the removal of hardcoded
  content-type literals begun in the Gateway relabel.

  **This moves no benchmark number.** `selectValidator` dispatches
  `language` → `path` → `contentType`, and `BenchmarkFixture.language` is a required field
  always set to `python`, `typescript` or `javascript` — all matched by the first arm — so
  `contentType` is never consulted for these items. Measured across all ten bundled
  fixtures at `targetReductionRatio: 0.30`, before and after are byte-identical:

  | Fixture | Lang | In | Out | Reduction | Fallback | rawSyntaxValid | optSyntaxValid | Symbol | Similarity | Passed |
  |---|---|---|---|---|---|---|---|---|---|---|
  | `HumanEval/0` | python | 106 | 106 | 0.00% | yes | true | true | 1.0000 | 1.0000 | true |
  | `HumanEval/1` | python | 146 | 146 | 0.00% | yes | true | true | 1.0000 | 1.0000 | true |
  | `HumanEval/2` | python | 91 | 91 | 0.00% | yes | true | true | 1.0000 | 1.0000 | true |
  | `HumanEval/3` | python | 126 | 126 | 0.00% | yes | true | true | 1.0000 | 1.0000 | true |
  | `HumanEval/4` | python | 109 | 109 | 0.00% | yes | true | true | 1.0000 | 1.0000 | true |
  | `CodeXGLUE/py/101` | python | 53 | 53 | 0.00% | yes | true | true | 1.0000 | 1.0000 | true |
  | `CodeXGLUE/py/102` | python | 48 | 48 | 0.00% | yes | true | true | 1.0000 | 1.0000 | true |
  | `CodeXGLUE/ts/201` | typescript | 35 | 35 | 0.00% | yes | true | true | 1.0000 | 1.0000 | true |
  | `CodeXGLUE/ts/202` | typescript | 14 | 14 | 0.00% | yes | true | true | 1.0000 | 1.0000 | true |
  | `CodeXGLUE/js/301` | javascript | 33 | 33 | 0.00% | yes | true | true | 1.0000 | 1.0000 | true |

  Aggregates, also identical: `fallbackRate = 1`, `avgReduction = 0.0000%`,
  `syntaxPassRate = 1`, `passAt1Rate = 1`, `totalValidationIssues = 11`, and
  `evaluateDataset` → `rawPassRate = 1`, `optimizedPassRate = 1`, `passRateDelta = 0`,
  `avgKeySymbolPreservation = 1.000000`, `avgTokenSimilarity = 1.000000`.

  The 100% fallback rate is pre-existing and unrelated: nine fixtures exceed the drift
  threshold (`0.60 > 0.40`) and `CodeXGLUE/ts/202` fails AST validation with an unclosed
  bracket. Reduction figures come from the optimization pipeline via
  `fixtureToOptimizationRequest`, which already classified correctly through
  `createContextBundle` — the evaluator only computes post-hoc quality metrics and cannot
  affect them.

  **C1 interaction, checked explicitly:** all ten fixtures carry a `.py`/`.ts`/`.js` path,
  so extension-only code detection (`642abcb`) still classifies every one as `code`. The
  computed tag differs from the old literal on exactly one constructible input — a CodeXGLUE
  item with no `path`, which the loader synthesizes as `src/item_<id>.txt` and which
  classifies `text`. That is not a C1 regression: pre-C1 the only content signal for `code`
  was a fence, and plain source has none.

  **Not fixed, and verified rather than assumed:** with `language` absent, both the old
  literal and the computed tag yield `code` for a `.py` path, and `contentType: 'code'`
  selects the **TypeScript** validator — so a Python fixture would be parsed as TypeScript
  either way. `language` being required is the only thing preventing it, and these items
  pass the path as `origin` rather than `path`, leaving the extension arm unreachable.

### Fixed
- **Gateway Hardcoded `contentType: 'text'` (Issue 2, Commit C)**: `src/gateway/proxy.ts`
  built its context items by hand and hardcoded the content-type tag instead of calling
  `classifyContent`, the classifier every other construction site reaches through
  `createContextBundle`. That literal silently disarmed both safety nets on exactly the
  traffic a Gateway carries: `selectValidator` dispatches on `language` → `path` →
  `contentType`, and Gateway items have neither of the first two, so a `text` tag meant no
  AST validator ran at all; `DriftTracker.extractSymbols` harvests `jsonkey:` symbols only
  when `contentType === 'json'`, so a JSON payload tagged `text` yielded zero symbols and
  drift was vacuously `0.00`. Both checks reported passes they had never performed. Message
  content is now classified, and `statistics.contentTypeCounts` is derived from the items
  rather than asserted as all-`text`.

  Measured consequence, as predicted in `docs/phase-1-stabilization-summary.md` §9:
  cross-turn deduplication of a **sole copy** of `tool_output.json` moves from
  `13,785 / 13,982 = 98.59%` saved with no fallback to **0.00% and a fallback**. That is the
  drift gate working for the first time on JSON, not a regression — the prior figure
  depended on sending the model a marker it had no way to resolve. Within-payload
  duplication, where a referent survives in the same request, still deduplicates at
  **~66%** with no fallback.
- **Fenced Blocks Classified As Code**: `classifyContent` treated a triple-backtick fence as
  evidence of `code`, and `selectValidator` maps `code` to the **TypeScript** validator — so
  an ordinary message quoting a snippet was parsed as TypeScript, prose and all. Whether it
  passed was decided by apostrophe parity in the surrounding text: `Here's ... it's ...
  that's` leaves a quote open and the message is rejected with `AST_UNTERMINATED_STRING`,
  while the same message with one fewer contraction passes. Code is now detected by file
  extension only, and a fence counts toward `markdown`. Real code detection is unaffected —
  every path carrying source files supplies an extension. See `DECISIONS.md` §17.
- **Gateway Ran Without Any Safety Net (Phase 1.0b)**: `src/gateway/proxy.ts` called
  `runSessionDedupStage()` directly, so the proxy path executed no validators, no
  `DriftTracker`/`ConfidenceLedger`/`DebtTracker`, and no fallback resolver — invariants 3
  (fail-open fallback) and 5 (drift threshold) simply did not exist for live provider
  traffic. The proxy now routes through `core/engine.optimize()` and records a genuinely
  computed `fallbackUsed`. A rejected transform returns the caller's original payload
  byte-for-byte.
- **Planner Budget Trigger**: `isKnapsackMode` now also triggers on
  `budget.targetReductionRatio`, not just `maxInputTokens` — previously a budget supplying
  only `--target-reduction-ratio` silently resolved to `pass_through` mode with zero stages
  executed.
- **ESLint CI Failures**: Resolved lint issues breaking CI (`src/config/load.ts`,
  `src/core/hashing/tokenizer.ts`, related tests).
- **Design Gaps — Git Caching, Tokenizer, Versioning, Config Schema**: Follow-up fixes
  across `src/config/load.ts`, `src/config/schema.ts`, `src/core/hashing/tokenizer.ts`,
  `src/core/topology/git-inspector.ts`, and adapter entry points.

### Added
- **`session_dedup` Planner Mode**: New `OptimizationMode` planning exactly
  `['cleanup:session-dedup']`. Selected via `config.planner.defaultMode` (previously dead
  config) and takes precedence over budget-derived knapsack mode. The Gateway pins it so
  `compression:token-hashing` — which corrupts JSON-shaped message content (Issue 2) —
  cannot reach live provider payloads.

### Changed
- **Drift Exempts Recoverable Elisions**: `cleanup:session-dedup` now tags its elisions
  `recoverable: true`, and `DriftTracker` substitutes the pre-optimization content for
  those items before scoring. A dedup marker is a reference to text still held in the
  session store, not semantic loss; scoring it as drift made `S_k` fire hardest exactly
  when deduplication worked best (measured 0.60 for a code payload that now scores 0.00).
  Lossy elisions (`token-hashing`, `delta-compression`) set no such flag and are still
  scored in full.
- **Documentation**: Updated `ARCHITECTURE.md`, `DECISIONS.md`, and `ROADMAP.md` for v2.0
  planning.

## [v1.1.0] - 2026-07-29

### Added
- **Config Schema Versioning**: Added `configSchemaVersion: "1.1"` support with automatic legacy migration.
- **Git Workspace Caching**: Added in-memory TTL caching for `git status` commands, greatly speeding up Git inspections during proxy sessions.
- **Heuristic Tokenizer**: Replaced the naive character count estimator with an optimized, zero-dependency `EnhancedHeuristicTokenizer`.

### Performance
- **Tokenizer Speedup**: Optimized the heuristic tokenizer using `charCodeAt` to achieve a 3.5x performance boost.

## [v1.0.3] - 2026-07-27

### Fixed
- **CLI Executable Resolution**: Fixed "command not found" error following global installation (`npm install -g tokendamper`) by updating `"bin"` configuration in `package.json` to explicitly map `"./dist/src/cli/main.js"`.
- **Shebang & Environment Integrity**: Validated CLI entrypoint shebang (`#!/usr/bin/env node`) to ensure seamless execution on Windows, macOS, and Linux.

### Changed
- **Version Alignment**: Synced package version, `CLI_ADAPTER_VERSION`, and MCP `SERVER_VERSION` to `1.0.3`.

## [v1.0.2] - 2026-07-27

### Fixed
- **Engine Fallback Data Integrity**: Fixed a critical bug where the engine returned the corrupted intermediate bundle in `finalBundle` instead of the original request bundle when fallback was triggered. Consumers inspecting `result.finalBundle` after a fallback now correctly receive the original unmodified bundle.
- **Topology Scoring Performance**: Replaced per-item multi-source BFS (O(N × V²)) with a single batch `computeAllDistances()` call using an O(1) head-index dequeue, reducing topology scoring to O(V + E + N). Eliminates event loop freezes on repositories with 500+ files.
- **hashContent Crash on Undefined**: Guarded `stableSerialize()` against `undefined` return from `JSON.stringify()` (triggered by `undefined`, `Symbol`, or `Function` inputs) which previously crashed `createHash().update()` with a fatal `TypeError`.
- **Benchmark Runner Flaky Test**: Increased timeout for the `should execute offline deterministic benchmark sweeps` test from 5s to 15s to prevent false failures on slower CI runners.

### Changed
- **Version Alignment**: Synced `CLI_ADAPTER_VERSION` and MCP `SERVER_VERSION` from `0.1.0` to `1.0.2` to match the published package version. All traces, MCP `initialize` responses, and diagnostic outputs now report the correct version.

## [v1.0.0] - 2026-07-27

### Added
- **MCP Adapter**: Implemented a Model Context Protocol (MCP) stdio JSON-RPC 2.0 server for Claude Desktop and Cursor integration.
- **Gateway HTTP Proxy**: Built a local proxy server to transparently intercept and optimize Anthropic/OpenAI API requests from CLI tools (`tokendamper exec`).
- **0/1 Knapsack Planner**: Introduced an optimal value-density knapsack solver for packing context nodes under strict token constraints.
- **Reversible Token Hashing**: Added `TokenHasher` for eliding repetitive context with `<BLOCK_HASH:sha256>` placeholders.
- **Delta Compression**: Implemented line-based Myers diff algorithm to transmit only changed lines across conversation turns.
- **Visual Diff Reporters**: Added visual terminal ANSI diff (`--diff`) and beautiful HTML report exporter (`--diff-html <path>`).
- **Explainability Ledgers**: Introduced Optimization Debt ($D_k$) & Semantic Drift ($S_k$) tracking to enforce long-term session safety limits.

### Changed
- **Engine Emission Contract**: The core linear engine now fully emits optimized bundle text back to callers when validation successfully passes, seamlessly integrating with execution workflows.

### Security
- **Gateway Token Auth**: Implemented `x-tokendamper-token` authentication to secure the local Gateway proxy.
- **Payload Size Limits**: Enforced strict 10MB input limits on MCP stdio and Gateway streams.
- **Upstream Abort Timeouts**: Configured request timeouts to protect against upstream LLM hangs.
- **Bounded LRU Session Stores**: Capped active `GatewaySessionStore` metrics and MCP `traceStore` entries with eviction strategies to guarantee stable memory footprints over unbounded sessions.

## [v0.1.0] - 2026-07-24

### Added
- Initial repository governance documents
- Frozen architecture and implementation contract documentation
- Core data model and immutable schema definitions

### Changed
- N/A

### Deprecated
- N/A

### Removed
- N/A

### Fixed
- N/A

### Security
- N/A
