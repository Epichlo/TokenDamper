# TokenDamper

TokenDamper is a universal context optimization engine for AI coding assistants.

It reduces token usage by transforming context before it reaches an LLM, while preserving intent, correctness, and traceability.

## Problem Statement

AI coding assistants consume large and noisy context bundles: prompts, files, diffs, logs, conversations, and web-derived text. A lot of that input is redundant, poorly structured, or irrelevant to the current task. The result is wasted tokens, slower responses, and higher failure rates.

TokenDamper addresses that problem by normalizing incoming context, planning a constrained optimization pass, executing a small set of built-in stages, validating the result, and falling back to the original input when the output is not safe enough to use.

## Vision

TokenDamper should become a reliable, extensible foundation for context optimization across coding assistants without becoming a monolithic prompt compressor.

The project is intentionally conservative:

- preserve meaning before chasing maximum compression
- keep core behavior deterministic and testable
- make the architecture stable enough to support future expansion

## Goals

- Reduce token usage without changing user intent
- Preserve correctness and traceability
- Keep the runtime deterministic and easy to test
- Support a small, stable core that contributors can understand
- Provide a foundation for future assistant integrations and optimization stages

## Non-goals

- Plugins in MVP
- DAG execution in MVP
- Embeddings in MVP
- Strategy generation in MVP
- Database-backed state in MVP
- Multi-adapter support in MVP

## High-Level Architecture

```text
Raw Input
  -> Adapter
  -> ContextBundle + OptimizationBudget
  -> Stateless Planner
  -> Linear Engine
      -> Built-in Stages
      -> Validators
      -> Explicit Fallback if needed
  -> Final Output + Explainability Trace
```

## Core Concepts

### ContextBundle

The normalized representation of input context. It is immutable and contains ordered context items plus minimal metadata.

### OptimizationBudget

The constraint model that defines how aggressively TokenDamper may optimize, how much latency is allowed, and what must be preserved.

### Planner

A pure, stateless decision component that selects a plan from the bundle, budget, config, and available built-in stages.

### Engine

The orchestrator that executes the selected plan, runs stages, invokes validators, and applies fallback.

### Validators

Checks that determine whether the transformed result is safe enough to emit.

### Fallback

The explicit path back to the original input when the optimized output cannot be trusted.

## MVP Scope

The MVP includes:

- `ContextBundle`
- `OptimizationBudget`
- stateless planner
- linear engine
- built-in stages only
- validators
- explicit fallback to original input
- lightweight explainability trace
- offline benchmark fixtures

## Future Roadmap

The long-term architecture is designed to support future expansion, but those extensions are intentionally deferred until the MVP proves the core behavior.

See [ROADMAP.md](./ROADMAP.md) for the frozen implementation roadmap and [ARCHITECTURE.md](./ARCHITECTURE.md) for the canonical system design.

## Build Instructions

The repository is still at the documentation and implementation-contract stage.

Once the implementation lands, the root package scripts will define the supported local build, test, and benchmark commands.

## Contributing

Contributors should read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request.

Architectural decisions are tracked in [DECISIONS.md](./DECISIONS.md).

## License

TokenDamper is distributed under the MIT License. See [LICENSE](./LICENSE).
