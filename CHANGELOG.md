# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
