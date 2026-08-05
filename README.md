# TokenDamper

TokenDamper is a universal context optimization engine for AI coding assistants. 

It acts as an intelligent middleware proxy that compresses and deduplicates context before it reaches an LLM, reducing token usage, speeding up responses, and lowering API costs—while guaranteeing correctness and semantics in CLI and MCP modes. See the Gateway proxy limitation below.

> **Gateway proxy limitation:** The local Gateway HTTP proxy mode (started via `tokendamper exec`) currently bypasses TokenDamper's validation pipeline. It does not run AST/syntax validation, semantic-drift checking, the confidence ledger, or the fail-open fallback path. The trace field `fallbackUsed` is hardcoded `false` on this path — it is not a computed result. The syntax-safety, semantic-drift, and guaranteed-fallback guarantees described in this document apply to CLI (`tokendamper optimize`) and MCP (`tokendamper mcp`) modes only. This is a known gap, tracked and being fixed. Do not route production traffic through Gateway mode expecting those guarantees today.

## Overview & Features

TokenDamper addresses the problem of large and noisy context bundles (prompts, files, diffs, conversations) sent to LLMs by intelligently optimizing them:

- **0/1 Knapsack Planning**: Evaluates value-density of context nodes and optimally packs them under strict token budgets.
- **Cross-turn Session Deduplication**: Tracks LLM conversation state and deduplicates previously seen code blocks using robust SHA-256 caching.
- **Reversible Token Hashing**: Safely elides repetitive files by injecting `<BLOCK_HASH>` placeholders, recovering them transparently.
- **Delta Compression**: Compresses modified files using deterministic Myers diff algorithm.
- **Local Gateway HTTP Proxy**: Intercepts OpenAI/Anthropic API calls transparently with full streaming support.
- **Model Context Protocol (MCP)**: Out-of-the-box support for the official MCP stdio standard to integrate seamlessly with Claude Desktop and Cursor.

## Installation & Quickstart

To install globally via npm:
```bash
npm install -g tokendamper
```

For local development setup:
```bash
git clone https://github.com/Epichlo/TokenDamper.git
cd TokenDamper
npm install
npm run build
```

## CLI Usage Guide

TokenDamper offers a comprehensive CLI to fit various workflows:

### 1. Optimize Files Directly
Quickly compress a prompt or codebase context bundle directly from your terminal.
```bash
tokendamper optimize prompt.txt --max-input-tokens 5000
```
Or read from stdin:
```bash
cat prompt.txt | tokendamper optimize -
```

**Tell it what the content is when you pipe it.** Optimization is language-aware: the
validators, the elision-region selector and the drift metric all dispatch on the item's
language, and a piped stream carries no filename to infer one from. Without a declaration
code is probe-classified as prose, no validator covers it, and the pipeline falls back —
measured over a frozen 45-file Python corpus, the same bytes save **0.02% over bare stdin
and 12.34% with `--language`**, which is exactly what the file-argument route achieves.

```bash
cat service.py | tokendamper optimize - --language python --target-reduction-ratio 0.3
cat service.py | tokendamper optimize - --input-name src/service.py   # equivalent
```

- `--language <name>`: `typescript`, `python`, `json`, `markdown`, … Outranks both the
  filename extension and the content heuristics. An unrecognized name is an error, never a
  silent no-op.
- `--input-name <name>`: the filename the piped content would have had. Declares a name for
  classification only — the path is never opened or resolved.

### 2. Transparent Proxy Wrapper (`exec`)
Automatically intercept and optimize LLM API calls made by CLI tools like `aider`, `curl`, or Python scripts by wrapping them with `tokendamper exec`:
```bash
tokendamper exec -- aider --message "fix the bug"
```
*Note: This automatically provisions a local Gateway proxy and sets `OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL` for the child process.*

### 3. Model Context Protocol (`mcp`)
Launch the TokenDamper MCP stdio server to provide context optimization tools directly to MCP-compatible clients:
```bash
tokendamper mcp
```

## MCP Integration Setup

TokenDamper exposes optimization tools via the Model Context Protocol (MCP).

**Claude Desktop Configuration**
Add the following to your `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "tokendamper": {
      "command": "tokendamper",
      "args": ["mcp"]
    }
  }
}
```

**Cursor Configuration**
In Cursor settings, navigate to the MCP section, add a new server using the command `tokendamper mcp`.

## Environment Variables Reference

TokenDamper behavior can be configured dynamically using environment variables:

| Variable | Description |
|----------|-------------|
| `TOKENDAMPER_GATEWAY_TOKEN` | Auth token for gateway proxy requests (auto-generated in `exec` mode). |
| `TOKENDAMPER_MAX_INPUT_TOKENS` | Hard budget cap on the number of context tokens sent to the LLM. |
| `TOKENDAMPER_RISK_TOLERANCE` | Sets optimization aggressiveness (`low`, `medium`, `high`). |
| `TOKENDAMPER_PRESERVE_KINDS` | Comma-separated list of items to never prune (e.g. `prompt,file`). |
| `TOKENDAMPER_LOG_LEVEL` | Logging verbosity (`debug`, `info`, `warn`, `error`, `silent`). |

## Visual Diff & Trace Flags

TokenDamper provides detailed explainability for how your context was optimized via built-in trace reporters and visual diffs:

- `--diff`: Prints a visual ANSI terminal diff comparing the raw input against the optimized output.
- `--diff-html <path>`: Generates a beautiful HTML report visualizing exact token elisions and metrics.
- `--max-debt <0-100>`: Fails validation if optimization debt (information loss score) exceeds this threshold.
- `--max-drift <0-1>`: Fails validation if semantic drift (structural deviation) exceeds this threshold.

---

## High-Level Architecture

```text
Raw Input
  -> Adapter (CLI / HTTP Gateway / MCP)
  -> ContextBundle + OptimizationBudget
  -> Stateless 0/1 Knapsack Planner
  -> Linear Engine
      -> Topology Pruning & Delta Compression
      -> AST Validators
      -> Explicit Fallback (on constraint violation)
  -> Final Output + Explainability Trace
```

Note: the `AST Validators` and `Explicit Fallback` steps above run in CLI and MCP modes. Gateway mode does not execute them — see the Gateway proxy limitation notice above.

## License
TokenDamper is now licensed under the Mozilla Public License 2.0 (MPL-2.0). See [LICENSE](./LICENSE).

## Copyright Notice
Copyright (c) 2026 Ojas Sugur. All rights reserved.

## Trademark Notice
'TokenDamper' and its associated logos are trademarks of Ojas Sugur. You are free to fork, integrate, and modify the code under the terms of the MPL-2.0 license. However, you may not distribute, market, or publish your derivative works using the name 'TokenDamper' or imply any official endorsement without prior written permission.
