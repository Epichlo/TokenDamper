# TokenDamper Roadmap

This roadmap matches the frozen implementation plan.

## Development Phases

- [ ] Phase 0: repository scaffolding and toolchain
- [ ] Phase 1: core types and config loading
- [ ] Phase 2: adapter and engine wiring
- [ ] Phase 3: planner and cleanup stages
- [ ] Phase 4: validation, fallback, and trace
- [ ] Phase 5: benchmark harness and fixture coverage
- [ ] Phase 6: hardening, regression fixes, and release packaging

## Milestones

- [ ] Milestone 1: project boots, config loads, CLI runs, and a no-op optimize path works end to end
- [ ] Milestone 2: request normalization and immutable core model are in place
- [ ] Milestone 3: planner returns deterministic plans and cleanup stages run in order
- [ ] Milestone 4: validation can force fallback to original input and trace is emitted
- [ ] Milestone 5: benchmark fixtures execute offline and report stable results
- [ ] Milestone 6: MVP is stable, documented, and regression-tested

## Build Order

1. [ ] Scaffold the repository toolchain and root package metadata
2. [ ] Create the core model and config schema
3. [ ] Wire the first adapter and engine skeleton
4. [ ] Implement the planner and stage registry
5. [ ] Add cleanup stages
6. [ ] Add validation and fallback
7. [ ] Add explainability trace output
8. [ ] Add the benchmark harness
9. [ ] Add integration tests and fixture coverage
10. [ ] Harden documentation and release packaging

## Expected Outputs

- [ ] Milestone 1 output: runnable CLI, config loads, no-op pipeline, basic logs
- [ ] Milestone 2 output: normalized request and immutable context bundle produced from input
- [ ] Milestone 3 output: deterministic plan and cleanup transforms applied in order
- [ ] Milestone 4 output: unsafe output falls back to original input, trace explains why
- [ ] Milestone 5 output: offline benchmark command runs and prints stable metrics
- [ ] Milestone 6 output: MVP-ready tool with tests, docs, and repeatable local runs

## Definition of Done

- [ ] Milestone 1: project builds, CLI runs, config resolves, and a no-op flow completes
- [ ] Milestone 2: core data model is immutable where required and covered by unit tests
- [ ] Milestone 3: planner and cleanup stages produce deterministic outputs with tests
- [ ] Milestone 4: validation blocks unsafe results and fallback returns the exact original input
- [ ] Milestone 5: trace is emitted and benchmark fixtures run offline with repeatable results
- [ ] Milestone 6: docs are current, tests pass, benchmark regressions are acceptable, and the repo is ready for MVP release

## Future Versions

Versioning is intentionally conservative.

- [ ] `v0.1.0`: MVP foundation with the frozen architecture contract implemented
- [ ] `v0.2.x`: hardening and stability releases based on MVP feedback
- [ ] `v0.3.x`: broader adapter and stage maturity, still within the frozen architectural boundaries
- [ ] `v1.0.0`: stable public release after the core behavior and benchmarks have proven durable

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the canonical system design and [DECISIONS.md](./DECISIONS.md) for architectural rationale.
