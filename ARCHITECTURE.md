# TokenDamper Architecture

This document is the canonical architecture reference for TokenDamper.

The architecture is frozen. This document describes what must be implemented, not what should be redesigned.

## System Overview

TokenDamper is a context optimization engine for AI coding assistants.

TokenDamper operates in three modes: direct CLI optimization, a local Gateway HTTP proxy, and a Model Context Protocol (MCP) server.

## Architecture Diagram

```text
Raw Input
  -> Adapter (CLI / Gateway Proxy / MCP)
  -> OptimizationRequest
  -> ContextBundle + OptimizationBudget
  -> Stateless 0/1 Knapsack Planner
  -> Linear Engine
      -> Session Deduplication (TokenHasher)
      -> Delta Compression (Myers Diff)
      -> Workspace Topology Pruning
  -> Validators (ConfidenceLedger, DebtTracker, DriftTracker)
  -> Fallback if needed
  -> Final Output
  -> Explainability Trace
```

## Execution Flow

1. The adapter (CLI, Gateway Proxy, or MCP) parses raw input into an `OptimizationRequest`.
2. The engine validates the request and resolves the active config.
3. The planner produces a single `OptimizationPlan` (e.g. 0/1 Knapsack packing).
4. The engine executes the selected built-in stages in order (e.g., Session Deduplication, Delta Compression, Topology Pruning).
5. Validators check the intermediate and final results using `ConfidenceLedger`, `DebtTracker`, and `DriftTracker`.
6. If validation fails or confidence is too low, the engine falls back to the original input.
7. The adapter formats the final output (or returns standard MCP JSON-RPC).
8. The engine emits a lightweight explainability trace.

The pipeline is linear by design. There is no DAG execution in MVP.

## Module Responsibilities

### `src/core/model`

Defines the stable data model:

- `OptimizationRequest`
- `ContextBundle`
- `ContextItem`
- `OptimizationBudget`
- `OptimizationPlan`
- `StageResult`
- `ValidationReport`
- `OptimizationTrace`
- `OptimizationResult`

This module is the source of truth for immutable domain data.

### `src/core/planner`

Selects a single plan from the request, budget, config, and available built-in stages.

The planner is stateless and deterministic.

**Cache-Aligned 0/1 Knapsack Allocation:** Candidate context item weights are evaluated in 1,024-token cache block quantizations to align with provider cache structures. The planner ensures that items selected by the 0/1 Knapsack solver preserve the exact ordering of the pinned prefix horizon, maximizing prompt cache hit rates on Anthropic and OpenAI APIs.

### `src/core/engine`

Orchestrates the full optimization flow.

Responsibilities:

- invoke the planner
- execute stages in order
- collect stage results
- invoke validators
- apply fallback
- assemble the trace

### `src/core/stage-registry`

Provides the built-in stage catalog used by the planner and engine.

Only this module may import concrete stage implementations.

### `src/core/validation`

Contains validators that determine whether an optimized result is safe enough to emit.

Validators are pure and must not mutate the bundle.

### `src/core/fallback`

Defines the explicit fallback behavior back to the original raw input.

### `src/core/trace`

Builds the lightweight explainability trace.

### `src/stages/*`

Contains the built-in stage implementations.
Stages must be deterministic, side-effect free, and built around the frozen core model.
- `delta-compression`: Implements line-based Myers diff algorithm to transmit only changed lines across turns instead of full file blobs.
- `session-dedup`: Deduplicates repeated content blocks, keyed by SHA-256 against the session
  store. It marks an elision `recoverable: true` **only when an intact copy survives elsewhere
  in the same outbound payload**. A sole copy seen only in a previous turn is elided but scored
  in full by `DriftTracker`, which refuses it — the consumer is a stateless provider API with no
  rehydration mechanism, so that marker would be deletion rather than reference. Measured saving
  on ordinary two-turn conversations is therefore **0 bytes**. See DECISIONS §16 and §41.
- `topology-pruner`: Implements workspace topology pruning.

### `src/core/hashing` & `src/core/ledger`

Implements the **Compression & Ledger Subsystem**.
- `TokenHasher`: Generates reversible SHA-256 placeholder hashes (`<BLOCK_HASH>`) and rehydrates them.
- `ConfidenceLedger`: Tracks block restoration safety scores across conversation turns.
- `DebtTracker` ($D_k$) & `DriftTracker` ($S_k$): Calculates optimization debt (information loss) and semantic drift (structural deviation).
  - **Agent Loop Circuit Breaker:** Integrates with `DebtTracker` to track turn-over-turn similarity and tool call repetition. If $N \ge 5$ consecutive turns show near-identical tool output signatures with high token volume, it triggers a `LOOP_REPETITION_WARNING` or throttles execution to prevent billing runaway.
  - **Atom-Aware Semantic Drift Tracking:** `DriftTracker` evaluates **Critical Atom Recall** (preserving imperative directives like `TD_PRESERVE`, file paths, line numbers, API URLs). The drift formula is $S_k = 1.0 - \left( w_{\text{AST}} \cdot R_{\text{AST}} + w_{\text{struct}} \cdot R_{\text{struct}} + w_{\text{atom}} \cdot R_{\text{atom}} \right)$. A hard threshold of $S_k \le 0.40$ triggers an explicit fallback to `rawInput`.

### `src/adapters/cli`

Defines the direct CLI adapter. It parses raw input into normalized requests and formats the final output.

### `src/adapters/mcp`

Implements the **MCP Adapter Subsystem**.
- Stdio JSON-RPC 2.0 transport exposing tools (`optimize_context`, `rehydrate_context`, `get_session_metrics`, `get_optimization_trace`) and resources (`tokendamper://config`, `tokendamper://session/{sessionId}`).
- **MCP Schema Pinning Layer:** Converts tool definitions into deterministic, sorted JSON structures at prompt position 0. Assigns content-addressed hashes to MCP tool suites, replacing repetitive static schemas across multi-turn sessions with deterministic schema anchors that preserve 1,024-token cache boundaries.

### `src/gateway`

Implements the **Gateway Proxy Subsystem**.
- Local proxy intercepting Anthropic/OpenAI API requests.
- Handles upstream streaming backpressure and large payloads.
- Enforces session authentication (`TOKENDAMPER_GATEWAY_TOKEN`).
- Manages `GatewaySessionStore` for session-scoped hash tracking.

### `src/config`

Defines configuration schema, defaults, and resolution order.

### `src/cli`

Process entrypoint and command wiring.

### `src/bench`

Offline benchmark harness and fixture runner.

## Provider Cache Prefix Invalidation Rules

To maximize economic viability and cache hit rates on providers like Anthropic and OpenAI:

- **Immutable System Prompt & Tool Pinning:** The root system prompt and MCP tool definitions must remain bitwise identical at index 0. Modifying an early-turn prompt prefix is economically negative unless the compression slashes **>90%** of the prefix size, due to lost cache discounts.
- **1,024-Token Cache-Aligned Prefix Horizon:** All dynamic modifications (delta diffs, token hashing) must occur strictly *after* the stable prefix horizon. Provider caches rely on strict positional prefix KV-caching matching blocks of 1,024 tokens.
- **Invariant Placeholders:** Unchanging content should use invariant content-addressed placeholders (`<BLOCK_HASH:sha256:12char>`) to preserve cache alignment across multi-turn interactions.

## Import Rules

Module boundaries are strict.

### Allowed direction

- `src/core/model` may import only stdlib-level dependencies
- `src/core/planner` may import `core/model`, `config`, and stage catalog metadata
- `src/core/engine` may import `core/model`, `core/planner`, `core/validation`, `core/fallback`, `core/trace`, and `core/stage-registry`
- `src/core/stage-registry` may import concrete built-in stages and `core/model`
- `src/core/validation` may import `core/model`
- `src/core/fallback` may import `core/model` and `core/trace`
- `src/core/trace` may import `core/model`
- `src/stages/*` may import `core/model` and pure helpers only
- `src/adapters/cli` may import `core/model`, `config`, and adapter-local parsing/formatting helpers
- `src/cli` may import adapter, engine, and config entrypoints
- `src/bench` may import engine, config, `core/model`, and `core/trace`

### Disallowed direction

No module may import upward into engine internals from stage code, adapter code, validation code, or benchmark code.

No built-in stage may import the engine or planner.

No validator may mutate the bundle.

No adapter may bypass the engine.

## Core Data Model

### `OptimizationRequest`

The input accepted by the engine after adapter parsing.

Fields:

- `requestId`
- `rawInput`
- `bundle`
- `budget`
- `config`
- `adapterName`
- `adapterVersion`

### `ContextBundle`

The normalized content container.

Fields:

- `bundleId`
- `source`
- `items`
- `summary`
- `contentHash`

### `ContextItem`

An ordered context unit inside the bundle.

Fields:

- `itemId`
- `kind`
- `content`
- `origin`
- `role?`
- `path?`
- `language?`
- `metadata`

### `OptimizationBudget`

The optimization constraint model.

Fields:

- `maxInputTokens?`
- `maxOutputTokens?`
- `targetReductionRatio?`
- `maxLatencyMs?`
- `riskTolerance`
- `preserveKinds[]`

### `OptimizationPlan`

The selected execution plan.

Fields:

- `planId`
- `mode`
- `stageIds[]`
- `revalidationPoints[]`
- `fallbackPolicy`
- `expectedSavings?`

### `StageResult`

The result returned by each stage.

Fields:

- `stageId`
- `status`
- `bundle`
- `changed`
- `metrics`
- `notes?`

### `ValidationReport`

The result returned by validators.

Fields:

- `passed`
- `confidence`
- `issues[]`
- `shouldFallback`
- `reason?`

### `OptimizationTrace`

The lightweight explainability record.

Fields:

- `requestId`
- `planMode`
- `stageTraces[]`
- `tokenBefore`
- `tokenAfter`
- `fallbackUsed`
- `fallbackReason?`

### `OptimizationResult`

The final engine output.

Fields:

- `finalBundle`
- `emittedOutput`
- `validation`
- `trace`
- `fallbackUsed`

## Public Interfaces

The stable public interfaces are:

- `Adapter.parse(rawInput, env) -> OptimizationRequest`
- `Planner.plan(bundle, budget, config, stageCatalog) -> OptimizationPlan`
- `Stage.run(bundle, context) -> StageResult`
- `Validator.validate(before, after, plan, budget) -> ValidationReport`
- `Engine.optimize(request) -> OptimizationResult`
- `BenchmarkRunner.run(fixtures, config) -> BenchmarkReport`

These are the only interfaces the implementation should rely on as stable boundaries.

## Planner Responsibilities

The planner is pure and stateless.

It must:

- inspect the bundle shape and budget
- choose one of the supported plan modes
- select built-in stage order
- avoid unsafe transformations when risk is high
- keep the plan deterministic for the same input and config

It must not:

- mutate the bundle
- run stages
- validate outputs
- cache results
- perform strategy generation

## Engine Responsibilities

The engine owns orchestration.

It must:

- call the planner
- execute the selected stages in order
- collect metrics and trace data
- run validators
- decide when fallback is required
- return the final result

It must not:

- parse raw adapter input directly
- transform content outside stage execution
- make validation decisions inside stages

## Stage Responsibilities

Built-in stages are the only transformation units in MVP.

Stages must:

- be deterministic
- be side-effect free
- avoid in-place mutation
- operate on `ContextBundle`
- return a new `StageResult`
- report whether they changed the bundle

Stages must not:

- call the engine
- call the planner
- bypass validation
- depend on external state

## Validator Responsibilities

Validators judge whether the output is safe enough to emit.

They must:

- inspect before and after states
- detect structural or semantic risk
- return a `ValidationReport`
- be pure and deterministic

They must not transform bundles or emit output.

## Adapter Responsibilities

The first adapter only is in scope for MVP.

It must:

- parse raw input into an `OptimizationRequest`
- preserve the original raw input for fallback
- format the final engine result for emission
- expose adapter metadata such as name and version

It must not:

- execute stages
- run validators
- own planning logic

## Fallback Rules

Fallback is explicit and unconditional when triggered.

Rules:

- The original raw input is the only fallback target in MVP
- Fallback must be exact, not synthesized
- The engine decides fallback, not stages or validators
- Fallback must be recorded in the final result and trace

Fallback is required when:

- parsing fails
- a stage fails
- validation fails
- confidence is below threshold
- the engine cannot produce a safe plan

## Explainability

Explainability is lightweight and first-class.

It must record:

- selected plan mode
- ordered stage execution
- token estimate before and after
- per-stage status
- validation summary
- fallback reason when used

It must not become a verbose telemetry platform or a full tracing system.

## Benchmark Philosophy

Benchmarks are offline, deterministic, and fixture-driven.

They exist to:

- protect regression behavior
- measure token reduction
- measure latency
- measure fallback rate
- check stability across representative inputs

Benchmarks must not influence runtime planning or stage selection.

## Folder Structure

```text
src/
  cli/
    main.ts
  adapters/
    cli/
  config/
  core/
    model/
    planner/
    engine/
    stage-registry/
    validation/
    fallback/
    trace/
  stages/
    cleanup/
    compression/
  bench/
    fixtures/
test/
  unit/
  integration/
  fixtures/
docs/
  architecture/
```

## Design Principles

- Preserve intent before maximizing compression
- Keep the core deterministic
- Maintain strict module boundaries
- Prefer immutable domain objects
- Keep adapters thin
- Keep stages built-in and predictable
- Use explicit fallback rather than implicit repair
- Keep benchmarking offline

## Architectural Invariants

- `ContextBundle` is the core normalized content model
- `OptimizationBudget` is the core constraint model
- the planner is stateless
- the engine is linear
- built-in stages only are used in MVP
- validation can force fallback
- fallback always returns the original raw input unchanged
- explainability exists for every request
- benchmarks are offline only
- no plugin, DAG, embeddings, or database infrastructure exists in MVP
