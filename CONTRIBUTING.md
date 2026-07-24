# Contributing to TokenDamper

Thank you for contributing to TokenDamper.

This project is governed by the frozen architecture described in [ARCHITECTURE.md](./ARCHITECTURE.md) and the decisions recorded in [DECISIONS.md](./DECISIONS.md).

## Code Style

- Keep changes small and focused
- Prefer immutable data structures for core domain objects
- Keep modules narrowly scoped
- Avoid hidden side effects
- Preserve deterministic behavior
- Use clear names that match the established terminology: `ContextBundle`, `OptimizationBudget`, `Planner`, `Engine`, `Validator`, `Fallback`

## Branch Naming

- `milestone/<short-name>`
- `fix/<short-name>`
- `docs/<short-name>`

Keep branch names concise and descriptive.

## Commit Conventions

Use small commits with descriptive subjects.

Recommended format:

- `feat(core): add immutable bundle model`
- `test(engine): cover fallback path`
- `docs: update architecture reference`

## Pull Request Process

1. Open a branch from `main`
2. Keep the PR focused on one milestone or one narrow fix
3. Include tests for behavior changes
4. Include benchmark updates when relevant
5. Update documentation when the contract changes
6. Request review only after local checks pass

## Testing Requirements

- Unit tests are required for core model, planner, validation, fallback, and stage behavior
- Integration tests are required for engine flow and adapter round-trips
- Regression coverage is required for any change that affects output shape or fallback behavior

## Benchmark Requirements

- Benchmark changes must be intentional and reviewable
- Offline fixtures should be updated only when the change is expected and understood
- Performance regressions must be called out in the PR

## Review Checklist

- [ ] Change matches the frozen architecture
- [ ] No new feature surface was introduced
- [ ] No architecture was silently altered
- [ ] Tests were added or updated
- [ ] Benchmark impact was checked where relevant
- [ ] Documentation was updated where needed

## Documentation Expectations

Update the following when behavior changes:

- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [DECISIONS.md](./DECISIONS.md)
- [ROADMAP.md](./ROADMAP.md)
- [CHANGELOG.md](./CHANGELOG.md)

## Architecture Rules

- Do not introduce plugins in MVP
- Do not introduce DAG execution in MVP
- Do not introduce embeddings in MVP
- Do not introduce a database in MVP
- Do not introduce strategy generation in MVP
- Do not introduce multi-adapter support in MVP

## Proposing Architectural Changes

Architectural changes require an update to [DECISIONS.md](./DECISIONS.md) before implementation work begins.

That update must include:

- the decision
- context
- alternatives considered
- pros
- cons
- final rationale
- future revisit conditions

Do not implement architectural changes first and document them later.
