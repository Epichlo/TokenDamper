# Architecture Decisions

This document records the architectural decisions behind TokenDamper.

It should grow over time. Any future architectural change must update this document before implementation.

## 1. Why immutable `ContextBundle`?

### Decision

`ContextBundle` is immutable once created.

### Context

TokenDamper transforms assistant context under constraints. Mutable domain state makes it harder to reason about correctness, traceability, and fallback.

### Alternatives Considered

- Mutable bundle passed through stages
- Copy-on-write bundle with mixed mutable fields
- Event-sourced content model

### Pros

- Easier to test
- Easier to trace
- Fewer accidental side effects
- Safer fallback behavior

### Cons

- Requires stage implementations to return new results
- Can create extra allocations

### Final Rationale

Immutable bundles make the execution model predictable and keep the engine, validators, and trace logic straightforward.

### Future Revisit Conditions

Revisit only if profiling shows immutable transformation costs are a real bottleneck.

## 2. Why `OptimizationBudget`?

### Decision

Optimization constraints are modeled explicitly as `OptimizationBudget`.

### Context

TokenDamper needs one place to represent target reduction, latency, risk tolerance, and preservation rules.

### Alternatives Considered

- Ad hoc config fields
- Planner-local thresholds
- Policy engine

### Pros

- Clear constraint contract
- Shared vocabulary for planner, engine, and validators
- Easier to test and document

### Cons

- Adds a dedicated model object

### Final Rationale

The budget is the smallest stable abstraction that explains why the system chooses one plan over another.

### Future Revisit Conditions

Revisit only if the budget model becomes too rigid for a proven runtime requirement.

## 3. Why stateless Planner?

### Decision

The planner is stateless and pure.

### Context

The planner must be deterministic and easy to test.

### Alternatives Considered

- Stateful planner
- Planner with cache access
- Strategy generation engine

### Pros

- Deterministic
- Easy to unit test
- No hidden dependencies

### Cons

- Limited expressiveness compared with future strategy systems

### Final Rationale

Stateless planning is sufficient for MVP and avoids introducing hidden behavior before the system proves itself.

### Future Revisit Conditions

Revisit only if real usage shows that pure planning cannot express necessary decisions.

## 4. Why linear execution?

### Decision

The engine executes a simple linear stage sequence.

### Context

The project needs a predictable, testable execution flow.

### Alternatives Considered

- DAG execution
- Branching pipelines
- Multi-pass strategy search

### Pros

- Simpler to understand
- Simpler to test
- Simpler to debug

### Cons

- Less flexible than a DAG

### Final Rationale

Linear execution is sufficient for MVP and avoids unnecessary orchestration complexity.

### Future Revisit Conditions

Revisit only after a proven need for branching or parallel execution emerges.

## 5. Why built-in stages?

### Decision

MVP uses built-in stages only.

### Context

The runtime must remain small and predictable while the core behavior is being proven.

### Alternatives Considered

- Plugin-based stages
- Remote stage registry
- User-defined stage loading

### Pros

- Smaller trust surface
- Easier testing
- Lower operational complexity

### Cons

- Less extensible in the short term

### Final Rationale

Built-in stages keep the first version maintainable and let the core contracts stabilize before extension mechanisms exist.

### Future Revisit Conditions

Revisit only after the built-in pipeline has proven stable and there is a clear extension demand.

## 6. Why explicit fallback?

### Decision

Fallback always returns the original raw input when the optimized result is unsafe.

### Context

TokenDamper must prioritize correctness over compression.

### Alternatives Considered

- Partial fallback
- Best-effort repair
- Silent degradation

### Pros

- Clear behavior
- Safe output path
- Easy to explain

### Cons

- Can reduce token savings in some failure cases

### Final Rationale

An explicit original-input fallback is the safest and most understandable behavior for MVP.

### Future Revisit Conditions

Revisit only if there is a demonstrated safe recovery path that can be proven better than original-input fallback.

## 7. Why no plugins initially?

### Decision

No plugin infrastructure exists in MVP.

### Context

Plugin systems add loading, isolation, versioning, and compatibility complexity.

### Alternatives Considered

- In-process plugins
- Out-of-process plugins
- Static built-in extension points

### Pros

- Lower complexity
- Fewer trust and compatibility issues

### Cons

- Less extensibility at first

### Final Rationale

The project should stabilize its core contracts before introducing third-party extension loading.

### Future Revisit Conditions

Revisit after the core stages, planner, and validation behavior are stable and benchmarked.

## 8. Why no DAG?

### Decision

No DAG execution in MVP.

### Context

The execution model does not yet require branching or parallel dependencies.

### Alternatives Considered

- DAG scheduler
- Conditional branching
- Hybrid graph executor

### Pros

- Keeps orchestration simple

### Cons

- Limits complex execution topologies

### Final Rationale

The extra orchestration cost is not justified before the core pipeline proves useful.

### Future Revisit Conditions

Revisit only after linear execution proves insufficient for real workloads.

## 9. Why no embeddings?

### Decision

No embedding-based similarity validation or ranking in MVP.

### Context

Embeddings add dependency weight, infrastructure decisions, and evaluation complexity.

### Alternatives Considered

- Embedding similarity scoring
- Semantic nearest-neighbor ranking
- Hybrid lexical/embedding validation

### Pros

- None that are necessary for MVP

### Cons

- Requires additional tooling and calibration

### Final Rationale

TokenDamper can prove useful with deterministic, structure-aware methods first.

### Future Revisit Conditions

Revisit only after the deterministic baseline is validated and a real semantic signal gap is documented.

## 10. Why no database?

### Decision

No database-backed state exists in MVP.

### Context

The system is local, deterministic, and fixture-driven at first.

### Alternatives Considered

- Embedded database
- External datastore
- Persistent analytics store

### Pros

- Less operational complexity
- Fewer failure modes

### Cons

- No persistent runtime history

### Final Rationale

A database is unnecessary before the core optimization path is proven.

### Future Revisit Conditions

Revisit only if persistent state becomes necessary for a proven runtime feature.

## 11. Why benchmarking is offline?

### Decision

Benchmarks are offline, deterministic, and fixture-driven.

### Context

Benchmarking should measure regression behavior without affecting runtime logic.

### Alternatives Considered

- Online telemetry-driven benchmarking
- Remote benchmark service
- Runtime self-optimization

### Pros

- Reproducible
- Easier to review
- Safer for contributors

### Cons

- Less real-time insight

### Final Rationale

Offline benchmarks are sufficient for protecting the MVP and are much easier to maintain.

### Future Revisit Conditions

Revisit only if the project later needs broader corpus management or distributed benchmarking.

## 12. Why explainability exists?

### Decision

Every optimization result includes a lightweight trace.

### Context

Users need to know what changed, why it changed, and when fallback happened.

### Alternatives Considered

- No trace
- Verbose telemetry system
- Debug-only logging

### Pros

- Builds trust
- Supports debugging
- Improves benchmark reviewability

### Cons

- Slight implementation overhead

### Final Rationale

Explainability is required for a system that rewrites context before it reaches an LLM.

### Future Revisit Conditions

Revisit only if trace structure becomes too expensive or if a more formal observability system becomes necessary later.

## 13. Why Deterministic AST/Hash Reduction over Neural Token Dropping?

### Decision

TokenDamper uses deterministic AST-validated, hash-based compression instead of neural or statistical token dropping (e.g., LLMLingua-2).

### Context

Neural token compressors drop tokens based on entropy probabilities, achieving high raw compression ratios but corrupting structured code and JSON tool schemas. In benchmarks like BFCL, these models degrade tool execution accuracy significantly (20%–27%) due to dropped required brackets, quotes, or keys.

### Rationale

Deterministic, AST-validated, hash-based approaches guarantee 100% syntax safety and reversible state restoration with zero neural or statistical hallucination risks.

## 14. Cache-First Prefix Stabilization Protocol

### Decision

TokenDamper enforces strict prefix stabilization rules, including pinning system prompts and tool schemas at index 0, and respecting 1,024-token cache block quantizations.

### Context

Major LLM providers (Anthropic Claude, OpenAI GPT-4o) employ strict positional prefix KV-caching. A single byte change in the early prompt prefix invalidates the entire downstream cached KV state, forcing full input re-parsing.

### Rationale

Modifying an early-turn prompt prefix is economically negative unless the compression slashes >90% of the prefix size. By keeping tool schemas and system prompts immutable and operating strictly after the stable prefix horizon, we maximize prompt cache hit rates and reduce API costs.

## 15. Zero-Code Local Proxy and MCP Server First Distribution Strategy

### Decision

TokenDamper prioritizes zero-code local proxy wrappers (`tokendamper exec`) and native MCP servers as its primary distribution and integration mechanisms, rather than complex application SDKs.

### Context

Developers overwhelmingly prefer transparent integration. Connecting multiple Model Context Protocol (MCP) servers can inject 10,000–30,000 input tokens of static JSON tool definitions into every single turn before user messages are processed, creating huge overhead.

### Rationale

A local proxy and MCP approach allows TokenDamper to deduplicate static schemas, track token usage invisibly, and implement circuit breakers without requiring users to alter their application code.
