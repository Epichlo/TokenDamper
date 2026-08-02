# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

Commits on `main` beyond the `v1.1.0` tag (`807f6f0`). Not yet tagged or released; run
`git log v1.1.0..HEAD` to confirm current scope before relying on this list.

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
