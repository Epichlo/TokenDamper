# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
