# TokenDamper

TokenDamper is a universal context optimization engine for AI coding assistants. 

It acts as an intelligent middleware proxy that compresses and deduplicates context before it reaches an LLM, reducing token usage, speeding up responses, and lowering API costs—while preserving bracket/quote integrity and falling open to the caller's original bytes whenever a check cannot certify the result. See the Gateway proxy status below.

> ### Gateway mode is experimental
>
> It works, it forwards your bytes faithfully, and it runs the full validation pipeline. **What it does not do is save tokens across turns**, and the reason is a deliberate design conclusion rather than an unfinished feature.
>
> `cleanup:session-dedup` — the only stage the Gateway plans — marks an elision recoverable **only when an intact copy survives elsewhere in the same payload**. Deduplicating a *sole* copy against a previous turn would leave the model a marker it has no way to resolve, because the consumer is a stateless provider API with no rehydration mechanism. That is deletion, not reference, so the drift gate refuses it and the request falls back unchanged.
>
> Measured over real sockets, two-turn conversations, three content types:
>
> | shape | saving |
> |---|---|
> | the same block repeated **across turns** (the ordinary case) | **0 bytes**, falls back |
> | the same block repeated **within one payload** | saves |
>
> So use Gateway mode for transparent interception, validation and metrics. Do not adopt it expecting a token reduction on conversational traffic. CLI (`tokendamper optimize`) and MCP (`tokendamper mcp`) are where the compression actually happens.
>
> **Two earlier warnings here were wrong and are retracted.** This notice used to say the Gateway "bypasses TokenDamper's validation pipeline" and that `fallbackUsed` is "hardcoded `false`" — untrue since Phase 1.0b; `src/gateway/proxy.ts` routes through `core/engine.optimize()`, so validators, `DriftTracker`, `ConfidenceLedger`, `DebtTracker` and the fallback resolver all run, and `fallbackUsed` is computed. A later revision reported that `tokendamper exec` returned `401` to its own child and that non-ASCII bodies could be corrupted at the socket; both were true when written and both are now fixed (DECISIONS §38, §41).

## Overview & Features

TokenDamper addresses the problem of large and noisy context bundles (prompts, files, diffs, conversations) sent to LLMs by intelligently optimizing them:

- **0/1 Knapsack Planning**: Evaluates value-density of context nodes and packs them under strict token budgets, preserving pinned prefixes for provider prompt-cache alignment. Reached by giving `optimize` more than one file — `tokendamper optimize ./src` or several paths. Measured on this repository's `src/core` at `--max-input-tokens 4000`: 31 files in, **15 pruned, 20,540 tokens saved** by the planner alone. A single-file run has nothing to select between, so the planner correctly prunes nothing there.
- **Session Deduplication** *(within a payload)*: Tracks conversation state and elides content repeated inside a single outbound request, keyed by SHA-256. **Cross-turn deduplication of a sole copy is deliberately refused** — see the Gateway notice above.
- **Token Hashing** *(reversible only when a hasher is supplied)*: Elides repetitive regions — function bodies, repeated blocks — replacing them with a self-describing marker carrying a SHA-256 digest. On the **CLI this is irreversible by design**: no `TokenHasher` is wired in, so the removed bytes are retained nowhere and the trace reports `irreversibleElisions`. Embedding callers that supply a hasher get rehydration.
- **Delta Compression**: Compresses modified files using deterministic Myers diff algorithm.
- **Local Gateway HTTP Proxy** *(experimental)*: Intercepts OpenAI/Anthropic API calls transparently with full streaming support, running the same validators and fail-open fallback as the CLI. Interception is by **base URL** (`OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`), not by `HTTP_PROXY` — it is an origin server, not an HTTP proxy, and implements neither absolute-form request URIs nor `CONNECT`.
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

**Several files, or a whole directory.** More than one path builds a multi-item bundle, which is
what gives the knapsack planner something to select between:

```bash
tokendamper optimize src/a.ts src/b.ts --max-input-tokens 4000
tokendamper optimize ./src --max-input-tokens 8000
```

A directory is walked recursively, sorted (order matters — prefix locking pins the first ~1,024
tokens), skipping `node_modules`, `dist`, `.git` and similar. Each file becomes one item and is
emitted under a `==> path <==` header; a single file is emitted exactly as before, with no header.
On fail-open each file is returned byte for byte.

**A file that fails a check no longer reverts the rest.** Validation is still bundle-scoped, but
a failure that names its item now reverts *only* that item; the repaired bundle is re-validated
and emitted only if it passes. Measured on frozen corpora at `--target-reduction-ratio 0.3`,
**before `--target-reduction-ratio` became a binding ceiling** — the "after" column is what this
change was worth on the engine of the day, not what the current engine emits:

| bundle | before | after |
|---|---|---|
| 45 Python files | 0.00% (all reverted) | **22.73%**, 14 files reverted |
| 61 TypeScript files | 0.00% (all reverted) | **19.47%**, 21 files reverted |

Both figures are lower on today's engine, because a target of 0.3 now stops near 30% instead of
running to exhaustion — 20.26% and 17.57% on the current frozen corpus, with *fewer* fallbacks.
Current per-bucket numbers live in `docs/audit-remediation-status.md` §2, which is re-measured
rather than remembered.

`trace.itemsReverted` names what was put back, so a partial success cannot be mistaken for a
clean one. A failure that names no item — semantic drift over the whole bundle — still falls back
entirely, because there is no principled subset to revert. See `DECISIONS.md` §47.

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
| `TOKENDAMPER_GATEWAY_TOKEN` | Auth token for gateway requests, enforced only on a **non-loopback** bind. Auto-generated and injected by `exec`; loopback peers are trusted and need not present it. |
| `TOKENDAMPER_MAX_INPUT_TOKENS` | Hard budget cap on the number of context tokens sent to the LLM. Any value above 0 also engages the optimizing planner. |
| `TOKENDAMPER_TARGET_REDUCTION_RATIO` | Fraction of tokens to try to remove, 0–1. Currently an on/off switch rather than a proportional target — any value above 0 engages the planner. |
| `TOKENDAMPER_PRESERVE_KINDS` | Comma-separated list of items to never prune (e.g. `prompt,file`). |
| `TOKENDAMPER_LOG_LEVEL` | Logging verbosity (`debug`, `info`, `warn`, `error`, `silent`). |

`TOKENDAMPER_RISK_TOLERANCE`, `TOKENDAMPER_MAX_OUTPUT_TOKENS` and `TOKENDAMPER_MAX_LATENCY_MS`
were **removed in 1.2.0**, along with the `--risk-tolerance`, `--max-output-tokens` and
`--max-latency-ms` flags. No stage, validator or planner ever read them — risk tolerance
reached the benchmark table's display column and nothing else — so setting one reported
success and changed nothing (audit H4). The corresponding `OptimizationBudget` fields remain
in the model; only the user-facing controls are gone.

## Visual Diff & Trace Flags

TokenDamper provides detailed explainability for how your context was optimized via built-in trace reporters and visual diffs:

- `--diff`: Prints a visual ANSI terminal diff comparing the raw input against the optimized output.
- `--diff-html <path>`: Generates a beautiful HTML report visualizing exact token elisions and metrics.
- `--max-debt <0-100>`: Fails validation if optimization debt (information loss score) exceeds this threshold.
- `--max-drift <0-1>`: Fails validation if semantic drift (structural deviation) exceeds this threshold.
- `--keep-docstrings`: Keep a Python function's leading docstring outside the elided region, so
  the *why* of a function survives when its body does not. A retention/size trade you opt into:
  measured, keeping docstrings gives back **14.2%** of the saved tokens on real third-party code
  and **21.1%** on doc-heavy source, so it is off by default. No effect on TypeScript/JavaScript,
  whose doc comments sit above the function rather than inside its body.
- `--target-reduction-ratio <0-1>`: How much to remove. Resolved against the input into a token
  ceiling that both selection and compression respect, so compression stops rather than eliding
  everything it can. **Best effort, not a guarantee:** the smallest thing elision can remove is
  one region — usually a whole function body — and files often have one dominant region, so a
  modest target can overshoot. Measured at target 30%, 21 of 66 reducing files landed in 25–35%
  and 23 exceeded 50%.

---

## High-Level Architecture

```text
Raw Input
  -> Adapter (CLI / HTTP Gateway / MCP)
  -> ContextBundle + OptimizationBudget
  -> Stateless 0/1 Knapsack Planner
  -> Linear Engine
      -> Topology Pruning & Delta Compression
      -> Syntax Checks (see "What validation actually checks")
      -> Explicit Fallback (on constraint violation)
  -> Final Output + Explainability Trace
```

Note: the `Syntax Checks` and `Explicit Fallback` steps above run in **all three** modes, Gateway included, since Phase 1.0b. (A previous version of this note claimed Gateway mode skipped them; it does not.) What differs on the Gateway is the *stage list*, not the checks — it plans only `cleanup:session-dedup`. See the Gateway proxy status notice at the top.

## What validation actually checks

The internal validators are called "AST-lite". **They are not parsers and they do not build an
AST** — the one exception is JSON. Stating the guarantee precisely, because it is the product's
headline property:

| Content | What is checked | What is *not* |
|---|---|---|
| **TypeScript / JavaScript** | Bracket, quote and comment balance, by a lexer that tracks strings, template interpolation and regex literals | Everything else. `const x = ;`, `import from "x";`, `let 123abc = 5;` and plain English prose all **pass** |
| **Python** | The above, plus missing colons, malformed `def`, bad dedent and stray leading indentation | Plain English prose still passes |
| **JSON** | Fully parsed — this one is a real check | — |
| **Go** | The same, by a lexer that knows raw strings (no escapes, spans lines), rune literals and that Go has no regex literals | Everything else, exactly as for TypeScript. Measured over 9,181 real Go files it flags **1**, and that file is the Go compiler's own deliberately-malformed testdata |
| **Everything else** | Nothing. No validator covers it | Reported on `trace.astCoverage`, never silently counted as a pass |

So the guarantee this product offers on TypeScript — the language family where compression
actually runs — is **bracket and quote integrity**, not syntax validity. An elision that lands
somewhere syntactically nonsensical but balanced is caught by the drift metric, if at all, not by
the syntax check.

Two consequences worth stating plainly:

- **A passing check is not a promise the output compiles.** It is a promise the output is no
  more unbalanced than the input.
- **Real inputs are often already invalid**, and that is deliberate: a truncated completion
  prompt is a first-class input, so the sub-item check is *relative* — an elision must not
  introduce a new problem, rather than produce provably valid code.

Wiring the real TypeScript compiler API would change this. It is not done: `typescript` is a
development dependency today, and making it a runtime one costs install size and parse latency
against a lexer that runs in single-digit milliseconds. That is a deliberate trade, not an
oversight — see `docs/audit-remediation-status.md`.

## License
TokenDamper is licensed under the Mozilla Public License 2.0 (MPL-2.0). See [LICENSE](./LICENSE).

## Copyright Notice
Copyright (c) 2026 Ojas Sugur.

Licensed under the MPL-2.0 as stated above. The trademark reservation below is a limit on use
of the *name*, not a reservation of rights in the code.

## Trademark Notice
'TokenDamper' and its associated logos are trademarks of Ojas Sugur. You are free to fork, integrate, and modify the code under the terms of the MPL-2.0 license. However, you may not distribute, market, or publish your derivative works using the name 'TokenDamper' or imply any official endorsement without prior written permission.
