# TokenDamper Roadmap

This document outlines the canonical 8-Milestone execution plan for TokenDamper, adhering strictly to the architectural invariants in [ARCHITECTURE.md](./ARCHITECTURE.md) and rationale in [DECISIONS.md](./DECISIONS.md).

## 8-Milestone Roadmap

- [x] **Milestone 1 & 2: Immutable Domain Foundation & CLI Baseline (Done)**
  - Core data model: `ContextBundle`, `OptimizationBudget`, `OptimizationPlan`, `ContextItem`, `OptimizationTrace`.
  - Immutable domain objects, frozen budget constraints, SHA-256 content hashing.
  - Adapter parsing, linear engine execution, CLI interface (`tokendamper optimize`), and test suite.



- [x] **Milestone 3: Session Gateway & Cross-Turn Session Deduplication (Done)**
  - CLI Proxy wrapper (`tokendamper exec`) intercepting multi-turn context streams.
  - Cross-turn context item deduplication across conversation turns via SHA-256 block hashing.
  - Session state tracking preserving immutable domain object standards and stateless planner principles.
  - Unconditional fallback guarantees restoring exact original raw input on cache/session invalidation.

- [x] **Milestone 4: AST Syntax Validation & Imperative Constraint Protection (Done)**
  - Syntactic and type-check validation stages (AST parsing for TypeScript/JavaScript, Python, JSON, etc.).
  - Explicit constraint preservation parser ("MUST", "NEVER", "ONLY IF", "DO NOT" directives).
  - Validation-triggered fallback loop guaranteeing zero broken syntax or violated prompt rules.

- [x] **Milestone 5: Workspace Topology Pruning & 0/1 Knapsack Planner (Done)**
  - Git/Workspace topology aware pruning (dependency tree, export graph, modified files).
  - 0/1 Knapsack Solver implementation in Stateless Planner for optimal value/token density.
  - Cache-aware token budgeting (prompt caching optimization for LLM prefix matching).

- [ ] **Milestone 6: Reversible Token Hashing & Delta Compression**
  - Reversible placeholder token elision (`<BLOCK_HASH:sha256>`).
  - Cross-turn delta compression (transmitting diffs for modified context files).
  - Elision Confidence Ledger tracking restoration safety scores across turns.

- [ ] **Milestone 7: Visual Diff Dashboard & Optimization Debt Tracking**
  - Visual terminal/HTML diff viewer (`--diff`).
  - Optimization debt & semantic drift tracking over long multi-turn sessions.
  - Interactive trace exploration and explainability reporting.

- [ ] **Milestone 8: Empirical Benchmarking & Quality Evaluation**
  - Benchmark suite evaluated on HumanEval and CodeXGLUE datasets.
  - Automated pass-rate and code completion accuracy evaluation vs token reduction ratios.
  - Regression testing harness and performance baseline verification.

## Development Status & Build Order

1. [x] Core model and immutable schema definitions (M1-M2)
2. [x] Config loader & CLI entrypoint (`tokendamper optimize`) (M1-M2)
3. [x] Linear engine orchestration & SHA-256 content hashing (M1-M2)
4. [x] Comprehensive test suite & runner setup (M1-M2)
5. [x] Session Gateway (`tokendamper exec` proxy wrapper) (M3)
6. [x] Cross-turn context deduplication & session cache index (M3)
7. [x] AST validator & prompt constraint preservation ("must", "never", "only if") (M4)
8. [x] Workspace topology graph pruner & 0/1 Knapsack planner (M5)
9. [ ] Reversible token hashing (`<BLOCK_HASH>`) & delta compression (M6)
10. [ ] Visual `--diff` viewer & semantic drift ledger (M7)
11. [ ] HumanEval / CodeXGLUE benchmark harness & accuracy evaluation (M8)

## Expected Outputs per Milestone

- **M1-M2 Output (Done)**: Runnable CLI, immutable domain types, linear engine pipeline, unit/integration tests passing.
- **M3 Output**: `tokendamper exec` subcommand proxying turn streams, cross-turn hash deduplication, fallback to raw input on session error.
- **M4 Output**: AST syntax validator for TypeScript/Python, constraint parser protecting critical instructions, automatic fallback on syntax parse failure.
- **M5 Output**: Git topology analyzer, 0/1 Knapsack optimization planner adhering to cache boundaries and budget limits.
- **M6 Output**: Reversible block elision (`<BLOCK_HASH>`), turn-by-turn delta compression engine, confidence scoring ledger.
- **M7 Output**: Terminal `--diff` viewer showing elided vs retained tokens, drift metrics over multi-turn interactions.
- **M8 Output**: Empirical benchmark suite reporting pass rates and compression efficiency across standard code datasets.

## Core Architectural Invariants

- **Immutable Domain Objects**: `ContextBundle` and `OptimizationBudget` instances are strictly immutable once created.
- **Stateless Planner**: The planner generates execution plans purely from inputs (bundle, budget, config) without side effects or hidden state.
- **Explicit Fallback**: Any validation failure, stage exception, or session state corruption triggers immediate fallback to the original raw input.
- **Explainability**: Every request emits an `OptimizationTrace` documenting plan mode, stage execution, token delta, and fallback status.
