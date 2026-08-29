# Architecture Decisions

This document records the architectural decisions behind TokenDamper.

It should grow over time. Any future architectural change must update this document before implementation.

> **Citations to retired documents are deliberate and are not broken links.** Audit M11 retired
> twelve narrative files whose conclusions had already been folded into the entries below. Older
> entries still cite them by name, because those citations were accurate when the entry was
> written and this is an append-only record — rewriting them would falsify the history it exists
> to keep. `docs/retired-documents.md` maps each file to where its conclusion lives now and gives
> the `git show` command to read the original.

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

## 16. Recoverable References Are Not Semantic Drift

### Decision

`cleanup:session-dedup` tags its elisions `recoverable: true`, and `DriftTracker` substitutes
the pre-optimization content for those items before computing `S_k`. Lossy elisions
(`compression:token-hashing`, `compression:delta-compression`) carry no such flag and remain
fully scored against the `S_k <= 0.40` threshold.

### Context

Routing the Gateway through `core/engine.optimize()` (Phase 1.0b) subjected cross-turn
deduplication to the drift validator for the first time. Drift is computed from AST symbol
and structural marker retention, so replacing a message with `[TokenDamper Elided: ref=...]`
drops every symbol that message contributed. A representative code payload scored `S_k =
0.60`, well past the threshold, forcing a fallback.

That behavior is inverted: drift rose with the *size* of the deduplicated block, so the
validator vetoed deduplication most aggressively on precisely the payloads the Gateway
exists to shrink.

### Alternatives Considered

- A higher, Gateway-specific `maxDriftThreshold` — a magic number that weakens the
  invariant for lossy stages on the same path, rather than drawing a principled line.
- Accepting the fallbacks — honest, but reduces Gateway savings toward zero in its best
  cases and makes the safety net indistinguishable from an off switch.
- Excluding elided items from both sides of the ratio — distorts the denominator and
  silently shrinks the evidence base the metric is computed from.

### Rationale

A dedup marker is a *pointer*: the full text is retained in the session store under
`originalContentHash` and is restorable on demand. Nothing is irrecoverably lost, so nothing
should be scored as loss. Drift exists to catch irreversible semantic damage, and keeping
recoverable references out of it preserves the invariant's meaning for the lossy stages that
genuinely need policing.

### Consequences

The exemption is keyed on an explicit `recoverable` flag rather than inferred from `elided`
or `originalContentHash`, both of which `token-hashing` also sets. Any future stage claiming
the exemption must guarantee the same restorability contract, or the drift invariant
silently stops protecting that path.

## 17. A Fenced Block Is Markdown, Not Code

### Decision

`classifyContent` detects `code` by **file extension only**. The triple-backtick fence, its
only content-based signal, now counts toward `markdown` instead.

### Context

`selectValidator` dispatches `contentType: 'code'` to the **TypeScript** validator. The
fence rule therefore meant that any document quoting a snippet — "here's the fix:
```ts ... ```", the single most common shape of an assistant message — was parsed as
TypeScript in full, prose included.

Measured on the Gateway path, turn 1, with no stage having transformed anything:

| Message | Classified | Validator | Result |
|---|---|---|---|
| `Here's the fix. It's the guard that's missing:` + ```` ```ts ```` block | `code` | typescript | **fallback** — `AST_UNTERMINATED_STRING` |
| `Here's the fix, it's ready:` + ```` ```ts ```` block | `code` | typescript | pass |

The two differ only in how many contractions the prose contains. Three apostrophes leave an
odd number of quote characters open; two do not.

### Alternatives Considered

- **Stop mapping `contentType: 'code'` to the TypeScript validator.** Larger blast radius —
  several call sites legitimately rely on it — and it treats the symptom. `code` is a family
  (`go`, `rs`, `sh`, `sql` all classify as `code`), so validating any of it as TypeScript is
  unsound for reasons that have nothing to do with fences.
- **Keep the fence rule, classify as `code` only when the fence spans the whole document.**
  A heuristic on top of a heuristic, and it still parses a Python fence as TypeScript.
- **Accept the fallbacks.** Fail-open means output stays byte-correct, so this is safe — but
  it is silent, and it fires on ordinary traffic.

### Rationale

A code file does not contain fences; a document that quotes code does. The rule had the
relationship inverted, so its only reachable outcome was a false positive: a whole-document
language validator cannot know what a mixed prose/code document *should* parse as, and it
therefore cannot catch a real defect in one. A check decided by apostrophe parity is not
validating anything, so it is removed rather than tuned.

### Consequences

Detection of real code is unchanged: every path carrying actual source files supplies an
extension, which is what `isCodeExtension` matches. Content-only code arriving without an
extension already classified as `text` — the fence rule never covered that case either.

The remaining unsoundness is recorded but out of scope: `contentType: 'code'` still selects
the TypeScript validator for extensions with no validator of their own (`go`, `rs`, `sh`,
`sql`), where a Rust lifetime (`&'a str`) or an unbalanced shell quote produces the same
class of false positive. That reaches the CLI path only, and predates this decision.

### Future Revisit Conditions

Revisit if per-language validators land for the extensions currently routed to TypeScript,
or if fenced-block-aware validation (validate each fence under its own tagged language,
ignore the prose between them) is implemented — that, not a classifier tweak, is what would
make content-based code detection meaningful.

## 18. For Code, 40% of the Drift Metric Is a Constant

### Decision

Recorded as a standing finding, not yet acted on: on code content, the structural half of
the semantic drift metric (`w_struct = 0.40`) cannot vary, so `S_k` is effectively
`0.6 × (1 − R_AST)` and is confined to `[0.00, 0.60]`. The `0.40` threshold sits at
two-thirds of a maximum the metric can never reach.

**The threshold is not changed by this entry.** This records *why* tuning it would be the
wrong instrument.

### Context

```
S_k = 1 − (w_AST · R_AST + w_struct · R_struct)      w_AST = 0.60, w_struct = 0.40
```

`R_struct` is computed from `DriftTracker.extractMarkers`, which harvests `filepath:`
markers, markdown headings, code fences, `TD_PRESERVE:` directives and section delimiters.
A source file typically contains none of the latter four, so its marker set is exactly one
entry: `filepath:<path>`.

That marker is derived from `item.path` — **metadata**. Every eliding stage rewrites
`content` and leaves `path` untouched. The marker therefore survives by construction, and
`R_struct = 1.0` no matter how completely the content is destroyed. Measured on the bundled
bench fixtures: markers before and after are identical in every case, and `R_struct` is
`1.0000` across Python, TypeScript and JavaScript.

Full measurements in `docs/phase-1d-drift-investigation.md` §5.

### Alternatives Considered

- **Lower the threshold for code.** Treats the symptom. A threshold cannot recover
  discriminating power from a term that does not vary.
- **Reweight — raise `w_AST` toward 1.0 for code.** Honest about `R_struct` being inert, but
  it silently concedes that structural integrity is unmeasured on code rather than fixing
  it, and it bakes a content-type branch into the formula to compensate for a gap in the
  marker extractor.
- **Drop `filepath:` from the marker set.** Would make `R_struct` default to `1.0` via the
  `markersBefore.size === 0` guard — the same constant, arrived at more obscurely.

### Rationale

A metric term that cannot vary is not conservative, it is decorative. Worse, it is
*confidently* decorative: it contributes a full 0.40 of "retention" on every code payload,
which reads as evidence that structure was preserved when nothing about the content's
structure was examined at all. That is the same shape as the hardcoded `fallbackUsed: false`
(§ Phase 1.0a) and the vacuous JSON checks (Issue 2, Commit C) — a value asserted without
being derived.

The finding is separable from the granularity cause that dominates the current failures.
Whatever fixes granularity, this stays true until `extractMarkers` learns structural markers
that (a) live in the content and (b) are meaningful for code — nesting depth, function and
class boundaries, import blocks, brace balance.

### Consequences

- Any future comparison of `S_k` across content types is comparing a two-term metric on
  prose and markdown against a one-term metric on code. They are not the same scale.
- The observed `S_k = 0.60` on every failing code fixture is the **ceiling**, not a
  midpoint. Reporting it as "drift 0.60 out of 1.00" overstates the headroom by 40 points.
- A Python file with `#` comments currently *can* exceed 0.60, but only through a defect in
  `extractMarkers`, which reads Python comments as markdown headings. Fixed separately; it
  is not evidence that `R_struct` does real work.

### Future Revisit Conditions

Revisit when `extractMarkers` gains content-derived structural markers for code, or when a
per-language structural signal replaces the current markdown-oriented marker set. At that
point `R_struct` becomes load-bearing and the weights are worth re-deriving from
measurement rather than inherited from `milestone_7_architecture_spec.md`.

---

## 19. One Token Estimator, Chosen for the Seam and Not for Accuracy

### Decision

Every site that estimates tokens routes through `estimateTokens` /
`estimateBundleTokens` in `src/core/hashing/tokenizer.ts`. `EnhancedHeuristicTokenizer`
remains the default via `DEFAULT_TOKENIZER`. The inline `Math.ceil(len / 4)` form is gone
from the codebase; `countTokens` is now called from exactly one place.

The default is **not** chosen because it is the more accurate estimator. Measured, it is
the less accurate one. It is chosen because it is the extension point.

### Context

Two independent estimators coexisted. `createContextBundle` measured the input side with
`EnhancedHeuristicTokenizer`; the trace, the engine's rehydration path, the Gateway's
bundle constructors and three of the five stages measured the output side with
`Math.ceil(len / 4)`. Every reduction ratio in the product compared one against the other.

The heuristic runs 11–22% above `len / 4` on the project's corpus, so **byte-identical
output registered as an 11–22% saving**. The benchmark published it as
`avgReduction: 7.82%` while every one of the ten fixtures emitted its input verbatim. The
MCP adapter's `reductionRatio` divides `trace.tokenAfter` by `trace.tokenBefore` — opposite
sides of the same seam — so it reported a saving on pure fallbacks too, where the emitted
text is `request.rawInput` unmodified.

Two smaller variants of the same fault were folded in: `session-dedup` and
`delta-compression` reported `tokenEstimateSaved` as `ceil(bytesSaved / 4)`, a third unit
that could disagree in sign with the bundle totals it sat beside; and the Gateway measured
its input bundle as `ceil(statistics.totalCharacters / 4)`, which omits the N−1 newlines
the bundle render inserts, so its input and output sides counted different strings.

### Alternatives Considered

- **Standardize on `ceil(len / 4)`.** Measured against `cl100k_base` over the ten bench
  fixtures plus the four Gateway payloads, it is the *more* accurate of the two — mean
  absolute error 17% against the heuristic's 24%, max 44% against 56%. Rejected anyway.
  `TokenizerAdapter` is the declared plug point for a real BPE tokenizer, and
  `createTiktokenAdapter` already implements it; standardizing on inline arithmetic would
  mean the roadmap's pluggable-tokenizer work has to re-introduce a seam at nine sites.
  It also breaks the planner: `cache-aware.ts` derives knapsack weights and 1,024-token
  cache-block boundaries from the adapter, and `validation/index.ts` compares
  `summary.tokenEstimate` against `budget.maxInputTokens`. Splitting those units would put
  budget enforcement and budget selection on different scales — the same mismatch,
  relocated.
- **Switch the default to a naive char adapter behind the same interface.** Keeps the seam
  and takes the accuracy win. Rejected *for this change only*: it moves every published
  number at the same moment as the unification, and it silently redefines what a user's
  existing `maxInputTokens` means. It is a defensible follow-up, made in one place, on its
  own evidence.

### Rationale

A reduction ratio is a comparison, and a comparison is only as sound as the agreement
between its two sides. Its correctness does not depend on either estimator being accurate —
it depends on both being *the same*. Accuracy and unity are separable properties, and only
one of them can produce a number that claims a saving where no bytes were saved.

This was the sixth instance of the project's recurring pattern (`CLAUDE.md` invariant 10)
and the first where the vacuous value reported **success** rather than a passed check. A
fabricated 7.82% is worse than a fabricated green check, because nobody investigates a
number that flatters them.

### Consequences

- **`avgReduction` on the bundled bench corpus is 0.00%, not 7.82%.** That is the true
  figure: all ten fixtures emit byte-identical output. `fallbackRate` (0.40) and
  `totalValidationIssues` (4) are unchanged — those were never computed across the seam.
- Absolute token counts on the Gateway rise by roughly the heuristic's margin over
  `len / 4` (measured: `rawTokens` 8,470 → 10,059 on a 36 KB payload). Its *ratio* barely
  moves (49.79% → 49.82% on within-payload dedup) because both of its sides already used
  the same estimator. The Gateway results recorded elsewhere in this repo were derived from
  HTTP body byte lengths, not from these counters, and are unaffected.
- The published accuracy gap is a real open item. `EnhancedHeuristicTokenizer` is named as
  though it improves on `len / 4`; on this corpus it does not. Recalibrating its
  coefficients, or landing `createTiktokenAdapter` against a real encoder, is now a
  one-line change to `DEFAULT_TOKENIZER`.
- `test/unit/token-estimator-unity.test.ts` pins the property: byte-identical output must
  measure as exactly 0% reduction, on the engine path, on the fallback path, and for every
  stage in the catalog.

---

## 20. Elide Function Bodies, Not Whole Items

### Decision

`compression:token-hashing` elides **function bodies** within an item, keeping the
declarations around them, and falls back to whole-item hashing only where no region can be
selected. Region selection lives behind `selectElisionRegions`; replacement goes through
`elideRegions`, a sibling chokepoint to `elideItem`.

Class bodies are never selected. Comment-and-docstring-only regions are never selected.
JSON is never selected.

### Context

Whole-item hashing could not succeed on a single-item code bundle, structurally: it replaces
every byte, so every symbol dies at once, `DriftTracker`'s `R_AST` is a boolean, and `S_k`
pins at the formula constant `0.60` — over the `0.40` gate, every time
(`docs/phase-1d-drift-investigation.md` §6). Regions give the metric something fractional to
grade, and measured, it grades correctly.

For code, `R_struct` is pinned at `1.0` (§18), so the gate reduces exactly to
**`R_AST ≥ 1/3`**.

### Alternatives Considered

- **Mark hashed placeholders `recoverable: true`.** Rejected before design. §16 established
  that `recoverable` is a claim about *this* payload, verifiable only when an intact copy
  survives in it. Token-hashing has no such copy. Asserting recoverability because
  rehydration machinery exists somewhere is what produced the inflated 98.59% figure.
- **A fixed nesting depth (`depth-2`).** This was the design's own recommendation and it was
  wrong — derived from measuring one class-shaped file. It misses top-level function bodies
  entirely and is arbitrary wherever nesting differs. Measured over six real sources,
  function-body selection yields **57.38%** mean reduction against depth-2's **37.95%** on
  the same usable set, and on `ts-validator.ts` depth-2 destroys the sole method's signature
  set (`R_AST` 0.2667, correct fallback) where function-body selection does not.
- **Innermost brace spans.** Safe but nearly worthless: 10.06% mean. Innermost spans are
  `if`/`for` blocks, not bodies.

### Rationale

Two boundary rules govern where a region may start and end, and both were found by
measurement rather than reasoning:

1. **The region must be exactly the bytes replaced.** `TokenHasher.rehydrateText`
   substitutes in place, so anything the caller adds around the marker survives rehydration.
   A prototype emitting `indent + marker` scored **0/7** on byte-identical round trip;
   removing the added indent scored **7/7**.
2. **The marker must land in a syntactically valid position.** Rule 1 alone puts a Python
   marker at column 0, which `PythonValidator` rejects. Applying rule 1 without rule 2 took
   AST validity from **8/8 to 0/8**.

They are only jointly satisfiable if the region excludes the leading indentation.

The post-condition is **relative** — no *new* AST issues — unlike `elideItem`'s absolute
check. An absolute check is unusable here for two measured reasons: three of the ten bundled
bench fixtures are truncated completion prompts, invalid on input; and `TypeScriptValidator`
has no regex-literal mode, so it rejects valid TypeScript containing `/\([^)]+/`. Under an
absolute check both classes yield 0% forever. This follows the precedent already in
`BenchmarkEvaluator.syntaxPreserved`.

The docstring guard is the Phase 1d precondition (design §8b). `HumanEval/0` elides to
**55.66% reduction at `S_k = 0.0000`**, AST-valid and byte-reversible — and the region
removed is the function's docstring, which is the entire specification of the task. Drift
cannot see it: docstrings carry no symbols and `R_struct` is inert for code. **This guard
defends that case, not the class.** Any other high-information symbol-free content is still
invisible to the metric. The real fix is §18.

### Consequences

- Measured over 52 real source files through the CLI: **22 reduce with no fallback, mean
  52.99%**. Output is byte-identical across fresh processes (6/6). Every elision round-trips
  exactly through the existing recovery valve.
- The bundled bench corpus stays at **0.00%**, deliberately. Five HumanEval fixtures are
  docstring-only prompts the guard refuses; four CodeXGLUE fixtures are truncated stubs with
  no complete body. It is a completion benchmark, not a compression corpus, and it should
  stop being cited as a measure of reduction.
- The remaining fallbacks are the safety net working: 17 of 30 on constraint-directive
  retention (an imperative comment inside an elided body), 11 on drift over `0.40` (too much
  symbol loss), 2 on the regex-literal validator defect.
- The recovery valve needed **no change**: `rehydrateText` already resolves N placeholders
  per item. Regions make *partial* un-hashing possible — undo the fewest needed to clear
  `R_AST ≥ 1/3` — which is the natural bridge to Phase 1c. Not built here.
- On the CLI a successful optimization now emits `<BLOCK_HASH:…>` markers the consumer
  cannot reverse; the `TokenHasher` is created inside the stage and discarded. Previously
  this never surfaced because everything fell back. MCP has `rehydrate_context`; the CLI does
  not. This needs a decision before the CLI is used to feed a model directly.

---

## 21. A Latency Budget Must Not Vote on Correctness

### Decision

`validateItemAst` measures its 5ms budget and reports the breach on
`AstValidatorResult.slaExceeded`. It no longer sets `valid: false` or emits an
`AST_SLA_EXCEEDED` issue.

### Context

Identical bytes produced different syntax verdicts depending on machine load and JIT warmth.
Measured on a 16 KB Python file across six fresh Node processes:

```
valid(4.06ms)  INVALID(5.28ms)  INVALID(6.86ms)  INVALID(8.04ms)  INVALID(14.70ms)  INVALID(17.58ms)
```

It also produced false fallbacks on large valid files: `codebase.py` fell back on
`AST validation exceeded SLA threshold (5.99ms > 5ms)` with drift at `0.00`, every other
check passing, and 19 regions successfully elided. The engine reported a syntax error that
did not exist.

### Rationale

Determinism is the product; a validator that answers differently on a busy machine is not
one. And a slow validation says nothing about whether content is syntactically valid — this
is the inverse of invariant 10's pattern: not a check passing without running, but a check
*failing* for a reason it never examined.

### Consequences

- Large files are validated on their merits. `codebase.py` reduces 34.76% end-to-end.
- Latency remains observable via `slaExceeded` for anyone who wants to act on it.
- The `enforces maxTimeMs SLA` case in `ast-validator.test.ts` was re-pointed at the new
  contract. That is a changed requirement, not a weakened assertion: the new case asserts
  strictly more (validity unchanged **and** the breach reported **and** real syntax errors
  still surfacing).

## 22. A Filename Extension Outranks a Content Probe

### Decision

`classifyContent` resolves every recognized filename extension before it runs any content
probe. `looksLikeHtml` requires a matched open/close tag pair rather than an angle bracket
somewhere. `looksLikeLogs` asks whether the input is predominantly log lines, using a
per-line predicate that recognizes ISO-8601 timestamps.

### Context

Measured against this repository's own sources, the previous classifier answered:

```
  46  ts -> html          e.g. src/adapters/mcp/index.ts
  10  ts -> code          e.g. src/adapters/cli/index.ts
  11  md -> yaml          e.g. ARCHITECTURE.md
  10  md -> html          e.g. CHANGELOG.md
   2  md -> markdown      e.g. SECURITY.md
   1  txt -> text         tokendamper-benchmark/test_data/sample_logs.txt  (75 log lines)
```

Three independent causes, each a check that returned a confident answer without examining
the thing it claimed to detect:

1. `/<\/?[a-z][\s\S]*>/i` — `[\s\S]*` is greedy and unanchored, so the match spanned from
   the first `<letter` to the **last** `>` in the input. One generic parameter plus any
   later `>` was sufficient, and TypeScript guarantees both.
2. Probes ran before extensions; `isCodeExtension` was consulted fifth, after json, yaml,
   html and logs. An early probe therefore overrode an extension that would have decided
   correctly.
3. `looksLikeLogs` missed ISO-8601 twice over: its first alternative required the severity
   level **before** the date (real lines are date-first), and its second,
   `/\b\d{2}:\d{2}:\d{2}\b/`, cannot match `T19:00:01` — `T` and `1` are both word
   characters, so there is no word boundary before the hour.

### Rationale

An extension is a declaration by whoever named the file. A probe is a guess about bytes.
When both are present, the declaration wins; probes exist to serve the case where there is
no filename at all, which is exactly the Gateway and MCP shape.

This is the seventh instance of the invariant 10 pattern in this project, and the first
where the mis-answer was *positive* rather than vacuous: the classifier did not decline to
answer, it answered `html` with confidence.

### Consequences

- All 57 TypeScript sources in `src/` classify as `code`; every document in `docs/` as
  `markdown`; `sample_logs.txt` as `logs`. Pinned in
  `test/unit/content-classification.test.ts` against the repository itself, not synthetic
  strings, because that is the corpus the defect was found on.
- It partially reopens Phase 1a. See §23.
- `looksLikeYaml` remains `/^(---\s*$)?([\w.-]+:\s+.+)$/m`, which matches any line of the
  form `word: value` — including ordinary prose. It is untouched here because the extension
  reordering removes its blast radius on named files, and because a loose probe that
  produces a type with no validator is now *visible* rather than silent (§23). It is still
  the loosest probe in the chain and should be tightened before anything starts trusting
  `yaml` for a decision. **Tightened in §27** — and the premise that the tag was inert was
  wrong: `DriftTracker` was already trusting it.

## 23. "No Validator Applied" Is Not "The Check Passed"

### Decision

`AstValidatorResult` gains `validated: boolean`. `selectValidator`'s content-type dispatch
becomes a total `Record<ContentType, AstValidator | null>`. `ValidationReport` and
`OptimizationTrace` carry `astCoverage`, and `validate()` scopes `passed`, `shouldFallback`
and `reason` to `severity: 'error'` so a coverage report cannot force a fallback.

### Context

**This partially reopens Phase 1a.** The Gateway fix (`ac16cec`) replaced a hardcoded
`contentType: 'text'` with `classifyContent`, and the record — `CLAUDE.md`,
`docs/issue-2-content-type-contract-design.md` §2.2 — treats that as closing the
"no validator runs at all on Gateway items" hole. It closed the JSON half. It did not close
the code half, and by §22 it made that half worse: `classifyContent` answered `html` for
TypeScript, `selectValidator` had no `html` branch, and a pathless item therefore got no
validator at all. Measured on a TypeScript file with an unterminated string literal:

```
  with path (CLI file arg)    contentType=html   validator=typescript  valid=false  issues=1
  no path (Gateway message)   contentType=html   validator=NULL        valid=true   issues=0
```

The CLI is rescued by `selectValidator`'s path-extension branch. A provider message has no
path, so `contentType` is its only signal — which is the shape the Gateway carries.

### Rationale

§22 fixes the three regexes, but fixing them leaves the mechanism intact: `classifyContent`
could still emit a tag that dispatch has never heard of, and the failure mode of that
mismatch is *silence*. `valid: true` meant both "examined and clean" and "nothing looked".

Two routes were available: make dispatch handle every emittable type, or bind the two so an
unhandled type cannot exist. `Record<ContentType, …>` delivers both at once — every member
must be assigned a validator or an explicit `null`, and adding a member to `ContentType`
without deciding is a compile error. No runtime `assertNever` is used, deliberately: a throw
inside `selectValidator` would sit in the fail-open path and violate invariant 3, so the
runtime edge indexes and falls back to `null` for a forged tag.

The conflation itself is fixed on the *result*, not on the selector's return. `null` from a
lookup is a fine answer to "which validator covers this"; the defect was that
`validateItemAst` turned that answer into `valid: true` and discarded it. `validated: false`
is now the record that nothing ran.

`valid` deliberately stays `true` for an unchecked item. Inverting it would fall the engine
back on every prose message, which is a policy change, not a correctness fix — and there is
no AST-lite validator for prose, nor should there be (§17).

### Consequences

- The CLI writes `result.trace` to stderr and emits nothing else about validation, so
  `astCoverage` on the trace is what makes coverage visible on the one entry mode with no
  session and no second chance to notice.
- `passed` is now `errors.length === 0` rather than `issues.length === 0`. Equivalent today —
  every other issue pushed is an error — but it makes `severity` load-bearing instead of
  decorative, and stops any future informational finding from forcing a fallback.
- `AstValidator.validate` returns the narrower `AstCheckResult`. A validator cannot claim
  `validated`; by running, it is the validation.
- Pathless code is still unvalidated — it is now *reported* as unvalidated rather than passed.
  Closing that needs content-only code detection, which §17 removed on purpose. This decision
  makes the hole visible; it does not fill it.

## 24. An Elision Marker Must Say What It Replaced

### Decision

`compression:token-hashing` emits
`[TokenDamper: <N> <kind> lines elided, <B> bytes, sha256:<12 hex>]` on both the sub-item and
the whole-item path, rendered by one shared `core/elision.renderElisionMarker`. The digest is
a field in the marker, never the whole of it. `TokenHasher` resolves the truncated digest via
a prefix index and refuses an ambiguous prefix rather than guessing.

### Context

The marker was `<BLOCK_HASH:` + the full digest + `>`, and on the CLI it resolved to nothing —
see §25 for why the store never existed. So the reader of a CLI run received, in place of a
function body:

```
        <BLOCK_HASH:4af59ca48228134eb02432340ad1aa61a7ccab427f407c0fbe22cdbf9ee33e90>
```

which says that *something* was removed and nothing else. Not what, not how much, not whether
it mattered. The same elision now reads:

```
    def __init__(self, failure_threshold: int = 5, recovery_timeout: float = 30.0):
        [TokenDamper: 5 function-body lines elided, 202 bytes, sha256:4af59ca48228]
```

`cleanup:session-dedup` already emitted `[TokenDamper Elided: ref=… bytes=… kind=…]`, and
`compression:delta-compression` a labelled unified diff. `token-hashing` was the only stage
whose output told its reader nothing, and it is the only one that runs on the CLI.

### Rationale

MCP and the Gateway hold session state, so a marker there can be a pointer. The CLI is a
one-shot pipe with no session on either end, so there is nothing for a pointer to point at
and the marker has to carry the information itself. The rule that follows: **on a one-shot
path, every elision must carry in-band enough for a reader with no external state to know
what was removed.**

The hash stays because it is what identifies a block across turns and what a caller holding
the content can verify against. Twelve hex characters carry that; sixty-four would be 53% of
the marker and would defeat the readability the marker exists for. An ambiguous prefix
resolves to nothing, which is the behaviour `rehydrateText` already had for any unknown hash.

### Consequences

- **Byte cost: none — it is slightly cheaper.** `codebase.py` through the real CLI:
  16,937 → 11,360 bytes before, → **11,328** after. The marker is 75 bytes against the old
  77 in the common case, because a truncated digest buys back more than the words cost.
- **Token cost depends on the estimator, and the two disagree in sign.** For one real marker:
  `EnhancedHeuristicTokenizer` scores the new form **+1** token, `ceil(len / 4)` scores it
  **−1**. Controlled A/B over the frozen 80-file corpus: identical files kept (22), identical
  fallback causes, mean over kept 55.50% → 55.09%. That −0.41pp is the heuristic's opinion,
  and the heuristic is the *less* accurate of the two by measurement (§19: 24% MAE against
  17%). Under a real BPE encoder a 64-character random hex string costs roughly 25 tokens
  while the same span of English words costs roughly 18, so the sign would likely invert —
  but `createTiktokenAdapter` is unwired, so that is reasoning, not a measurement, and it is
  recorded as such.
- One format is written; `<BLOCK_HASH:…>` is still *read*, so text captured before this
  change still round-trips. `TokenHasher.createBlockPlaceholder` still produces the old form
  and is still tested.
- `BLOCK_PLACEHOLDER_BYTES` now aliases `ELISION_MARKER_BYTES` (80, derived in `marker.ts`),
  moving the region floor from 101 to 104 bytes. It remains a pre-filter, not a correctness
  dependency — `elideRegions` measures the real replacement against the real region.
- `ELISION_MARKER_PATTERN` is deliberately specific rather than `\[TokenDamper[^\]]*\]`, so
  it cannot swallow the other two stages' markers and hand them to the wrong resolver.

### Rejected: gating the whole-item branch off for prose and logs

The proposal was that whole-item elision on prose and logs is "compute that can only produce
fallbacks", so it should not run. **Measured, that premise is false.** Whole-item elision
succeeds on both when the item carries no imperative directive:

```
  prose only              prose:WHOLE   passed=true  S_k=0.00  saved=78.4%
  logtail only            logs:WHOLE    passed=true  S_k=0.00  saved=97.5%
  code + prose + logtail  code:region prose:WHOLE logs:WHOLE  passed=true  saved=62.6%
```

It fails on 16/16 of this repository's prose files because 15 of them are engineering
documents dense with "must" and "do not", and on `sample_logs.txt` because that fixture has a
planted imperative line (Issue 4). That is a property of the corpus, not of the content type.

A static content-type gate is also the wrong shape independently: whether an elision survives
depends on whether *this bundle* carries directives and symbols, which differs between a
single-item CLI bundle and a multi-item Gateway one. Gating by content type would delete the
78–97% case above — a log tail piped into the CLI is exactly the input this product exists
for, and exactly the example the descriptive-marker rule was written from.

## 25. Do Not Manufacture the State That Makes a Claim True

### Decision

`compression:token-hashing` uses a `TokenHasher` only when the caller supplies one. The
`?? new TokenHasher()` default is gone. Reversibility is recorded on the item
(`metadata.reversible`), in the stage metrics (`irreversibleElisions`) and in the stage notes.

### Context

The stage's docblock said it "converts eligible context items into reversible
`<BLOCK_HASH:sha256>` placeholders", and line 23 read
`options?.tokenHasher ?? new TokenHasher()`. The fabricated store registered every elided
block and was collected when the stage returned. Measured on `codebase.py` through the real
binary:

```
  input bytes  : 16937
  output bytes : 11360
  placeholders : 19
  a fresh TokenHasher resolves: 0/19
```

Nothing noticed, twice over. `detectCorruptedPlaceholders` is written
`if (hash && hasher && !hasher.hasHash(hash))`, so with no hasher it cannot push and reported
a clean result on the one path where every placeholder was unresolvable — the eighth instance
of the invariant 10 pattern. And `attemptAutomatedRehydration` opens with
`if (!hasher && !ledger) return undefined`, while `src/cli/main.ts:125` passes neither, so the
recovery valve returned before examining an item.

### Rationale

The obvious fix — thread a hasher from the CLI, or write a sidecar map beside the output —
would make "reversible" true of the process while leaving the reader of the pipe exactly as
badly off. That is the same shape as the retracted 98.59% figure: a number that was correct
about something nobody was asking. Reversibility on the CLI is not unimplemented, it is
unachievable; a one-shot pipe has nowhere for a store to live.

So the state is not manufactured. The absence is recorded, and the marker is made to stand on
its own instead (§24).

### Consequences

- Emitted bytes do not depend on whether a hasher was passed, and a test pins that.
  Reversibility is a property of who holds the content, not of the transform; if the two
  diverged, the CLI and MCP would silently produce different output for the same input.
- `detectCorruptedPlaceholders` returns early without a hasher, and says why. It is *correctly*
  inert there: with no store nothing claims to hold the content, so there is no broken promise
  to detect. Reporting every CLI elision as corruption would be equally wrong.
- The CHANGELOG's Phase 1d line "every elision reversible through the existing recovery valve"
  is withdrawn. That measurement injected a hasher and the sentence was attached to a CLI run
  that had none.

## 26. A Regex Literal Is Not Brackets

### Decision

`TypeScriptValidator` tracks regex literals. A `/` opens one where a value may begin — after
the punctuation set `scanBraceSpans` already uses, or after a reserved word that cannot end an
expression — and the brackets, quotes and slashes inside it are literal text. An unterminated
literal is dropped at the newline rather than run to end of input.

### Context

The validator presented itself as a bracket/quote/comment scanner sufficient to judge
TypeScript, and `validate()` runs it over every item in every bundle. It did not know regex
literals existed, so it counted the brackets inside them:

```
const re = /([^)]+/;     ->  INVALID (AST_UNBALANCED_BRACKET)
const x = (a + b) / 2;   ->  VALID
```

Measured over this repository's own 64 TypeScript sources, **7 were rejected by their own
project's validator**, every one for a regex literal:

```
src/cli/diff-renderer.ts:236        /(\[TokenDamper[^\]]*\])/g
src/cli/html-reporter.ts:316        /(\[TokenDamper[^\]]*\])/g
src/core/elision/regions.ts:50      /\)\s*(?::\s*[^{;=]+)?$|=>$/
src/core/ledger/drift-tracker.ts:258  /"([^"\\]+)":/g
src/core/model/constructors.ts:553  /(?:^|[\s[(<|])(?:TRACE|DEBUG|…)(?:$|[\s\])>:,|])/
src/core/topology/dependency-graph.ts:21  /\\/g
src/core/topology/git-inspector.ts:30     /\\/g
```

Three of them are the classifier's own regexes, from the fix in §22 — the change that made
`classifyContent` correct also handed the validator content it could not read.

### Alternatives Considered

- **Leave it: it fails closed.** The direction of failure is right — the pipeline falls back
  and the user gets their input — which is why this was recorded rather than rushed
  (`NOTES-FOR-DOCS.md`). But a check that answers "invalid" without examining what makes it
  invalid is the same defect as one answering "valid" without looking; invariant 10 is about
  verdicts that were not derived, in either direction. And the cost is not only yield: a
  validator that rejects ordinary code cannot be a backstop for anything inside a literal,
  which is why `elideRegions`'s post-condition had to be relative in the first place.
- **Share one scanner with `scanBraceSpans`.** The right end state, and deliberately not done
  here. `scanBraceSpans` decides *elision boundaries*; changing it changes what the product
  removes, which is a behavioural change wearing a refactor's clothes. The rule is duplicated
  and the duplication is named at both sites instead.

### Rationale

The disambiguation is the whole problem: `/` is division or a literal depending on what
precedes it. Two rules, both conservative in the direction that matters:

1. **The punctuation set is copied from `scanBraceSpans`, not re-derived.** That scanner
   learned regex literals first, *because* this validator could not be trusted to catch a
   boundary it got wrong inside one. Two different answers to "where does this literal start"
   would be worse than one imperfect answer.
2. **Reserved words only.** `return /^([a-z]+/.test(s)` was still rejected under the
   punctuation rule alone. A reserved word can never be the end of an expression, so a `/`
   after one cannot be division — which makes the rule sound rather than heuristic. `in` and
   `of` are excluded: both are legal identifiers in enough positions that `of / 2` is
   expressible, and a wrong guess turns real code into a swallowed literal.

The newline bail-out is the containment property. A misread `/` costs at most the rest of one
line, never the rest of the file.

### Consequences

- **0 of 64 `src/` sources and 0 of 46 `test/` sources are now rejected**, from 7 and 0.
  Pinned by a corpus test over `src/**/*.ts`, following §22's precedent — the defect was found
  on real files and a synthetic string would not have caught it.
- End-to-end on the frozen 68-file corpus, engine varied and input held constant: fallbacks
  **37 → 36**, files reducing **29 → 30**, total emitted tokens **102,800 → 100,715**.
  `src/core/elision/regions.ts` now reduces 52.56% where it previously fell back on a syntax
  error it did not have. All three `AST Error` fallbacks are gone; drift moves 14 → 15,
  because a file that used to fail the AST gate now reaches the drift gate.
- **The relative post-condition in `elideRegions` stays.** Its second reason is unchanged:
  three of the ten bundled bench fixtures are truncated completion prompts that are invalid on
  input, and a completion prompt is a first-class input for this product. Only one of the two
  justifications for it has been removed.
- The known residue is the keyword list. A regex after a non-reserved token that is not in the
  punctuation set — `)` in `if (x) /re/.test(y)` — is still read as division. It fails closed,
  it is bounded to one line, and it is stated here rather than discovered later.

## 27. YAML Is a Document Shape, Not a Line Shape

### Decision

`looksLikeYaml` asks whether the input is *predominantly* YAML — the same shape as
`looksLikeLogs` — instead of whether any single line looks like `key: value`. Lines that are
legal YAML *and* ordinary markdown (`#` comments, bare `- ` sequence entries) are evidence of
nothing and are counted on neither side; block-scalar bodies are skipped as free text.

### Context

The probe was `/^(---\s*$)?([\w.-]+:\s+.+)$/m`. The leading group is optional and cannot span
a line, so what it actually tested was "some line looks like `word: text`". Measured
**pathless** — the Gateway and MCP shape, which is live provider traffic — it claimed `yaml`
for **12 of this repository's 22 markdown documents**:

```
ARCHITECTURE.md         "Responsibilities:"
CODE_OF_CONDUCT.md      "Consequence: A private, written warning from project maintainers"
README.md               "Note: the `AST Validators` and `Explicit Fallback` steps above run"
DECISIONS.md            "entry: `filepath:<path>`."
docs/…/milestone_6…md   "Where:\n- $C_0 = 1.0$: Initial confidence baseline"
```

§22 recorded this as acceptable on the grounds that a loose probe producing a type with no
validator is now merely *visible* (§23) rather than harmful. **That premise was wrong, and it
is the reason this is a fix rather than a tidy-up.** `DriftTracker.extractMarkers` gates
markdown structural markers on an allowlist that does not include `yaml`. Measured on the same
pathless item:

```
contentType=yaml       markers=0
contentType=markdown   markers=19
```

So the mistag silently zeroed `R_struct`'s input on the one content type where it does real
work — while §18 was concurrently recording that `R_struct` is inert *for code*. Half the
metric was being disabled on prose too, by a probe nobody was reading as load-bearing.

### Alternatives Considered

- **Run `looksLikeMarkdown` before `looksLikeYaml`.** Fixes these twelve and is one line.
  Rejected: it does not make either probe correct, it makes the wrong one lose. A `#`-heavy
  YAML file would then be markdown, which is the same class of error facing the other way.
- **Require a leading `---`.** Rejects front-matterless YAML, which is most YAML — the
  repository's own `ci.yml` has no document marker.
- **Require a majority of *all* non-blank lines.** This was tried first and measured:
  `tokendamper-benchmark/BENCHMARK_RESULTS.md` scored **0.826** and stayed a false positive at
  every threshold, because markdown bullets and headings were being counted as YAML evidence.
  Removing the ambiguous line kinds from both sides is what produced separation.

### Rationale

The discriminating question is what counts as evidence, not where the threshold sits. Once
`#` and `- ` lines are excluded from both numerator and denominator, the two populations do
not overlap at all:

| | score |
|---|---|
| `.github/workflows/ci.yml`, compose, k8s manifest, front matter, block scalar | **1.000** each |
| highest-scoring prose document (`BENCHMARK_RESULTS.md`) | **0.455** |

The threshold is **0.75**, near the middle of that empty band rather than against either edge,
so it is not tuned to a single sample on either side. The structure guard — two mappings, or a
document marker plus one — exists because a ratio over one or two lines is not a measurement;
it is what keeps a lone `Note: …` sentence from carrying a classification.

Block-scalar bodies are skipped because they are free text by definition. Without that rule a
config file that documents itself scores 0.600 — *below* an ambiguous prose fragment at 0.667 —
and no threshold can order those two correctly.

### Consequences

- Pathless classification of this repository's 27 prose documents: **12 `yaml` → 0**. All 24
  markdown documents now classify as `markdown`; the two `.txt` fixtures stay `text` and the
  log fixture stays `logs`.
- `R_struct` can see heading loss on pathless prose again. This is the Gateway's only content
  type with working structural markers, so it is also the only place the drift gate currently
  measures anything on the proxy path.
- No change on the CLI code corpus: 68 frozen files, fallbacks 36, files reducing 30, mean
  48.75% — identical before and after, because a file argument carries a path and the
  extension already outranked the probe (§22).
- Two known false negatives, both stated rather than found later: a YAML document that is
  mostly free text under block scalars *with no explicit `|`/`>` indicator*, and a fragment
  with a single mapping and no document marker. Both fall to `text`, which is in
  `MARKDOWN_MARKER_TYPES` — so they over-harvest markers rather than under-harvest them, which
  is the direction that inflates drift rather than hiding it. Worth knowing before that
  allowlist is next touched.

---

## 28. An Empty Before-Set Is "Nothing to Measure", Not "Perfectly Retained"

**Date:** 2026-08-05
**Status:** implemented

### The defect

`DriftTracker.calculateDrift` initialises both retention ratios to `1.0` and overwrites them
only when their pre-optimization set is non-empty:

```ts
let astSymbolRetentionRatio = 1.0;
if (symbolsBefore.size > 0) { /* ... */ }
```

So an item the extractors found nothing in scores as *perfectly retained*. `S_k` is then
`1 - (0.6·1 + 0.4·1) = 0.0000` regardless of what the stages did to the bytes.

Measured on `src/index.ts` — fourteen `export * from './x';` lines, no named declarations:

```
420 bytes -> 67 bytes   130 -> 18 tokens (86.15%)
[TokenDamper: 14 code lines elided, 420 bytes, sha256:10a4b0eb949b]
fallbackUsed false   driftScore 0
```

The whole file replaced by a marker, certified clean. This is invariant 10's **ninth**
instance: a green result from a check that never ran.

Note the mechanism precisely, because the standing description had it slightly wrong. It is
`R_AST` that is empty here (`symbolsBefore = 0`). `R_struct` is **not** empty — it holds
exactly one marker, `filepath:src/index.ts`, derived from `item.path`. That marker is why the
second half of the metric could not save the file either: elision never touches `item.path`,
so the marker survives by construction and `R_struct` reports `1.0` while every byte of
content is destroyed.

### The decision

An empty before-set means the component was **not measured**. A component that was not
measured contributes no evidence of retention, and an item destroyed without evidence is not
certifiable. Concretely, drift refuses when all of:

1. the item's content **changed**, and
2. an **AST validator covers** it, so symbols were the *expected* witness, and
3. it yielded **neither symbols nor content-derived markers**.

Reported through `DriftCoverage` on `ValidationReport` and the trace, alongside a distinct
`SEMANTIC_DRIFT_UNMEASURABLE` issue code. `driftScore: 0` on its own cannot distinguish
"retained everything" from "found nothing to look at", which is the entire defect; the boolean
beside it now carries the verdict. Same shape §23 gave syntax with `validated`.

### What is excluded from the evidence, and why

**`filepath:` and metadata-derived directives.** They come from `item.path` and
`item.metadata.constraintDirectives`, not from content, and survive any content transform. A
witness that cannot be destroyed is not a witness. `extractContentMarkers` is the subset used
for evidence; `extractMarkers` and `R_struct` itself are unchanged, because reweighting the
metric is §18's argument and does not belong in a safety fix.

### Why it is per item

The bundle-level ratios are set comparisons with no attribution. A bundle holding one
richly-symbolled file next to a symbol-free barrel measures `astMeasured: true` at bundle
level while the barrel is deleted unwitnessed. The transform is per item, so the evidence
check has to be too — keying them at different granularities is exactly what produced Issue 2.

### Scope refused, deliberately

**Prose.** The first implementation enforced on any unwitnessed change and was wrong. No
validator covers prose, so `R_AST = 1.0` there is not a failed measurement but an
inapplicable one; enforcing made every prose bundle incompressible and killed
`cleanup:session-dedup` on the conversational traffic the Gateway carries — 4 tests, including
both cross-turn dedup cases and the bench baseline. Plain prose remains unwitnessed by both
components and still passes at `S_k = 0.00`. That hole is now **reported** rather than
enforced, because closing it decides whether TokenDamper may compress prose at all, which is a
product question, not a bug.

**Pruned-away items.** Dropping an item is the planner doing its job under a budget the caller
set, and `R_AST` already scores it wherever the item carried symbols. Refusing here would stop
the knapsack pruning any symbol-free file. A symbol-free code file the pruner removes is still
invisible to drift; that is the planner's half of the same defect and wants its own decision.

### Measured cost

68 frozen repo sources (64 TS + 4 py), engine A/B'd by patching only this clause in `dist/`,
corpus fixed by `sha256` manifest:

| | |
|---|---|
| files changing outcome | **5**, all pure barrel files |
| collateral on anything else | **0** |
| paired aggregate over the 28 files reducing under both | **48.52% → 48.52%** |

Turn-1 Gateway measured as required: `fallbackUsed: false`, no false positives, and turn 2
falls back identically with the rule on and off. Output byte-identical across 6/6 fresh
processes, and fail-open holds — a refusal returns the caller's input verbatim.

The five barrel files are a real, if small, loss of yield. That is the intended direction:
they were only ever "reducing" by having their entire contents deleted under a score that had
measured nothing.

---

## 29. The Caller May Declare What the Content Is

**Date:** 2026-08-05
**Status:** implemented (Phase 4b.1)
**Scope:** `docs/phase-4b-pathless-code-scope.md` §5. 4b.2 (a Python content probe) and 4b.3
(the `MARKDOWN_MARKER_TYPES` allowlist) remain scoping only.

### The defect

`item.language` exists on `ContextItem`, is **first** in `selectValidator`'s precedence, and
was populated by **no adapter at all**. Every entry mode inferred everything from
`sourcePath` plus a content probe, and two of the three modes are pathless by construction:
`optimize -` has no filename, and the MCP `optimize_context` schema accepted `rawInput` plus
budget knobs and nothing else. Gateway messages are provider payloads and have neither.

With no path, `classifyContent` falls to probes, and §17 removed content-only code detection
on purpose. The result is not a degraded classification but an absent one: `selectValidator`
returns `null`, `selectElisionRegions` asks the same validator for a language and gets none,
the item falls to whole-item hashing, `S_k` pins at the formula constant `0.60`, and the
pipeline falls back. Same bytes, two entry forms:

```
optimize corpus/service.py        11,328 bytes out   fallback false   astCoverage checked 1
optimize - < corpus/service.py    16,937 bytes out   fallback true    astCoverage checked 0
```

**The one route that works is the one a coding assistant does not use.**

### The decision

The caller declares. `--language` and `--input-name` on the CLI; `language` and `path` on the
MCP tool schema. Zero inference — this is strictly a route for information the caller already
has, and on the MCP path the caller always has it.

**Precedence: declaration > extension > probe.** §22 established that a filename outranks a
content probe, because a name is a statement by whoever named the file and a probe is a guess
about bytes. A `--language` flag is a statement by whoever is running the tool *now*, about
*this* input — one step more specific than a filename, which may belong to a different person
and may not still be true of a piped fragment.

### The declaration sets two fields, atomically

`language` and `contentType` move together or not at all. Both halves are load-bearing and
each was measured:

- **Language alone** leaves `contentType` at whatever the probe guessed. `text` and
  `markdown` are both in `DriftTracker`'s `MARKDOWN_MARKER_TYPES`, so a declared Python file
  would still have its `#` comment leaders harvested as markdown headings — markers invented
  before the elision and then "destroyed" by it (§18). Two comment lines are enough for the
  probe to classify a Python file as a markdown document.
- **Content type alone** is worse: `CONTENT_TYPE_VALIDATORS.code` maps to the **TypeScript**
  validator, so a `code` tag with no language sends Python to the wrong checker. Pinned in
  `test/unit/declared-language.test.ts` rather than left as a comment.
  **Superseded 2026-08-08 (Phase C): that mapping is now `null`.** `code` is a family tag
  spanning ~19 extensions against three implemented validators, and lexing the family as
  TypeScript invented findings rather than weakening them (perl 39/40, tcl 30/40, shell 22/40
  false verdicts). A `code` tag with no language now sends Python to **no** checker — it
  reports `validated: false` and appears on `trace.astCoverage` (§23) instead of returning a
  wrong verdict. The conclusion this bullet supports is untouched: the two fields must move
  together. The pin was re-aimed, not deleted.

The two fields answer to different consumers — dispatch reads one, drift reads the other —
and keying a transform and its check at different granularities is what produced Issue 2.

### An unrecognized declaration is an error, not a no-op

`normalizeLanguage` returns `undefined` for anything outside the table, and the CLI and the
MCP handler both **reject** it. A `--language pyton` that is quietly dropped yields a run that
looks declared, validates nothing, and prints a clean trace — invariant 10's shape, and the
reason the check lives at the adapter edge rather than in the model.

The accepted set is exactly the languages the *filename* route already recognizes
(`isCodeExtension` plus the document extensions). Declaration parity is the rule: `--language
python` and a `.py` name must reach the same validator with the same content type, or there
are two behaviours to reason about instead of one. A consequence worth stating plainly:
`rust`, `go`, `java`, `sql` and the rest map to `code`, and `code` is bracket-checked by the
TypeScript validator. That is **already** what a `.rs` file gets today; the declaration makes
it reachable from stdin, it does not introduce it.

### Measured

Two corpora frozen in a scratch directory with `sha256` manifests, engine A/B'd as
`dist-before` (`5b19394`) against `dist-after`, tokens counted with real `cl100k_base` rather
than the engine's estimator, `--target-reduction-ratio 0.3`:

| corpus | bare stdin | `--language` | file argument | `--input-name` |
|---|---|---|---|---|
| 64 repo TypeScript sources | 0.07% | **19.27%** | 19.27% | 19.27% |
| 45 `pip` Python sources | 0.02% | **12.34%** | 12.34% | 12.34% |

Output is **byte-identical to the file-argument route on all 109 files**. AST coverage goes
from 0/109 items checked to 109/109. Determinism holds across 6/6 fresh processes in both
languages. **Collateral is zero**: every undeclared run, file or stdin, is byte-identical
before and after — the item hash spreads `language` in only when present, so no existing id
moves.

### The unplanned result: §28 did not reach the pathless route

Six files across the two corpora **reduce under bare stdin and fall back once declared**.
Every one is a barrel or constants file, and the mechanism is §28 arriving by the other door:
its refusal is conditional on an AST validator covering the item, and nothing covers a
pathless item. So the defect `5b19394` is recorded as closing was still live over stdin —
`index.ts` went 135 → 18 tokens, `astCoverage.checked: 0`, `unwitnessedItems: []`,
`fallbackUsed: false`. Declared, the same bytes produce `symbolBearingItems: 1` and
`SEMANTIC_DRIFT_UNMEASURABLE`.

Read the yield table with that in mind: the declared route is not uniformly additive. It
gains 25 and 19 files respectively and gives back 6, and the 6 are ones that were only ever
"reducing" by being deleted under a score that had measured nothing.

### The third construction site: the benchmark loader

There are exactly three `createOptimizationRequest` call sites — CLI, MCP, and
`src/bench/fixtures/loader.ts`. The third was still guessing **with the answer in hand**:
`BenchmarkFixture.language` is a *required* field, and `fixtureToOptimizationRequest` dropped
it and let `classifyContent` re-derive a content type from the filename.

For a fixture whose path agrees with its language that is merely redundant. For a CodeXGLUE
item with **no path** it is 4b.1's defect inside the harness that publishes this project's
numbers — `codexglue.ts` synthesizes `src/item_<id>.txt` for those, which classifies `text`:

```
language "python"   path src/item_pathless-1.txt   contentType text
astCoverage {checked: 0, unchecked: 1}   fallback true   133 -> 133 tokens
```

Declared, the same fixture is checked, is not refused, and goes 133 → 59 tokens. All ten
bundled fixtures are byte-identical before and after (verified fixture-by-fixture, output
hashes included) because their paths agree with their languages; the agreement itself is now a
test rather than a recorded observation.

### A false declaration fails closed, and that is how the fixture lie was found

Making the loader believe `fixture.language` broke `test/integration/bench.test.ts` Test 2,
whose two fixtures were **English prose carrying `language: 'python'`** and `.txt` paths. The
test had passed only because the loader ignored the field.

The mechanism is §28 doing its job: prose is exempt from the unwitnessed-elision refusal only
because *no validator covers it*. A false declaration drags it under one, the extractor finds
no Python symbols in English, and drift refuses to certify what it cannot witness —
`SEMANTIC_DRIFT_UNMEASURABLE`, fallback, input returned verbatim.

**So a wrong declaration costs the optimization and never the content.** That is the right
failure direction for a flag a user will eventually point at a README, and it is pinned as a
test in its own right rather than left as an incident. The fixtures are now Python, which is
what they always claimed to be; the assertion is unchanged and still clears its 40% threshold
(58.8%, zero fallbacks), now by eliding real function bodies instead of deleting unlabelled
prose whole.

### Not done here

**No Gateway hint.** 4b.1 proposed one and it is deliberately unbuilt. A provider payload has
no per-message language field, so the only available shape is a whole-request declaration —
and a session is heterogeneous by nature: prose questions, JSON tool results, code fragments.
Declaring `python` for a request would tag English prose as Python code and hand it to
`PythonValidator`, whose indentation rule prose does not satisfy. That converts a declaration
route into a fallback generator on exactly the traffic invariant 8 protects. If a Gateway
declaration is ever wanted it must be per message, which means a header format that names
message indices, and that is a design, not a flag.

---

## 30. A Flag the Command Does Not Read Is an Error, Not a No-Op

**Date:** 2026-08-06
**Status:** implemented
**Generalizes:** §29, which made this argument for `--language` alone.

### The defect

`parseArguments` ran one flag loop for every subcommand, and each subcommand's return object
picked out the fields it cared about. Everything else was **dropped in silence**. Three
instances shipped, all exiting 0:

```
tokendamper bench --diff --language python     parsed, discarded
tokendamper optimize x --report-json r.json    parsed, discarded
tokendamper mcp --config custom.json           never parsed at all
```

The third is the worst and was not a mere omission. `runCli`'s MCP branch **reads**
`parsed.configPath` and `parsed.configOverrides` and hands them to `loadConfig` — but the
parser returned for `mcp` *before* the loop that sets them, so both were permanently
`undefined`. And `loadConfig` ignores a config file that does not exist rather than failing, so
`tokendamper mcp --config custom.json` started a server on defaults with no signal anywhere:
not in the exit code, not on stderr, not in the config it reported.

§29 rejected exactly this shape for `--language` — "a declaration that quietly does nothing
produces a run that looks configured and is not" — and then left the same shape in place for
eight other flags, because the argument had been framed around declarations rather than around
silence. The property is about silence.

### The decision

A single table, `SUPPORTED_FLAGS`, keyed by what `runCli` actually consumes rather than by what
the loop happens to recognize. Anything outside a command's set is a parse error naming the
offending flags **and where each one does apply**:

```
Unsupported for `tokendamper bench`: --diff (applies to: optimize).
```

Named rather than merely refused, because every one of these flags is real; the user has the
right command for the wrong verb. All offenders are reported at once — fixing an invocation one
error at a time is its own small punishment.

The check runs **after** the parse loop, not inside it: `--mode bench` can change the command
from within the loop, so the verdict cannot be reached until parsing is finished.

`exec` is deliberately outside the table. Its arguments belong to the child process, so
forwarding them unexamined is the contract, not a leak.

### Consequences accepted

`bench --diff` and `optimize --quiet` used to exit 0. They now exit 1. That is a breaking change
for any script relying on a flag that never did anything, which is the population this is meant
to inform. Nothing that was doing work stops doing it: every flag each command actually reads
is still accepted, and `test/unit/cli/flag-support.test.ts` walks the whole table to prove the
table and the loop agree — a flag listed as supported but unrecognized by the loop fails there.

### Why the parser is exported for the test

`parseArguments` and `SUPPORTED_FLAGS` are exported for that suite. Asserting this through
`runCli` would mean starting an MCP server to discover whether `--config` was read, and the
`mcp` defect is invisible from the outside precisely because `loadConfig` swallows a missing
file. A parser is testable directly.

---

## 31. A Probe May Only Claim Content Its Validator Already Accepts

**Date:** 2026-08-06
**Status:** implemented (Phase 4b.2)
**Scope:** `docs/phase-4b-pathless-code-scope.md` §4–§6. 4b.3 (the `MARKDOWN_MARKER_TYPES`
allowlist) remains scoping only.

### Why a probe at all, after §17 removed one

§29 gave the caller a way to say what pathless content is, and on the MCP path the caller
always knows. The Gateway is the case that cannot be closed that way: a provider payload has
**no language field anywhere in its schema**, per message or per request, which is why §29
declined a Gateway declaration outright. For the traffic the proxy actually carries, a probe is
the only route that exists.

§17 removed the previous content-only code detection because its single signal was a markdown
fence and the verdict flipped on apostrophe parity in the surrounding prose. That is an
argument against *that* probe, not against probes. The replacement is a majority-of-lines rule
— the shape §22 and §27 already use for logs and YAML — scoped to the one language where the
measurement supports it.

### Python only, and that is not a staging decision

§4 measured both. Python separates with a factor-of-seven margin. TypeScript does not separate
at all: positives span 0.283–1.000 and prose negatives reach 0.333, because this repository's
prose is documentation *about* TypeScript, dense with fenced TypeScript. No threshold orders
them. **A TypeScript probe is not proposed, now or later, without a different kind of signal**
— `--language` is what TypeScript over stdin gets.

### The rule, and the half that is not in the scope document

Structural: `strong >= 2 && (strong + weak) / counted >= 0.15 && disqualified / counted < 0.10`,
with comment lines excluded from numerator *and* denominator — `#` is a Python comment and a
markdown heading and cannot be evidence either way.

Then, and this is the addition:

> **A probe may only claim content the validator for that language already accepts.**

§6's risk 2 asked whether a fragment that fails the indentation rule should fall back or be
reported as uncheckable. Neither. It should not be detected. A declaration is the caller's
assertion, and failing on it is right — they said Python, it does not parse, they should hear
about it (§29's false-declaration case). A detection is *our* guess, and content that does not
parse is far likelier to mean the guess was wrong than that the user's data is broken. Failing
closed on our own guess turns a heuristic into a fallback generator on live traffic, which is
exactly the trade §17 refused.

So a detected item is one `PythonValidator` has already accepted, and detection can never make
an item *less* valid than leaving it as `text` would have. `PythonValidator` imports types
only, so consulting it from the model layer adds no cycle, and it runs only for candidates the
cheap regex pass already accepted.

The confirmation is load-bearing, not decorative: three malformed inputs that clear the
structural rule — a bad indent level, an unterminated string, a call truncated mid-argument —
are each rejected by it and land exactly where they landed before the probe existed.

### Both fields, atomically

`classifyContent` now wraps `classifyContentShape`, which returns `{ contentType, language? }`.
A detection sets both for the reasons §29 gives for declarations, one of them sharper here:
`contentType: 'code'` alone routes to the **TypeScript** validator, and `language` alone leaves
the tag at `text`/`markdown`, both on `MARKDOWN_MARKER_TYPES`, so the file's `#` comments would
be harvested as markdown headings and then destroyed by the very elision the detection just
enabled. §3 measured that half-fix pushing drift up on 14 of 20 files and over the gate on one.

An **extension** still never sets `language`. It does not need to — `selectValidator` consults
`path` itself — and doing so would put a `language` on every file-route item, moving every item
hash in the project for nothing.

### Position in the probe order

Behind json/yaml/html/logs, ahead of markdown. Ahead of markdown because that is what it has to
beat: measured pathless, 13 of 45 `pip` files classify `markdown` and the rest `text`. Behind
the other four because each is a decisive-shape detector that no Python file in either frozen
corpus triggers, so moving ahead of them adds blast radius and buys nothing. `looksLikeJson`
must stay first regardless — §4 measured a JSON tool result scoring 0.67 on a
brace-and-semicolon code signal, saved only by the JSON check standing in front.

### Measured

Corpora frozen under `sha256` manifests, engine A/B'd `dist-4b1` (`bdea1f0`) against
`dist-4b2`, `cl100k_base` tokens, `--target-reduction-ratio 0.3`:

| | detected | false positives |
|---|---|---|
| 45 `pip` Python (positive) | **39 (86.7%)** | — |
| 64 repo TypeScript | — | **0** |
| 25 repo markdown | — | **0** |
| repo YAML, `sample_logs.txt` | — | **0** |

| route | before | after |
|---|---|---|
| `pip` corpus over **stdin, undeclared** | 0.02%, 1 file reduces, 0/45 items checked | **12.27%, 19 files, 39/45 checked** |
| the same bytes as a **file argument** | 12.34% | 12.34% (**0 collateral**) |
| 64 TS sources over stdin | 0.07% | 0.07% (**0 files changed** — no TS probe) |

The probe recovers **99.4%** of the yield the filename route achieves. All six misses **parse
fine** — the structural rule declined them, not the validator — so the confirmation step costs
zero detections on this corpus while still rejecting every malformed fragment above.

**Gateway, measured as §6 requires.** Turn 1 of a real session, where `cleanup:session-dedup`
has no previous hashes and cannot elide, so any fallback is a false positive by construction:
no fallback, output byte-identical to input. Turn 2: byte-identical before and after, same
fallback, same token counts. The Python tool-result message is now `code`/`python`; prose and
log messages are untouched. **Zero new fallbacks on live traffic.** Output byte-identical
across 6/6 fresh processes.

### What is still open, stated because the yield table hides it

An **undetected** pathless Python file is not merely unoptimized — it is unprotected, and
§29's addendum predicted this. `pip`'s `status_codes.py` is a symbol-free constants file the
probe declines: over stdin it stays `text`, no validator covers it, §28's refusal cannot fire,
and it is elided whole and unwitnessed — 44 → 27 tokens — while the *file* route correctly
refuses it. Detection narrows that population; it does not close it. Closing it means either
detecting everything, which no probe does, or deciding what drift owes an item nothing covers,
which is §28's deferred prose question.

---

## 32. The "We Could Not Tell" Buckets Do Not Get to Assert Structure

**Date:** 2026-08-06
**Status:** implemented (Phase 4b.3). **Read the second half — the defect this uncovered is
larger than the change, and is deliberately not fixed here.**

### The change

`MARKDOWN_MARKER_TYPES` held `markdown`, `text`, `html`, `logs` and `unknown` while its own
docblock said a new `ContentType` "should default to *not* harvesting these — an absent marker
costs a little discrimination, an invented one actively inflates drift". The list and the rule
disagreed, and the disagreement was in the worst possible place: `text` and `unknown` are the
two **we could not tell** buckets. A bucket meaning *we do not know what this is* cannot also
mean *its `#` lines are headings*. `#`, ``` and `---` are not HTML or log syntax either.

The list is now `markdown` alone.

### Measured: inert, and that is the honest headline

| corpus | files | gated markers from the removed types |
|---|---|---|
| 64 repo TypeScript (60 land in `text`, 1 `html`) | 64 | **0** |
| 45 `pip` Python (2 land in `text`) | 45 | **0** |
| `sample_logs.txt` (`logs`) | 1 | **0** |
| `unknown` | — | only ever returned for empty content |

132 files over stdin, 40 over the file-argument route, and both Gateway turns are
**byte-identical** before and after. This is a consistency fix with no measured behavioural
change. It is worth having because the trap is latent — anything that starts classifying code
as `text` gets the fabrication back for free — not because it moves a number today.

### The defect it uncovered, which is not in those buckets at all

`docs/phase-4b-pathless-code-scope.md` §5 scoped 4b.3 as removing the fabrication for
"undetected Python, and pathless code in any other language". Measured, **the fabrication is
not in `text` or `unknown`. It is in `markdown`,** and no allowlist edit can remove it without
gutting real prose:

```
9 frozen shell scripts   -> classified markdown, 591 headings harvested, all `#` comments
4 undetected pip files   -> classified markdown,  45 headings harvested, all `#` comments
62 `text`-classified     ->                        0
```

`looksLikeMarkdown` fires on a single `#` heading (`/(^|\n)#{1,6}\s+\S/`), so a shell script's
first `# Copyright …` line makes the whole file markdown.

**And the harm is not the inflated drift.** Measured end to end on a frozen `tclConfig.sh`:

```
1,877 -> 19 tokens (99.0% deleted)   fallbackUsed false   driftScore 0.4
astCoverage    {checked: 0, unchecked: 1, uncheckedContentTypes: ["markdown"]}
driftCoverage  {structMeasured: true, measured: true, contentMarkersBefore: 79,
                symbolsBefore: 0, unwitnessedItems: []}
```

The file is deleted whole, nothing validated it, and drift reports **`measured: true`** on the
strength of 79 markers that are every one of them a comment line. `S_k` lands on exactly
`0.400` — `1 - (0.6·1 + 0.4·0)`, every fabricated marker destroyed — and passes only because
the gate is `> 0.40` rather than `>=`, which §3 of the scope document predicted in the
abstract and is here in the concrete.

So the fabricated markers do not merely inflate a score. **They forge the evidence that the
score measured anything**, defeating the `DriftCoverage` reporting §28 added precisely so this
class would be visible. That is invariant 10 again, and it is the first instance where the
report itself is the thing that lies.

### Why it is not fixed here

Three seams, none of them 4b.3's:

1. **The allowlist** cannot separate them: `# Copyright …` and `# A heading` are the same
   bytes, and `markdown` must keep harvesting for the 25 real documents that yield 477
   headings, 47 fences and 23 sections.
2. **`looksLikeMarkdown`** could require more than one `#` line, but that is a classifier
   change with blast radius over every prose item in every bundle — the gotcha CLAUDE.md
   states outright, and how §17 was found.
   **Measured 2026-08-06 and this reasoning is wrong — see `docs/phase-0-measurement-baseline.md`
   §6.** "More than one `#` line" is a *count* threshold, which the lever disposition had
   already shown points the wrong way. A **shape** discriminator — require a non-`#` markdown
   marker, or any two distinct signals — takes code misclassified as markdown from **114 of 264
   files to 12 (or 7), while retaining all 25 prose files**. The blast radius over prose is zero
   on that corpus. Seam 2 is the best-separating lever measured, and it is a *mitigation*, not
   the fix: it converts §32-shaped items into §28-shaped ones, which still reduce unwitnessed.
3. **Drift** could refuse to certify an item nothing covers, which is exactly the prose
   question §28 deferred as a product decision.

**All three were measured on 2026-08-06 and the deferral survives with better evidence:
`docs/phase-4b-lever-disposition.md`.** Seam 1 (a coverage gate prohibiting whole-item elision
where `astCoverage.checked == 0`) is dead twice over — `tclConfig.sh` and `CODE_OF_CONDUCT.md`
are identical on every trace field the gate could key on, and *every* Gateway dedup elision is
`checked == 0`, so the gate makes the proxy a pass-through. A fourth lever, non-content
discriminators, is also dead: a shebang catches one of the four destroyed files, and the
extension and executable bit do not exist on any pathless route. **Seam 2 was not re-measured
then; it was measured on 2026-08-06 and it separates — 114 → 12 with no prose casualty
(`docs/phase-0-measurement-baseline.md` §6).** Seam 3 survives and is still the deferral
itself, because seam 2 relocates the defect rather than closing it.

**One further correction, from the same measurement: this section's framing of the defect as
pathless is wrong.** `.pl` and `.tcl` are not in `isCodeExtension`, so Perl and Tcl classify
`markdown` **on the file-argument route too**. The worst case found is not a shell script over
stdin — it is `Unicode_Collate_Locale_ja.pl` at **57,037 → 19 tokens (100%)**, passed by name,
`fallbackUsed: false`, `astCoverage.checked: 0`. The variable is not the route; it is
membership of a hardcoded 19-entry extension list.

One correction to the sentence above, from that measurement: "the only identified fix" should
read "the only fix that does not either destroy the Gateway or reduce to §28's open question".
Three fixes are identified; the conclusion is unchanged.

Seam 3 is where this actually belongs, and the finding **reframes that deferred question**.
§28 deferred it as "may TokenDamper compress prose at all". The population is not prose. It is
**everything no validator covers**, which includes real source code in every language the
AST-lite suite does not implement — shell, Ruby, Go, Rust, SQL. Deleting 99% of a shell script
under a forged `measured: true` is not a product question about prose.

Pinned **by inversion** in `test/unit/markdown-marker-allowlist.test.ts` under
`KNOWN DEFECT (pinned by inversion)`. The first version of that block asserted the wrong
behaviour and passed, which made the defect the suite's de facto specification — the only thing
marking it as wrong was a docblock, and a docblock enforces nothing. It now states the
**contract** and carries `it.fails`: green while the contract is violated, red with
`Expect test to fail` the moment any remedy makes it hold. Three guards keep the inversion from
going vacuous — the pipeline result is computed at describe scope so a crash is a collection
error rather than a swallowed pass, the preconditions live in a separate ordinary test, and the
`it.fails` body holds exactly one assertion. The contract is remedy-agnostic and stated over the
input rather than over trace fields, because `tclConfig.sh` and `CODE_OF_CONDUCT.md` are
identical on every field the trace carries.

---

## 33. The Measurement Gate and the Retention Gate Are Two Gates

**Date:** 2026-08-06
**Status:** implemented (Phase A, part 1 of 2). Part 2 is the classifier seam — see §34.

### The defect

`S_k = 1 − (0.6·R_AST + 0.4·R_struct)` answers two questions with one scalar: *did anything
witness this item?* and *did enough of it survive?* Both ratios default to `1.0` on an empty
before-set, so "nothing to compare" and "perfectly retained" produce the same number, and
`0.400` is reachable from two structurally opposite configurations —
`R_AST = 1` (empty-set default) with `R_struct = 0`, and `R_AST = 1/3` with `R_struct = 1`.
One comparison arbitrates both, so `>` versus `>=` silently decides a question nobody asked.

§28 added the missing distinction but **scoped it to validator-covered items**, on the
grounds that enforcing on prose "would make every prose bundle incompressible, ending
`cleanup:session-dedup` on exactly the conversational traffic the Gateway carries".

### The measurement that overturned the scope

Phase 0 froze a 289-file corpus covering languages the AST-lite suite does not implement
(`docs/phase-0-measurement-baseline.md`). Measured, the scope was protecting the wrong
population:

- **Real documents were never in reach.** All 25 markdown files carry content markers and
  are witnessed. Widening the rule moves **none** of them.
- **The Gateway keeps within-payload deduplication.** `resolveRecoverableElisions` substitutes
  the original content for `recoverable` elisions *before* the rule runs, so a recoverable
  elision reads as unchanged and is skipped structurally. Measured end to end on the proxy:
  within-payload dedup saves 44 of 129 tokens with and without the gate. This is the decisive
  difference from lever 1 in `docs/phase-4b-lever-disposition.md`, which keyed on
  `astCoverage.checked == 0` — a condition *every* dedup elision satisfies — and therefore
  made the proxy a pass-through.
- **What the scope actually excluded was uncovered code.** `Unicode_Collate_Locale_ja.pl`
  went **57,037 → 19 tokens (100%)** on the *file-argument* route at `S_k = 0`,
  `measured: false`, `fallbackUsed: false`, because nothing covers `.pl` and the rule
  therefore never looked.

### The decision

Two changes, both in `src/core/ledger/drift-tracker.ts`:

1. **The unwitnessed-item rule no longer keys on validator coverage.** Any item that changed,
   was not pruned away, and yields neither symbols nor content-derived markers is refused.
   The witness may be of **either** kind — requiring symbols specifically would refuse every
   document; requiring neither is what permitted the Perl deletion.
2. **`DriftReport` carries `measurementGate` and `retentionGate` as separate verdicts.**
   `shouldFallback` remains their disjunction. `validate()` now reads `measurementGate`
   instead of re-deriving the distinction from `unwitnessedItemIds.length`, so the two
   existing issue codes (`SEMANTIC_DRIFT_UNMEASURABLE`, `SEMANTIC_DRIFT_EXCEEDED`) are driven
   by the gate that actually fired rather than by a second inference of it.

`calculateDrift`'s `symbolBearingItemIds` option is **removed**, not left inert — §30's rule.
`validate()` still computes the set for `DriftCoverage.symbolBearingItems`, which is reporting.

### Measured cost

62 of 578 corpus runs change, and nothing else moves byte-for-byte:

| bucket | route | before | after |
|---|---|---|---|
| perl | file + stdin | 34 reduce, **81.91%** | 7 reduce, **5.61%** |
| css | stdin | 6 reduce, 11.13% | 0 reduce, 0.00% |
| c | stdin | 2 reduce, 0.80% | 0 reduce, 0.00% |
| python / typescript / rust / prose / shell / tcl | both | — | **byte-identical** |

On the Gateway, cross-turn deduplication of a **sole copy** now falls back. That population is
the one `docs/phase-1-stabilization-summary.md` §9 already described as sending the model a
marker it has no way to resolve; refusing it is consistent with that entry, not a new position.

### What this does not fix, and why it needs §34

**Shell and Tcl are untouched by this change** — 20 shell files still reduce 17.28% over
stdin. They classify `markdown` because `looksLikeMarkdown` fires on a single `#` comment, so
`extractContentMarkers` harvests their comment leaders as headings and they report
`structMeasured: true`. The fabricated markers **forge exactly the evidence this gate checks**.

That is why Phase A is two changes and not one. The measurement gate closes the honest half
(`text`-classified, `measured: false`); the classifier seam closes the forged half. Measured
together they take every uncovered-language bucket to 0.00% while every AST-covered bucket and
all 25 prose files keep their full yield.

### Tests

`test/unit/drift-unwitnessed-elision.test.ts` gains an uncovered-language refusal (the Perl
case in miniature) and two gate-separation tests. Two existing tests were **inverted**, both
because they encoded the old scope: the prose exemption, and the coverage escape hatch.

Three tests elsewhere were passing on the empty-set default and are corrected rather than
deleted — `engine.test.ts`'s emit-path fixture elided a witness-free `text` item and asserted
`fallbackUsed: false`, which only held because drift measured nothing; and two Gateway dedup
tests used a sole cross-turn copy. `declared-language.test.ts`'s pathless-barrel test
asserted that the hole was still open on the undeclared route, and now asserts it is closed.

---

## 34. Markdown Needs a Marker That Is Not a `#` Line

**Date:** 2026-08-06
**Status:** implemented (Phase A, part 2 of 2). Closes §32.

### The defect

`looksLikeMarkdown` accepted a single `#` heading as sufficient evidence of a document. `#` is
the comment leader in shell, Perl, Tcl, Ruby, R, YAML and Python, so one `# Copyright …` line
made a whole shell script `markdown`.

That is not a cosmetic misfiling. `DriftTracker`'s `MARKDOWN_MARKER_TYPES` harvests markdown
headings for `markdown`-tagged items, so the comment leaders became **structural markers**,
`structMeasured` went `true`, and drift certified an item nothing had examined. Measured:
591 fabricated headings across 9 frozen shell scripts, and `tclConfig.sh` at 1,877 → 19 tokens
with `fallbackUsed: false` and `driftCoverage.measured: true`.

### Why §32 deferred it, and why that reasoning was wrong

§32 named this seam and rejected it: *"could require more than one `#` line, but that is a
classifier change with blast radius over every prose item in every bundle."*

"More than one `#` line" is a **count** threshold, and `docs/phase-4b-lever-disposition.md` §1
had already shown counts point the wrong way — `tclConfig.sh` carries **79** markers to
`CODE_OF_CONDUCT.md`'s **12**, so any count rule protects the shell script *less*. The seam
was dismissed on the strength of the one formulation of it that cannot work.

The discriminator that does work is **shape**: a real document also has fences, lists or links;
a commented config fragment has none. Measured over the 289-file Phase 0 corpus
(`docs/phase-0-measurement-baseline.md` §6):

| candidate | code → markdown (of 264) | prose → markdown (of 25) |
|---|---|---|
| what shipped before | **114** | 25 |
| require a non-`#` marker | 11 | **24** — loses `CODE_OF_CONDUCT.md` |
| **the same, with the list regex repaired** | **12** | **25** |
| any two distinct signals | 7 | 25 |

**Blast radius over prose: zero files.**

### The decision

Drop the bare-heading alternative from `looksLikeMarkdown`, and repair the list regex in the
same change because the second is what makes the first safe.

The old list rule was `/(^|\n)(- |\* |\d+\.)\s+\S/`. The alternation already consumed the space
after the bullet and `\s+` then demanded another, so `- item` and `* item` — the two commonest
list forms — did not match, while `-  item` and `1. item` did. 21 of 25 corpus documents
tripped the old rule against 25 of 25 under the repair. That single missing match is the whole
difference between the two middle rows above.

The stricter "any two distinct signals" variant separates better (7 versus 12) and is **not**
taken: it costs a second concept for five files, and every one of the 12 residual leaks is
honest — two shell scripts with `- ` lists, three Tcl files whose `[...]` command syntax
matches the link regex, four pip files, and three of this repository's own sources whose doc
comments genuinely contain fenced markdown.

### Why this had to be part of the same phase as §33

Neither half closes the defect alone, and the corpus says so:

| arm | shell over stdin | perl, both routes |
|---|---|---|
| baseline | 20 reduce, 17.28% | 34 reduce, 81.91% |
| §33 measurement gate only | **20 reduce, 17.28%** — unmoved | 7 reduce, 5.61% |
| §34 + §33 | **0 reduce, 0.00%** | **0 reduce, 0.00%** |

The measurement gate refuses an item that left no witness — but the fabricated headings *were*
the witness it checks. Seam 2 removes the forgery, which is what brings shell and Tcl into the
gate's reach. Stated the other way: §34 without §33 would have relocated those files from the
forged failure to the honest one, where they would still have been elided unwitnessed.

### Measured, end state

114 of 578 runs change against the Phase 0 baseline, and the change is confined:

- **Every uncovered-language bucket goes to 0.00%** — shell, perl, tcl, c, css over stdin.
- **258 of 258** rows in the AST-covered buckets (python, typescript, rust) and the prose
  bucket are **byte-identical** to baseline.
- The combined result was predicted by an A/B patch before implementation and matched it on
  all 578 rows with **zero** mismatches.

### Consequence for §32

§32 is closed. `test/unit/markdown-marker-allowlist.test.ts` is no longer a defect pinned by
inversion; the `it.fails` contract went red with "Expected test to fail" the moment the remedy
landed, exactly as designed, and its preconditions test went red alongside it because the fix
arrived from a direction the contract could not see. Both are now stated positively, and the
file asserts the closure rather than the defect.

### What remains open

`isCodeExtension` is still a hardcoded 19-entry list, and membership of it still decides
whether a real source file is validated at all. Phase 0 §4 measured that `.pl` and `.tcl` fall
outside it on the *file* route. Nothing here changes that; what changes is that falling outside
it now yields a refusal instead of a silent deletion.

---

## 35. Fail-Open Means the Caller's Bytes, Not a Re-encoding of Them

**Date:** 2026-08-06
**Status:** implemented (Phase B). Re-scopes 1b; the Issue 5 premise stays retracted.

### The defect, and how it was found

`resolveFallback` returns `request.rawInput` on the fallback branch, which reads like a
byte-identical echo. It is not one. `rawInput` is a string the CLI produced with
`readFileSync(path, 'utf8')`, and that call replaces every invalid byte with U+FFFD, which
re-encodes to three bytes. The guarantee held only for input that happened to be valid UTF-8,
and nothing in the code or the docs said so.

Found by the Phase 0 harness, not by reading: of 504 fallback runs, **502 were byte-identical
and two were not.** `vimspell.sh` — a Latin-1 file containing "Fernández-Sanguino_Peña" — came
back **1,462 → 1,466 bytes with `fallbackUsed: true`**. Two characters, four bytes, and a
silent violation of invariant 3 on the path whose entire purpose is to be safe.

This is the Issue 5 *class* — output larger than input on fallback — arriving by a mechanism
nobody had proposed. It is not the retracted −1.39%, which remains a harness artifact.

### The decision

1. **The CLI reads bytes and decodes second.** `readFileSync(path)` then `.toString('utf8')`,
   keeping the `Buffer`. On fallback it writes the buffer, not the string.
2. **Input that does not survive a UTF-8 round-trip forces a fallback**, via a new
   `EngineOptimizationOptions.inputNotRepresentable` reason. Every stage, validator and token
   estimate operates on the decoded string, so for such bytes they are all reasoning about
   content the caller never sent; a reduction measured against corrupted input is worse than
   none.
3. The test is a **round-trip**, not a BOM or charset sniff. The only question that matters is
   whether these exact bytes survive the string model the pipeline is built on. Valid UTF-8
   with multi-byte characters is unaffected, which is pinned by test — otherwise the guard
   would refuse most of the world's source comments.

### Why the refusal goes through the engine

The first implementation short-circuited in the adapter: correct bytes, and **no trace at
all**. The corpus harness immediately recorded two rows it could not parse, which from outside
is indistinguishable from the process having died. That is invariant 10's shape — a run that
reports nothing is not a safe run, it is an unobservable one — so the refusal is routed through
`optimize()` and produces an ordinary trace with `fallbackUsed: true` and a stated reason.

### Measured

| | before | after |
|---|---|---|
| fallback runs byte-identical | 502 / 504 | **504 / 504** |
| corpus rows changed | — | 2 (both `vimspell.sh`) |
| rows with unparsable traces | — | **0** |

### The other half of 1b: the multi-item join is latent, and that is now checked

`resolveFallback`'s **success** branch renders with `items.map(i => i.content).join('\n')`,
which is correct for one item and destroys boundaries, roles and enclosing structure for more.
CLAUDE.md has described this as the live half of 1b. Measured, it has **no live consumer**:

- Every route that reads `emittedOutput` — CLI, MCP, bench — builds its bundle through
  `createOptimizationRequest` → `createContextBundle`, which produces exactly **one** item.
- The only multi-item producer is the Gateway, which maps `finalBundle` positionally and never
  touches `emittedOutput` (invariant 9).

So it is a latent defect held latent by a convention in two other files. Rather than add model
surface for a hypothetical consumer, it is **pinned**: `test/unit/fallback-render.test.ts`
asserts the flattening explicitly, including that the render is not injective — two different
bundles produce byte-identical output — so making any `emittedOutput` consumer multi-item
changes a test rather than a payload.

### Not done here

The pipeline remains string-based, and that is the frozen architecture. A file that is not
valid UTF-8 is therefore never optimized, only echoed. Making the model byte-oriented would
touch every stage, validator and estimator, and is not justified by one file in 289 — but the
refusal is now explicit and traced instead of silent and lossy.

---

## 36. The License Is MPL-2.0, and `package.json` Was the Stale Copy

**Date:** 2026-08-09 · **Status:** Accepted · **Closes:** max_audit.md M3

The repository declared two different licenses. `LICENSE` is a full Mozilla Public License
2.0 and `README.md` stated the project "is now licensed under" it — the word *now* recording a
deliberate migration. `package.json` still carried `"license": "MIT"`, and `CLAUDE.md` repeated
the MIT claim in its opening description.

This is not cosmetic. `package.json` is `"private": false` with a `files` array and a
`prepublishOnly` script, so it is meant to be published, and npm surfaces the `license` field
as the authoritative machine-readable signal. Consumers and license scanners would read **MIT**
— permissive, no reciprocity — and actually receive **MPL-2.0**, which carries file-level source
disclosure obligations on modification. The direction of that error is the harmful one: it
understates the obligations a downstream user takes on.

### Decision

MPL-2.0 is the license. `package.json` and `CLAUDE.md` are corrected to match `LICENSE`, which
is the document that actually grants rights and is the only one of the four with legal text in it.

### Also corrected

`README.md` carried "Copyright (c) 2026 Ojas Sugur. **All rights reserved.**" immediately above
an open-source grant. "All rights reserved" asserts the opposite of what the license does, and
placing it directly above the grant makes the section self-contradicting. The copyright line is
retained without it, and the trademark reservation that follows is explicitly scoped to the
*name* rather than the code — which is what it was always meant to say.

### Why this was never recorded

The MIT → MPL migration itself has no entry in this file. It was made in the README and the
LICENSE and nowhere else, so nothing prompted a sweep of the other places the license is
asserted. The lesson is narrow and worth keeping: a license is asserted in four files, and
changing it in one is a change to none of the others.

---

## 37. A Witness That Existed Before Does Not Count If None of It Survived

**Date:** 2026-08-09 · **Status:** Accepted · **Closes:** max_audit.md C1 (measurement half)

§33 widened the measurement gate from validator-covered items to every item, and was right to.
What it did not change was the **tense** of the question. `findUnwitnessedItems` asked *did
evidence exist before?* — it built its probe bundle from the *before* item — so an item whose
witnesses were all destroyed was exempt, on the grounds that they had once been there.

A structured document therefore walked between the two gates that were split apart to catch
exactly this. Measured on this repository's own files, on both the file and stdin routes:

| file | before | after | `fallbackUsed` | `S_k` |
|---|---|---|---|---|
| `CODE_OF_CONDUCT.md` | 3,542 B | **72 B** | `false` | 0.369 / **0.400** |
| `SECURITY.md` | 1,154 B | **72 B** | `false` | 0.333 / **0.400** |

`validation.passed: true`, both gates `pass`, the content gone and — on the CLI, which supplies
no `TokenHasher` — unrecoverable.

### Why neither gate fired

The arithmetic is closed-form, which is what makes this a design defect rather than a tuning
miss. Prose yields no symbols, so `R_AST = 1.0` as an empty-set default and contributes a free
0.60. `collectMarkers` adds a `filepath:` marker derived from `item.path`, which no content
transform can destroy, so `R_struct = 1/(N+1)` for N headings. Therefore:

```
S_k = 0.6·0 + 0.4·(N/(N+1))  =  0.4·N/(N+1)
```

which approaches 0.40 from below and never reaches it, for any N — against a retention gate
that fires on `driftScore > 0.40`. **The retention gate cannot fire for markdown at all.** The
two stdin rows above landed on *exactly* 0.400 and were admitted by the strict `>`; that is the
supremum of the expression being waved through by the comparison, not a near miss.

And the measurement gate exempted them because their headings had existed.

### Decision

An item that changed is refused when it yields **no symbols** and **no content-derived markers
survive in the after item**. Two properties make this safe:

- **It is scoped to symbol-free items.** An item carrying symbols is left to the retention gate,
  because `R_AST` is measuring it for real. Whole-item elision of code still refuses as
  `SEMANTIC_DRIFT_EXCEEDED`, which is the accurate reason — reporting "unmeasurable" for an
  item whose loss was measured exactly would restore the conflation the split undid.
- **It only ever adds refusals.** Refusing on the surviving set is strictly stronger than
  refusing on the before set, so every §33 refusal still refuses. Nothing that was caught is
  now let through.

### Measured cost

A frozen 293-file corpus, 586 rows across both routes: **4 rows changed, and all four are this
defect.** Every other row is byte-identical to baseline. TypeScript stays at 14.00%, Python at
14.98%, and every uncovered-language bucket stays at 0.00%. The prose bucket goes 0.67% → 0.00%,
which was the data loss.

### Not done here

`filepath:` is still counted in `R_struct` (audit C1b, §3.2). That is the deeper half: it is why
`R_struct` is pinned at 1.0 for code and contributes a free 0.40, which in turn is why a code
file can lose **66.7%** of its symbols and pass. Fixing it moves every published reduction figure
in the project and wants its own measurement pass, so it is deliberately deferred rather than
folded in here. C1a closes the data loss; C1b closes the arithmetic.

`extractContentMarkers` remains the right primitive for both — its own doc comment has said since
§28 that metadata-derived markers "cannot serve as *evidence* that content was retained, because
they are preserved whether it was or not". The principle was already written down. This applies
it where the decision is made.

---

## 38. The Gateway Reads Bytes, Not String Fragments

**Date:** 2026-08-09 · **Status:** Accepted · **Closes:** max_audit.md C2, L3

`GatewayServer.onRequest` accumulated its request body with `body += chunk`. That invokes
`Buffer.prototype.toString('utf8')` on **each chunk independently**, so a multi-byte UTF-8
sequence straddling a chunk boundary is decoded as two truncated fragments and becomes U+FFFD on
both sides. Node reads in ~64 KB chunks, so this fires by chance on any body large enough to be
chunked, and deterministically for a body split at the wrong offset.

Measured against the unfixed server, with each body written in two `req.write()` calls split on
a UTF-8 continuation byte:

| body | sent | forwarded |
|---|---|---|
| `héllo — ünïcode ✓ 日本語 😀` | 94 B | **98 B**, `h��llo …` |
| `こんにちは世界` | 76 B | **82 B**, `���んにちは世界` |
| `┌─┐│ build ok │└─┘` | 89 B | **95 B**, `���─┐│ build ok │└─┘` |

A corrupted body is always *longer* than it was sent, because U+FFFD re-encodes to three bytes.
Nothing was elided on any of these turns — the corruption happens at the socket, before the
pipeline exists, and the corrupted string is what goes upstream.

### This is DECISIONS §35 at a different seam

Phase B's reasoning — *"`rawInput` is a decoded string, so the evidence is gone by the time a
request exists"* — is correct and generalizes. It was applied to the one adapter that reads from
disk and not to the one that reads from a socket, where it is worse: the bytes reach a provider
rather than a terminal. The MCP transport is unaffected, and instructively so: `setEncoding('utf8')`
installs a `StringDecoder`, which holds partial sequences across chunk boundaries. Manual
concatenation is exactly what bypasses that machinery.

### Decision

Collect `Buffer[]`, `Buffer.concat` on `end`, decode **once**. Then apply the CLI's own round-trip
test (`Buffer.from(str, 'utf8').equals(buf)`) and, when it fails, pass the caller's bytes through
untouched.

Concatenating correctly fixes the chunk-boundary defect. It does not make a body that was never
valid UTF-8 representable — the decode is still lossy — so the round trip is a separate question
and gets a separate answer. Optimizing such a body is not an option, because every stage,
validator and token estimate operates on the decoded string and would be reasoning about content
the caller never sent; a saving measured against corrupted input is worse than none. Rejecting it
is not an option either: TokenDamper is a transparent proxy, and a body the provider might well
accept is not TokenDamper's to refuse. So it is forwarded verbatim, which is invariant 3 on the
Gateway.

`ProxyRequestResult` gains an optional `bodyBytes`; `body` is still populated with the lossy
decode so existing readers keep working, but anything that puts bytes on the wire prefers
`bodyBytes`. Both the upstream `fetch` and the locally-returned branch in `writeProxyResult` do.

### Also fixed

The body-size cap recomputed `Buffer.byteLength(body, 'utf8')` over the entire accumulated string
on every chunk — O(n²) in the length of the request (audit L3). It is now a running total, which
falls out of collecting buffers anyway.

### Not done here

The remaining Gateway findings are untouched and independent: the `exec` token handoff (C3), the
0-bytes-saved measurement (H1), structured message content flattened to a string (C4), and the
two environment branches in the request path (M8). C2 is a correctness fix to the pass-through,
not an argument that the mode is finished.

---

## 39. The Trace Carries What the Stages Computed

**Date:** 2026-08-09 · **Status:** Accepted · **Closes:** max_audit.md M6

`buildTrace` projected every `StageResult` down to `{ stageId, status, durationMs: 0, changed }`.
The stage's `metrics` and `notes` were discarded and the duration was a literal constant.

So the trace could say that `compression:token-hashing` ran and changed something, and nothing
about what it removed, how much, whether any elision was reversible, or how long it took. The
stages compute that telemetry carefully — `itemsHashed`, `regionsHashed`, `bytesSaved`,
`irreversibleElisions`, `skippedPostConditionRejected` — and all of it was thrown away one
function call after being calculated. `--diff` and `--diff-html` partially compensate on the CLI;
the MCP `get_optimization_trace` tool and the Gateway had nothing else at all.

For a product whose stated differentiator is auditability, the audit surface was the least
informative one in the system.

### Decision

`StageTrace` gains `metrics` and an optional `notes`, carried through verbatim. `durationMs` is
measured by the **engine**, not by the stage: a stage that read a clock would stop being a pure
function of its input (invariant 1), whereas timing an opaque call from outside is an observation
*about* the stage and cannot change what it returns. `performance.now()` rather than `Date.now()`,
because most stages finish inside a millisecond and integer resolution would report the same
uninformative `0` the hardcoded constant already did.

The trace was already non-deterministic — it carries a UUID `requestId` — so this changes nothing
about invariant 1, which is a statement about emitted **bytes**.

### The pruner's note was not vague, it was false

`pruning:topology-pruner` returned `notes: 'All items fit within token budget; no pruning
required.'` unconditionally whenever `itemsPruned === 0`. Measured, a 5,405-token file at
`maxInputTokens: 10` reported that all items fit. They do not.

The mechanism is worth stating because it is also H5: `applyCacheAwarePrefixLocking` pins every
item inside the first 1,024 tokens, `solve01Knapsack` places pinned items outside the candidate
set and always selects them, and `createContextBundle` produces a **one-item** bundle for CLI,
MCP and bench. Item 0 is therefore always pinned and `itemsPruned` is always 0. The note reported
that pruning was *unnecessary* for the case where it was *impossible*.

The note now distinguishes the three cases and names the mechanism, and the metrics carry
`bundleTokens` and `maxTokens` so the claim is checkable rather than asserted:

> Nothing prunable: all 1 item(s) are pinned by cache-prefix locking, but the bundle is 5405
> tokens against a budget of 10. Pinned items bypass the knapsack (invariant 7), so the budget
> could not be enforced.

This does not fix H5 — the knapsack is still unreachable on every shipping path. It stops the
trace from concealing that behind a reassuring sentence, which is the necessary first step:
the defect is now visible in the one place a user would look.

---

## 40. A Ratio That Measured Nothing Does Not Vote, and a Local Variable Is Not a Symbol

**Date:** 2026-08-09 · **Status:** Accepted · **Closes:** max_audit.md C1b, §3.2

Two changes that only work together. Landing either alone is measurably worse than landing both.

### The audit's proposed fix is inert

max_audit.md §3.2 proposed using `extractContentMarkers` in `R_struct`, excluding the
`filepath:` marker that no content transform can destroy, and stated this "would fix both cases
at once". Measured, it fixes neither: removing the only marker an item had leaves the before-set
**empty**, and an empty set defaults `R_struct` back to **1.0** — the identical free 0.40,
arriving by a different route. That change alone was byte-identical across all 586 rows of a
frozen 293-file corpus.

The free 0.40 comes from the **empty-set default**, not from `filepath:`. This is §33's argument
("`0.0000` means 'retained everything' and 'found nothing to look at' indistinguishably") applied
to the *score* rather than to the gate.

### Decision, part 1: an unmeasured ratio is excluded, not defaulted

`R_struct` is computed over `extractContentMarkers`, and the weight of a ratio whose before-set
is empty is redistributed to the ratio that did measure something. For code, `S_k = 1 - R_AST`,
so the maximum symbol loss that can pass the 0.40 gate falls from **66.7%** to **40%**. When
neither ratio measured, retention returns 1.0 and stays silent — that case belongs to the
measurement gate (§37), and having both refuse would attribute the refusal to the wrong question.

### Decision, part 2: `extractSymbols` counts semantic surface, not locals

Applied on its own, part 1 costs **14 TypeScript files and 11.75pp** — and the loss it was
guarding against turned out to be almost entirely fictitious. Measured at
`targetReductionRatio: 0.5`:

| file | symbols "lost" | of which function-local |
|---|---|---|
| `src/core/engine/index.ts` | 42 of 63 (66.7%) | **41** |
| `src/core/hashing/tokenizer.ts` | 9 of 17 (52.9%) | **9** |

Not one exported function, type or interface was lost in either case — `selectElisionRegions`
retains signatures by construction. The locals rule matched `const|let|var` anywhere, so every
`const i`, `const result`, `const msg` inside a function body counted as a semantic symbol on par
with an exported function, and body elision is precisely the transform that removes them. So the
audit's "you can destroy two-thirds of every symbol in a file and pass" was measuring temporaries
inside bodies the caller asked to have elided.

**Python is the control.** Its extractor never had a locals rule, its measured symbol loss under
the same elision is **0.0%**, and it is unaffected by either half of this change. That asymmetry
is what identified the defect: a safety metric should not depend on which language's extractor
happens to harvest block-scoped bindings.

The rule is now anchored with `^…/gm`. In TypeScript and JavaScript a top-level declaration *is*
a column-0 declaration; indented ones are inside a function, class or block, and are body content.

### Measured, over a frozen 293-file corpus (586 rows, both routes)

| arm | TS files reducing | TS saved | Python saved |
|---|---|---|---|
| before (§37 only) | 22 | 14.00% | 14.98% |
| C1b alone | 8 | **2.25%** | 14.98% |
| symbol fix alone | 30 | **25.59%** | 14.98% |
| **both (shipped)** | **29** | **23.38%** | 14.98% |

The gate is **stricter** and reduction is **higher** — because the gate is now measuring semantic
loss instead of noise. Python, prose and every uncovered-language bucket are unchanged.

### The one file it costs, and why it is left alone

`src/cli/html-reporter.ts` goes from reducing to falling back. Its sole content marker is
`directive:TD_PRESERVE:[^\s&]+)/g,` — harvested from a **regex literal** in the file that
implements syntax highlighting for that directive. Its own pattern source is its only structural
evidence, eliding it drives `R_struct` to 0, and the file is refused.

That is a false positive, and it is left in deliberately. It fails **conservatively** (fallback,
byte-identical output, no data loss), it is 1 file in 57, and special-casing it would be
over-fitting the metric to one file in this repository. Recorded rather than patched.

### Known residue

`extractSymbols` still harvests from **comments**, because it is regex over raw content with no
lexer. Measured artifacts: `fn:of` from the prose "pure function of its input", and `type:of`
from "that class of bug". After the locals fix this is the entire remaining symbol loss on
`src/core/engine/index.ts` — 1 symbol of 22, 4.5%. Small, but it means symbol counts on a heavily
commented codebase carry noise proportional to how often the words `function` and `class` appear
in English. Not fixed here: making extraction comment-aware is a per-language lexing problem,
and the measured cost does not yet justify it.

---

## 41. The Gateway Is an Experimental Pass-Through, and `exec` Now Reaches It

**Date:** 2026-08-09 · **Status:** Accepted · **Closes:** max_audit.md C3, H1, L2 (partial)

Two findings, one decision, because they are the same question: what is Gateway mode *for*?

### C3 — `exec` returned 401 to its own child

`runExecCommand` generated a per-run token and injected it as `TOKENDAMPER_GATEWAY_TOKEN`. The
server required it on every non-`/health` request. The child is `aider`, `claude`, `codex` or
`curl` — third-party software that has never heard of that variable and sends `authorization` or
`x-api-key` and nothing else. **Nothing in `src/` read it either.**

Reproduced by spawning a real child through `runExecCommand`: every request came back
`401 Unauthorized: Invalid or missing gateway token`, and `exec` exited **0**. The flagship
integration was non-functional end to end, and the existing test suite passed throughout because
its gateway test presented the header that no real client sends.

**Decision: trust loopback peers, keep the token for non-loopback binds.** The server binds to
`127.0.0.1` by default, so a loopback peer was already the only peer that could connect; the
token was protecting one local process from another on the same machine. That boundary is real
but narrow, and it was being paid for with a mode nobody could use. Loopback is determined from
`req.socket.remoteAddress` — never from a header, since `X-Forwarded-For` is attacker-supplied —
and includes `::1` and the IPv4-mapped `::ffff:127.0.0.1` form Node reports on a dual-stack
listener.

**`HTTP_PROXY` and `HTTPS_PROXY` are no longer set.** `GatewayServer` implements neither HTTP
proxy semantics (absolute-form request URIs) nor the `connect` event `CONNECT` tunnelling
requires. Any child honouring `HTTPS_PROXY` — most HTTP clients — would have failed to reach the
provider at all, independently of the 401 and masked by it. Setting a proxy variable for a server
that is not a proxy is worse than setting nothing. Base-URL interception is now the only
supported mechanism, and is documented as such.

**Partial L2:** the `?token=` query parameter is removed (a credential in a query string lands in
access logs, shell history and any error echoing the URL) and the header comparison is now
constant-time.

### H1 — the Gateway saves nothing across turns, and that is correct

Measured over real sockets on realistic two-turn conversations, where a resent history contains
each block exactly once: **0 bytes saved, fallback on every turn**, for code, prose and JSON tool
results alike.

This is not a bug. `cleanup:session-dedup` marks an elision `recoverable: true` only when an
intact copy survives elsewhere in the same outbound payload (§16). A sole copy seen only in a
previous turn is scored in full and refused — correctly, because Phase A established that the
consumer is a stateless provider API with no rehydration mechanism, so such a marker is
**deletion, not reference**.

The consequence is that the Gateway has no cross-turn transform, and none is available without
provider-side resolvability that does not exist.

**Decision: document it as experimental and stop advertising the saving.** The mode delivers
transparent interception, the full validation pipeline, byte-faithful forwarding (§38), metrics,
and within-payload deduplication. That is a coherent product; "Cross-turn Session Deduplication"
was not. README, ARCHITECTURE and CLAUDE.md invariant 8 are updated to say so.

The measurement is pinned by `test/integration/gateway-dedup-reality.test.ts` rather than left
as prose. **If a cross-turn saving ever appears, that is the signal to read**: either
resolvability was implemented, in which case update the test deliberately, or the drift gate was
relaxed and the Gateway is deleting content the model cannot recover, in which case do not.

### Also corrected in the README

The audit's M4 list of overstated claims is now resolved rather than deferred: "0/1 Knapsack
Planning" is marked implemented-but-unreachable (H5, one-item bundles), "Reversible Token
Hashing" is qualified as irreversible on the CLI by design, `TOKENDAMPER_RISK_TOLERANCE` is
marked as having no effect on optimization (H4, still open), and `TOKENDAMPER_GATEWAY_TOKEN` is
described accurately.

### Not done here

H1's underlying limitation is untouched by choice. C4 (structured message content flattened to a
string) remains open and is still masked by the fallback; M7 (savings measured against a
newline-joined render rather than the wire bytes) and M8 (two environment branches in the request
path) remain open.

---

## 42. An Imperative Lives in a Comment, Not in an Expression

**Date:** 2026-08-09 · **Status:** Accepted · **Closes:** max_audit.md H6

`cleanup:constraint-preservation` scans content for nine keywords — `must`, `must not`, `never`,
`always`, `only if`, `do not`, `required`, `except when`, `make sure to`, `critical` — and
`validate()` fails the run if any extracted sentence is absent afterwards. The list is written for
natural-language system prompts. It was applied to raw content of every kind, and in source
`required` and `critical` are ordinary identifiers. On the audit's corpus, **24 of 40 fallbacks
involved `CONSTRAINT_DIRECTIVE_LOST`** — the single largest cause of code not being optimized.

### Neither extreme is right, and the measurement says why

Over a frozen 293-file corpus at `targetReductionRatio: 0.3`, classifying every directive a run
reported as dropped by where it came from:

| bucket | from comments / docstrings | from code |
|---|---|---|
| Python | 16 | **38** — nearly all `logger.critical(...)` |
| TypeScript | 38 | **13** — `readonly required?`, error-message literals |

Trusting the check everywhere keeps 51 false positives. The audit's proposed remedy — *"scope
directive extraction by content type (prose/markdown/prompt kinds only, not `code`)"* — discards
54 genuine constraints, and specifically the Python docstring case that
`docs/phase-1d-semantic-gate-disposition.md` measured to be the **only** thing this check
actually catches.

What separates the two populations is not the content **type** but the **region**. An instruction
to a reader lives in a comment or a docstring; it never lives in an expression.

### Decision

1. **Extraction is scoped to prose regions.** `extractProseRegions` returns whole content for
   prose content types, and for code returns line comments (`//`, `#`, `--`, `*`), block comment
   bodies, and Python docstrings including their interior lines. It is deliberately
   line-oriented and syntax-approximate rather than lexed: this is a *filter on what may raise a
   constraint*, so over-inclusion costs a false positive — the pre-existing behaviour — and
   under-inclusion costs a missed constraint. Requiring the comment leader at the **start** of a
   trimmed line is exactly what excludes `logger.critical(exc)` while keeping
   `# never call this twice`.

2. **Retention is checked per item.** The check collected every item's directives into one list
   and tested each against `after.items.map(i => i.content).join('\n')`. A directive extracted
   from item A was therefore satisfied if the string happened to appear anywhere in item B — the
   check could pass for content that was in fact destroyed — and a loss anywhere failed the whole
   run with no way to say where. Matching by item id fixes both, and the message now names the
   item. An item absent from `after` is skipped, on the same reasoning
   `DriftTracker.findUnwitnessedItems` records: selection is not elision, and failing here would
   make any prunable item carrying an imperative unprunable.

### Measured

| bucket / route | before | after | delta |
|---|---|---|---|
| python (file) | 14.98% | **23.14%** | +8.16pp |
| python (stdin) | 14.88% | **22.66%** | +7.78pp |
| typescript (file) | 23.38% | **27.33%** | +3.95pp |

**20 rows changed of 586, and none regressed** — no file went from reducing to falling back.
Every other bucket is byte-identical.

### What remains, and why it is the check working

After the change, TypeScript has **zero** remaining code-sourced directives; every remaining
`CONSTRAINT_DIRECTIVE_LOST` is a genuine imperative in a comment or docstring that an elision
would drop. Those files still fall back, and should: the run would otherwise silently delete an
instruction. That is the check doing its job rather than misfiring, and it is why the category
does not go to zero.

### Ordering note

This had to land **after** §37 (C1a). The audit observed that this check was "currently the only
thing preventing markdown documents from being deleted" — a document survived if its author
happened to use one of nine words. Narrowing it first would have widened that data loss. With
§37 in place the drift measurement gate covers markdown on its own merits, which the corpus
confirms: the prose bucket is unchanged at 28/28 fallbacks, now attributed to drift rather than
to a coincidence of vocabulary.

---

## 43. The Knapsack Gets Something to Solve

**Date:** 2026-08-09 · **Status:** Accepted · **Closes:** max_audit.md H5 (ingestion half)

`ARCHITECTURE.md`, `README.md` and CLAUDE.md all put a "Stateless 0/1 Knapsack Planner" at the
centre of the design, and invariant 6 promises cache-aligned selection as the differentiator. None
of it could run. `createContextBundle` produces exactly **one** item;
`applyCacheAwarePrefixLocking` pins everything inside the first 1,024 tokens; `solve01Knapsack`
places pinned items outside the candidate set and always selects them. So item 0 was always
pinned, `itemsPruned` was always 0, and `planner/knapsack.ts`, `planner/cache-aware.ts`,
`topology/topology-scorer.ts`, `topology/dependency-graph.ts` and `topology/git-inspector.ts`
could not affect any output the product was able to produce.

`optimize` now accepts multiple paths and directories. Measured on `src/core` at
`maxInputTokens: 4000`: **31 items, 15 pruned, 20,540 tokens saved by the planner.**

### The output format, and the test that demanded a decision

`test/unit/fallback-render.test.ts` pinned the success path's `items.join('\n')` as a latent
defect and said in as many words that whoever made an `emittedOutput` consumer multi-item "should
stop and read it". This is that change, so the defect is fixed rather than inherited.

**One item renders as its content and nothing else**, which keeps CLI, MCP and bench byte-identical.
More than one renders with a `==> path <==` header per item — `head`/`tail`'s convention, chosen
because it is one a reader already knows. It is **not** collision-proof and nothing escapes it:
the consumer is a model being given context, legibility is worth more than round-trip parsing,
and anything needing to machine-parse should read `finalBundle` from the trace, which carries the
items structurally.

Fail-open is **per file** — the original bytes of each file, under the same headers, never a
re-encoding of the decoded string (DECISIONS §35 holds per item). What is not byte-identical is
the stream as a whole, because the headers are TokenDamper's and were in no input file.

### Three defects this exposed, each fixed here

1. **Pruning was scored as drift.** `findUnwitnessedItems` had always exempted an item absent from
   `after` — selection is not elision — but the *ratios* compared whole bundles, so a pruned
   item's symbols simply vanished and `R_AST` read the planner doing its job as semantic loss.
   Invisible while every bundle held one item; decisive at 31. The ratios now score retained items
   only, **guarded on ids actually corresponding** between the bundles: `id` is content-derived at
   construction and preserved by the transforms, so a caller that rebuilds its `after` bundle
   independently would otherwise leave nothing to compare and report `S_k = 0` for a gutted
   bundle. With no correspondence the whole bundle is compared, as before. Failing open to *more*
   measurement is the point.

2. **Whole-item elision of a symbol-bearing item is refused every time**, so it is no longer
   attempted. Since §40, `S_k = 1 - R_AST` for code, so destroying every symbol scores 1.0 against
   a gate that fires above 0.40 — no threshold or flag lets it through. On a one-item bundle that
   was invisible (the run fell back and emitted the input, which is what skipping produces anyway).
   On a multi-item bundle two pure-`types.ts` files — interfaces to lose, no function bodies to
   elide — were taking a 16-file batch down with them. Symbol-free items are unaffected and still
   elided whole; that is the population the path exists for.

3. **`TD_PRESERVE:` matched its own implementation.** `drift-tracker.ts` (the regex literal) and
   `cli/html-reporter.ts` (the highlighter for the same directive) each acquired a content marker
   they do not semantically have. Because `R_struct` is a bundle-scoped set, one phantom marker
   being elided drove it to 0 and took a 16-file batch to `S_k = 0.4053` on a run whose real symbol
   retention was **99.1%**. Harvesting is now scoped to prose regions **for `code` only** — not for
   the prose types generally, because `TD_PRESERVE:` is an unambiguous token rather than an English
   word, and the only way it appears without being a directive is as a literal inside an
   expression, a construct that exists only in code. This also retires the `html-reporter.ts`
   regression §40 recorded as left in deliberately.

Also fixed: the envelope headers were counted on the output side only, so a multi-item fallback
reported **72,973 → 73,667** tokens — a negative reduction, the same shape as the phantom −1.39%
already diagnosed once in the Python bench harness (Issue 5). `tokenBefore` now renders the same
envelope when the bundle holds more than one item. Single-item and Gateway paths are untouched;
for the Gateway `rawInput` is the whole JSON body and the bundle is the extracted messages, which
are genuinely different populations.

### Measured

Frozen 293-file corpus, 586 rows: **1 row changed, 0 regressions.** TypeScript 27.33% → **29.55%**.
Fallback counts drop sharply (prose 28 → 9, TypeScript over stdin 57 → 0) because items whose
elision was doomed are no longer transformed-then-reverted; the emitted bytes are the same, the
wasted work is gone.

### Not done: §3.1, which is now the binding constraint

**Multi-file runs still fall back on real corpora, and not for any reason this change can fix.**
On the 45-file Python corpus: drift 0.0359, AST clean, 169 KB elided — and it falls back, because
**26 constraint failures across 14 items revert all 45**. Validation is bundle-scoped and fallback
is all-or-nothing (audit §3.1, Phase 1c, unstarted).

This delivers the mechanism; §3.1 stands between it and the outcome. The prerequisite Phase 1c was
missing — attribution — now exists for the classes that matter: constraint failures name their
item (§42), unwitnessed items name theirs (§37), and AST issues carry `itemId`. Drift remains
bundle-scoped and would need its own rule.

`ARCHITECTURE.md` is unchanged: multi-item bundles were always in the model (`createBundleFromItems`
predates this), and nothing about the linear pipeline moved. What changed is that a shipping
adapter finally builds one.

---

## 44. Three Entry Modes, Three Kinds of Untruth

Audit Wave 2 — M5a, M5b, M8, M9, M10, H4, plus the M5 minor items. Six independent findings
that share one shape: **a surface that reports success while doing nothing, or doing something
other than what it says.** They are grouped here because the grouping is the finding.

### M5a — the MCP entry mode was a guaranteed no-op

`optimize_context` exposed `rawInput`, `language`, `path`, `maxInputTokens`, `riskTolerance`
and `preserveKinds`. It did not expose `targetReductionRatio`, and its description promised
compression unconditionally.

With no budget, `plan()` returns `pass_through` with an empty `stageIds`. Zero stages run. The
tool returned the input unchanged, `reductionRatio: 0`, and **no error** — so a client calling
the tool exactly as documented received a clean success for work that never happened. One of
three advertised entry modes did nothing, and nothing in its output said so.

`targetReductionRatio` is now a schema property, range-checked and **rejected rather than
clamped** (§29's argument: a value silently coerced into range is a run the caller believes
they configured and did not). The description states that a budget is required.

The second half matters as much as the first. The response now carries `budgetApplied`,
`planMode` and `stagesExecuted`, and a `notice` when no budget was in effect. This is
invariant 10 applied to a budget rather than to a validator: `reductionRatio: 0` alone cannot
distinguish *"nothing was compressible"* from *"nothing ran"*, and only one of those is the
caller's to fix. Measured end to end through the stdio server on `src/core/planner/index.ts`:

```
no budget    budgetApplied false  pass_through       0 stages   0.0%   + notice
ratio 0.3    budgetApplied true   topology_knapsack  4 stages  69.1%
```

The 586 tokens saved on the second row match `tokenEstimateSaved: 586` from the CLI on the same
file — same engine, cross-checked across routes rather than trusted from one.

Gated on C1a (§37) so that turning MCP on could not start deleting markdown documents. C1a is
merged, so it is safe now.

### M5b — a marker the product has never produced

`rehydrate_context` matched `/<ELIDED:\s*ref=([A-Za-z0-9_-]+)[^>]*>/g`.
`cleanup:session-dedup` emits `[TokenDamper Elided: ref=... bytes=... kind=...]`.

Angle brackets against square brackets, different prefix, no overlap. The regex could not match
any marker the product emits, so session rehydration through MCP matched nothing on every input
and returned the text unchanged — again with no error. It had never worked.

The fix is not the pattern. Both sides were internally consistent and independently plausible;
what broke was that **each restated the format the other owned**. `renderSessionElisionMarker`
and `SESSION_ELISION_MARKER_PATTERN` now live together in `core/elision/marker.ts`, the stage
calls the renderer, and the tool builds its regex from the exported source. The adapter reaches
core, not `src/stages/` — invariant 4 is intact.

`test/unit/mcp-session-rehydration.test.ts` takes its marker from **running the stage**, never
from a literal. A test that restated either format would have passed while the pair was broken,
which is the property that made this survive.

### H4 — knobs parsed, validated, then discarded

| knob | read by |
|---|---|
| `--max-output-tokens` / `TOKENDAMPER_MAX_OUTPUT_TOKENS` | nothing, anywhere |
| `--max-latency-ms` / `TOKENDAMPER_MAX_LATENCY_MS` | nothing, anywhere |
| `--risk-tolerance` / `TOKENDAMPER_RISK_TOLERANCE` / MCP `riskTolerance` | `cli/bench-table-renderer.ts:97` — one display column |

All three were parsed, range-validated, merged into the budget, and then read by no stage,
validator or planner. Setting one exited 0 and changed nothing. Risk tolerance was the worst of
the three because it was *nearly* real: it reached a benchmark table, where a column implies the
row's numbers depend on it.

**Removed from the surface, not from the model.** The CLI flags, the environment variables and
the MCP schema property are gone; `OptimizationBudget` keeps the fields, because
`ARCHITECTURE.md` pins that model as frozen and a field awaiting an implementation is a
different thing from a dial that reports success. Each field now carries a doc comment naming
its consumer or stating it has none — so the next person to add one has to answer the question
this finding is about.

`--target-reduction-ratio` **deliberately stays**, despite being nearly as inert: the planner
reads it only as `> 0`, making it an on/off switch wearing the name of a dial. Removing it would
take the only budget flag every doc and example uses, and making it a real proportional target
is a planner change. It stays a named decision rather than a silent one.

Removal is a hard error, not a shrug — `Unknown argument: --risk-tolerance`. A withdrawn flag
that parsed and did nothing would be the same defect wearing a new hat.

### M8 — test seams in the request path

`TOKENDAMPER_MOCK_UPSTREAM=true` made the proxy answer with the caller's own optimized request
body and a 200, as though a model had produced it. `NODE_ENV === 'test'` waived the
missing-credentials 401 — and `NODE_ENV=test` is set by a great many CI systems and process
managers that mean nothing by it. Neither was documented.

Both are now `ProxyHandlerOptions` fields — `mockUpstream` and
`allowMissingUpstreamCredentials` — plumbed through `GatewayConfig` and `ExecOptions`. **The
environment reads are gone entirely**, not kept as a fallback: retaining
`TOKENDAMPER_MOCK_UPSTREAM` would have preserved precisely the hazard the finding names.

The evidence arrived on its own. Ten tests in `test/unit/gateway.test.ts` failed the moment the
`NODE_ENV` branch was removed — they had been passing *because vitest sets that variable*, and
none of them mentioned it. That is the finding demonstrated rather than argued: a waiver
reachable by ambient configuration was already load-bearing somewhere nobody had chosen.

### M9 — request headers returned as response headers

Both optimize paths returned `{ ...cleanHeaders, 'content-type': 'application/json' }`, and
`cleanHeaders` strips only `host` and `content-length`. `authorization`, `x-api-key` and cookies
came back out **on the response**. Reproduced under mock upstream as `x-api-key: sk-test`.

Latent, because the normal path overwrites these with the upstream response's headers — but
"latent" meant one environment variable away (M8), and a response header is a value that gets
logged, cached and proxied onward. Response headers are now constructed by
`localResponseHeaders()`, which returns exactly `content-type`. The fix is to stop deriving one
from the other, not to lengthen a strip-list: no property of an inbound request header makes it
a correct thing to say on the way back.

### M10 — `bench` threw for every installed user

`humaneval.ts` and `codexglue.ts` resolved `test/fixtures/bench/...` against `process.cwd()`,
and `test/` was not in `package.json`'s `files`. The CLI additionally defaulted to the literal
path `test/fixtures/bench`, which exists only in a checkout.

Every existing bench test runs with the repository as its working directory, which is exactly
why none of them saw it.

`resolveBundledFixture` tries the working directory first — preserving checkout behaviour, and
letting a user's own copy win — then the package root. The package root is found by **walking
up from `__dirname` to the nearest `package.json`**, not by a fixed number of `..` segments:
this module runs from `src/bench/fixtures/` under vitest and `dist/src/bench/fixtures/` when
compiled, so a constant offset is correct for exactly one of them and would have reintroduced
the bug on the other route. The fixtures now ship in `files`.

Verified by running the built CLI from a temporary directory with no `test/` tree: 10 fixtures
loaded, exit 0.

Adjacent, and fixed with it: `loadBenchmarkFixtures('test/fixtures/bench')` threw `EISDIR`
because a directory reached `readFileSync`. The CLI had always pre-empted this at its own call
site, so only direct API callers hit it. A directory argument now means "the datasets under
here", handled in the loader — one place instead of two.

### M5 minor — reads that write, and a handshake that does not shake

Three smaller items in the same file:

- **`traceStore` was a module-level `Map`** serving every `createMcpServer` in a process. Two
  servers shared one 100-entry budget, each could evict the other's traces, and a request id
  minted by one was retrievable through the other. Now created per server and injectable.
- **`get_session_metrics` and `resources/read` called `getOrCreateSession`**, so *asking about*
  a session created it: an unknown id answered with a plausible all-zero record instead of
  saying it did not exist, and under `maxSessions` an inspection call could evict a live
  session. `getSession` is the read-only counterpart; both callers use it and report a miss.
- **`initialize` returned `MCP_PROTOCOL_VERSION` unconditionally**, ignoring the client's
  requested version. That is not a negotiation — a client asking for a revision this server does
  not implement was told it had been agreed to. `negotiateProtocolVersion` echoes a supported
  request and otherwise answers with this server's own. `SUPPORTED_PROTOCOL_VERSIONS` lists the
  single revision actually implemented, because negotiation claiming more than the code does
  would be this same finding with extra steps.

### Measurement

**594 of 594 corpus rows are identical to the pre-Wave-2 engine**, across `outputSha`,
`byteIdentical`, `tokenBefore`, `tokenAfter`, `reduction`, `fallbackUsed`, `driftScore`,
`debtScore`, `planMode`, `stageCount`, `contentType`, `astChecked`, `astUnchecked`,
`driftMeasured` and `unwitnessedItems`. Nothing in this wave touches a stage's output, and that
is now measured rather than assumed — both engines run against the *same frozen corpus*, varying
only `dist/`, per the method in CLAUDE.md.

The bucket table moved anyway, and the reason is the trap that method exists to catch:
**typescript file went 25.35% → 23.26% with `reduced` unchanged at 33.** The denominator grew by
one file — `src/bench/fixtures/bundled-path.ts`, added by M10 — which falls back and contributes
zero. No file that reduced before stopped reducing. An aggregate compared across two different
corpora is not a comparison, which is why the per-row check above is the one that counts.

The prose bucket also went 28 → 29, and that one was **already outstanding**:
`docs/audit-remediation-status.md` landed in `7a1b5a7`, after the `dd540fe` baseline was
recorded. `collect.js` refused on both mismatches before measuring anything — working exactly as
designed — and `recipe.json` records each step with its cause.

One near-miss worth recording, because it is the same class of error as the findings above: the
first per-file diff keyed rows on `r.file`, a field the harness does not emit. Every row
collapsed onto one undefined key, and the script cheerfully reported **"compared 2 rows,
differing: 0"** — a green result from a comparison that never happened. The row count is what
gave it away, which is why the corrected script asserts 594 and refuses duplicate keys.

---

## 45. Structure Is Not a String, and C4 Was Not Latent

Audit C4, the last unstarted audit item. Three defects in the Gateway's payload mapping, all in
`src/gateway/proxy.ts`, plus a refusal added at the shared elision chokepoint.

### The finding, and the part of it that was wrong

Ingestion flattens a provider message to the string the pipeline needs:

```js
const textContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
```

Egress wrote the optimized item back as a string regardless of what the caller had sent. A
message whose content was `[{"type":"tool_result","tool_use_id":"toolu_01ABC",…}]` came back as
`content: "…"`. The Anthropic Messages API requires a `tool_use` block to be answered by a
`tool_result` block carrying the matching id; a bare string there is a
`400 invalid_request_error`, and the same shape breaks OpenAI multimodal content parts. Tool-heavy
traffic is the entire target market.

**The audit rates this "Critical when reached (currently masked by H1)" and says the payload falls
back unchanged — "that is luck". Measured, that is true of one case and false of the other, and
the false one is the case that matters.**

Cross-turn elision of a *sole* copy is `recoverable: false`, scored in full by `DriftTracker`,
and exceeds the gate — fallback, corruption never ships. That is the masked case.

Content duplicated **within one payload** is elided `recoverable: true`, and `DriftTracker`
exempts it by substituting the pre-optimization content before scoring (§16). No drift, no
fallback, and the elision goes out on the wire. Measured on the pre-C4 engine, a two-copy
`tool_result` payload came back as:

```
fallbackUsed: false   tokensSaved: 42
messages[2].content = "{\"__td_block__\":\"[TokenDamper Elided: ref=17c67ba215e4 bytes=251 kind=conversation]\"}"
```

A `tool_result` block, replaced by a string, shipped with no fallback and a reported saving.
Within-payload duplication is also **the only case the Gateway saves anything on at all**
(§41, `gateway-dedup-reality.test.ts`). So C4 was live on precisely the one path the mode exists
for — not latent, and not luck.

This is the third audit claim this project has had to correct by measurement (§40's inert
`filepath:` fix, §42's imperative scoping). The pattern is worth naming: the audit's *findings*
have held up well; its assessments of **whether a defect is reachable** have not, because
reachability here depends on interactions between the drift exemption, the planner mode and the
stage list that are not local to the code being read.

### What changed

**1. The refusal lives at the chokepoint, not in the Gateway.** `core/elision` gained
`CONTENT_SHAPE_METADATA_KEY` and `hasStructuredContent`, and both `elideItem` and `elideRegions`
refuse an item carrying `contentShape: 'structured'` with a new `ElisionSkipReason`,
`'structured_content'`. Putting it in the Gateway would have protected today's single stage;
putting it here protects any stage the Gateway is ever pointed at, which is the change most
likely to make this live again.

`ElisionSkipReason` is a union and the stages count into `Record<ElisionSkipReason, number>`, so
adding the member **failed to compile** in all three eliding stages until each acknowledged it.
That is the intended forcing function, and it is why the reason is a union member rather than a
boolean.

The refusal is checked **first**, before the savings and syntax checks. A structured item's
content is `JSON.stringify(...)`, which classifies as JSON, so it would usually have been refused
downstream anyway — for being JSON. Right outcome, wrong reason, and it evaporates the moment the
classification changes. The item is now refused for the reason that is true of it.

An item with **no** tag is treated as plain text, which is correct for every non-Gateway
producer: CLI, MCP and bench all ingest text that was text.

**2. Egress maps by slot, not by array position.** Ingestion skips falsy entries
(`if (!msg) continue`) while egress indexed `finalBundle.items[idx]` by position, so a single hole
in `messages` shifted every later item onto the wrong message. This was **not** masked either —
it is live on today's Gateway, and the test that pins it fails against the pre-C4 engine with
`expected 'ok' to be 'export function helper0…'`: the assistant's message had received the
previous item's content. Items now carry `payloadSlot` and egress looks up by it.

Invariant 9 says the Gateway maps `finalBundle` back onto the parsed payload. It does not say
*positionally*, and a filtered push could never supply the precondition a positional map assumes.

**3. The Anthropic `system` prompt is mapped back.** It was ingested as `items[0]` while
`updatedMessages` started at `itemOffset`, so a change to it was dropped from `finalBody` — while
`optimizedTokens`, and therefore `tokensSaved` and `dedupRatio`, still counted it as saved. The
turn's metrics described a saving that never reached the wire.

This path is **unreachable today** and the entry says so rather than claiming a fix that fires:
`cleanup:session-dedup` refuses system items (Rule 2), and rehydration — the one branch that runs
before that check — needs `rehydrateRefs`, which the Gateway does not set. What the change buys
is that the mapping is correct when something eventually does change a system item, and that the
`finalBody` rebuild neither drops nor duplicates `system`, which is a live regression risk created
by this commit and is tested as one.

### Measurement

**594 of 594 corpus rows identical** to the pre-C4 engine across 17 fields, same frozen corpus,
varying only `dist/`. The guard is inert for untagged items, which is every CLI, MCP and bench
item, and that is measured rather than reasoned.

Live on a real `GatewayServer` over sockets, the discriminating comparison — identical bytes,
differing only in shape:

```
structured            fallbackUsed: false   tokensSaved: 0    content stays an array
same bytes as string  fallbackUsed: false   tokensSaved: 42   elided normally
```

The refusal is scoped to the shape, not to the content, and the saving it declines is honestly
reported as zero rather than bought by corrupting the payload.

### A corpus caution, recorded because it cost time

The TypeScript bucket read **23.16%** here against the **23.26%** recorded for Wave 2, on the same
297-file recipe with `reduced` and `fallback` unchanged. The pre-C4 engine also reads 23.16%, so
it is not this change.

The cause is **line endings**. Wave 2's corpus was frozen from working-tree files written with
LF; committing and checking them out normalized them to CRLF, adding a byte per line to the
repository's own sources — which are the corpus. `file` on a frozen corpus source reports "with
CRLF line terminators".

So aggregate reduction figures on this repo are not comparable across a commit boundary, not only
across a corpus-size change. Only the per-row A/B over one frozen corpus is.

---

## 46. Three Decisions: Say What Cannot Be Done, Say What Is Actually Checked, Stop Maintaining Two Copies

Audit H2, M1 and M11. The audit filed these as *decisions rather than tasks* — each had a
legitimate "narrow the product" answer and a legitimate "build more" answer, and the choice was
not the auditor's to make. Recorded here with the option taken and the option refused.

### H2 — decided: report why, do not narrow the accepted set

Twelve of nineteen recognised extensions cannot produce a non-zero reduction under any flag
combination. Two gates, both single-language-family and neither threshold-controlled:
`selectElisionRegions` returns `[]` outside TypeScript/JavaScript and Python, and a whole-item
elision has to survive a measurement gate that a Go `func` or a C function gives it nothing to
work with.

**Refused: narrowing the accepted set.** Rejecting `--language go` would be the stronger honesty
signal, and it would also delete a working behaviour — pass-through is byte-identical and
harmless. Taking away something that works, to avoid saying something true, is the wrong trade.

**Taken: say it.** `trace.languageSupport` carries `supported`, `unsupported`,
`unsupportedLanguages`, `noneSupported` and a `reason`; `validate()` raises an **info** issue,
`LANGUAGE_NOT_ELIDIBLE`, which does not vote on the verdict. This is the same correction M5a made
for budgets, one layer down: `reductionRatio: 0` cannot distinguish *"nothing was compressible"*
from *"nothing could have been"*, and only one of those is about the user's file.

Three things this cost, all worth recording:

**The predicate had to be derived from the gate, not guessed.** The first version asked *"does
the item yield symbols or content markers?"* — reasonable, and wrong. A trivial Go file yields
exactly one symbol: `import:fmt`, an incidental match by the TypeScript import regex. It
witnesses nothing about the function bodies, and Go still cannot reduce, but the predicate called
it supported. The answer is exactly `supportsRegionElision`, because every other elision route
terminates in a refusal: a symbol-bearing item cannot be elided whole (§43), and a symbol-free
item's whole-item elision destroys every content marker and fails the same gate one step along.
Measured, that predicts **3 of 17** probed languages — TypeScript, JavaScript, Python — which is
the audit's headline and the corpus baseline agreeing independently.

**The field had to be threaded through four separate whitelists**, each of which enumerates its
keys: `validate()`'s return, `createValidationReport`, `buildTrace` and `createOptimizationTrace`.
Three of them dropped it silently, and the symptom every time was `trace.languageSupport:
undefined` with everything else correct. `test/unit/language-support.test.ts` asserts on the
**trace**, not on `validate()`, for exactly that reason.

**A friendly notice line was written, and then removed.** The CLI prints the trace to stderr as a
JSON document, and consumers parse the whole stream — this repository's own integration tests
among them. Prepending prose broke four of them. The explanation now lives *inside* the report as
a `reason` field, which is both machine-readable and readable, and stderr stays parseable. A
channel with a contract is not improved by making it friendlier.

### M1 — decided: correct the documentation, do not wire the compiler API

The TypeScript "AST-lite validator" builds no AST. It is a lexer — a good one, tracking strings,
template interpolation, comments and regex literals — that detects unbalanced brackets and
unterminated strings, and nothing else.

Probed against the shipped code rather than taken from the audit, since three audit claims in
this project have failed that test (§40, §42, §45). All of it reproduced exactly:

| Input | Verdict |
|---|---|
| `const x = ;` | **PASS** |
| `function f(a: , b) { return 1; }` | **PASS** |
| `import from "x";` | **PASS** |
| `let 123abc = 5;` | **PASS** |
| `const a = 1 +++++ 2;` | **PASS** |
| `ceci nest pas du code` | **PASS** |
| `super(; }` | FAIL |

Python is meaningfully stronger — missing colons, malformed `def`, bad dedent, stray leading
indentation — and still passes English prose. JSON is a real parser and is correct.

**Refused: wiring `ts.createSourceFile`.** It would make the guarantee real, and `typescript` is
already a development dependency. It is refused on cost: promoting it to a *runtime* dependency
costs install size, and parsing costs latency against a lexer that runs in single-digit
milliseconds. That is a trade someone may want to revisit; it is not an oversight.

**Taken: say what is true.** `README.md` gains a per-language table and the sentence that the
guarantee on TypeScript — the family where compression actually runs — is **bracket and quote
integrity**, not syntax validity. `CLAUDE.md` says the same. `test/unit/validator-guarantee.test.ts`
pins every row as a characterization test, so the documented guarantee is executable: strengthen
a validator and the test fails on purpose, and the README table has to move with it.

Two consequences stated in the README rather than left implicit: a passing check is not a promise
the output compiles, only that it is no more unbalanced than the input; and real inputs are
frequently already invalid, which is why the sub-item check is *relative*.

### M11 — decided: retire the narratives and the root planning artifacts

Twelve files, **226 KB**, markdown from 31 files to 19. `docs/retired-documents.md` maps each to
where its conclusion lives and gives the `git show` command to read the original.

**The premise was stale, and measuring it first changed what the decision was about.** M11 was
filed as a **4.1 : 1** documentation-to-code ratio. Measured immediately before acting, it was
**1.40 : 1** — and the improvement was not real: markdown had *grown* to 726 KB, while `src/` grew
faster. Worse, **32.8% of `src/` is comment prose** (165 KB of 518 KB), so counting honestly,
prose ran about **2.6 : 1** against code. The volume had not gone anywhere; some of it had moved
into the source files.

That reframes the finding usefully. The problem M11 names is not bytes, it is **two copies of an
argument that have to be kept in sync by hand**. In-source commentary is not that — it sits next
to the code it describes and moves with it. Retired: the standalone narratives. Kept: every line
of the in-source commentary.

**Twenty-five source and test comments cite a retired document**, which is the check the option
called for and the thing that nearly made this a bad change. They are marked `[retired]` rather
than re-pointed: the citation names a document and section that existed and that git still holds,
whereas re-pointing 25 citations at DECISIONS sections by hand would risk mapping some of them to
the wrong place — trading a volume problem for a correctness one.

`CHANGELOG.md` and `DECISIONS.md` keep their older citations untouched, and each now carries a
note saying why. They are append-only records of what was true when written; editing them to
match today would falsify the history they exist to preserve. This entry is subject to the same
rule.

### What was not done

`cli/bench-table-renderer.ts:97` still prints a `risk` column sourced from `riskTolerance`, which
H4 established no stage reads. It is now the only reader of that field, and a benchmark column
implies the row's numbers depend on it. Small, real, and left alone here because changing what a
benchmark table reports is a measurement change, not a documentation one.

---

## 47. One Bad Item No Longer Reverts the Good Ones

Phase 1c — per-item repair. The audit's §3.1, and the binding constraint on multi-file value
since H5 made multi-item bundles reachable at all.

### The problem, measured

Validation is bundle-scoped and fallback was all-or-nothing. On the frozen 45-file Python corpus
at `targetReductionRatio: 0.3`:

```
stages achieved      42.52%
26 CONSTRAINT_DIRECTIVE_LOST errors across 14 items
drift                0.0359   (gate: 0.40)
AST                  clean
emitted               0.00%
```

Fourteen items reverted forty-five. The 61-file TypeScript bundle was the same shape with drift
additionally at 0.4122 — barely over the gate.

### What changed

Three pieces, in order of dependency.

**1. Attribution became data.** It already existed — as prose. `ValidationIssue` carried
`"…in item [<id>]…"` interpolated into `message`, and nothing else. That is unusable by anything
that has to *act* on it, and recovering it with a regex over the message would have been audit
M5b exactly: two places restating one format, drifting apart. `ValidationIssue.itemId` is now a
field, populated by the AST and constraint checks, which knew it all along.

**2. `validate()` says what it can and cannot attribute.** `FailureAttribution` carries
`repairableItemIds` and `hasUnattributableError`. The interesting case is drift, which splits:
`SEMANTIC_DRIFT_UNMEASURABLE` **is** attributable, because the measurement gate refuses specific
items and `unwitnessedItemIds` names them (§33); `SEMANTIC_DRIFT_EXCEEDED` is not, because `S_k`
is a set comparison over the whole bundle.

**3. The engine tries a repair before giving up.** Items named by errors are restored to their
pre-optimization content, the result goes back through the **same** `validate`, and it is adopted
only if it passes. Deliberately shaped like — and placed after — the automated-rehydration
attempt that was already there, because it is the same move: build a candidate, re-check it, keep
it only if the check agrees.

The load-bearing property: **repair changes which bundle is offered, never what counts as valid.**
Nothing here decides an item is acceptable. Validation still does, by the same standard, on the
same code path.

### The gate was tried too strict first, and measurement corrected it

The first rule was *"refuse if any error is unattributable."* It reads as the conservative choice
and it is the wrong one. The TypeScript bundle fails on both attributable constraint losses *and*
`SEMANTIC_DRIFT_EXCEEDED`; under that rule the drift failure, which names nothing, discarded the
constraint attribution, which names fourteen items. The run stayed at 0.00%.

The correct question is not *"is every error attributed?"* but *"is there a principled subset to
revert?"* Attempting the repair decides nothing — a drift score still over the gate simply fails
the re-validation and falls back. And reverting items *lowers semantic loss*, which is what drift
measures, so a drift failure is frequently a consequence of the same items:

```
                    before repair        after repair
python  drift       0.0359               0.0141
typescript  drift   0.4122               0.0056
```

What would be guessing is reverting a subset when **no** error names anything. That still
refuses, and `repairableItemIds` being empty is the condition.

### Result

| bundle | before | after | reverted | fallback |
|---|---|---|---|---|
| 45-file Python | 0.00% | **22.73%** | 14 of 45 | false |
| 61-file TypeScript | 0.00% | **19.47%** | 21 of 61 | false |

### What repair refuses to do, and why it matters

`revertFailingItems` returns `undefined` — declining the repair — in two cases.

**Nothing to revert.** No named item actually differs from its original, so the failure is not
about content this can restore.

**Everything would be reverted.** The result would be indistinguishable from the original bundle,
which is a full fallback wearing a different name. This is not a cosmetic distinction: the
fallback path echoes `request.rawInput`, and the CLI writes the original `Buffer`, whereas the
repair path renders from items. DECISIONS §35 exists precisely because those are not the same
bytes when the input is not valid UTF-8. Routing it as a fallback keeps that guarantee.

Measured: on 45 single-file Python runs, 14 fall back and **14 of 14 are byte-identical**, with
no run reporting `itemsReverted`. A one-item bundle can never be a partial success, and the code
says so rather than relying on it happening not to arise.

"Everything" accounts for pruning. A bundle whose surviving items were all reverted is still a
real reduction if the planner dropped items — selection is not elision, and that saving is not
what any of these checks objected to.

### One pass, not a loop

Repair runs once and re-validates once. A loop to fixpoint terminates — each pass reverts at
least one more item, and the limit is the full fallback — but it costs a whole-bundle AST pass
per iteration, so the worst case is O(n²) validations on exactly the bundles that need it most.
Measured, one pass sufficed on both corpora. A second round of attributable failures falls back
rather than iterating.

### Reporting

`trace.itemsReverted` names what was put back, and is present only on a partial success. Without
it the outcome is a reduction with `fallbackUsed: false` and no indication that anything was
restored — invariant 10's shape, a clean-looking result concealing what did not happen. It is
absent on a clean run and on a full fallback, and the engine omits it when `fallback.used`,
because on that path the decision had no effect on the output.

### Unchanged

**574 of 574 corpus rows are identical** to the pre-1c engine, same frozen corpus, varying only
`dist/`. That is the expected result and the point of checking: the harness measures single-file
runs, where repair cannot fire. Phase 1c adds value exactly where the audit said the value was
missing, and nowhere else.

A measurement caution that cost time here, and is now in the status doc: the TypeScript bucket
read 23.03% on the previous corpus and 19.76% on this one, which looks like a regression and is
not — the pre-1c engine reads 19.76% too. The corpus changed because this change edits `src/`,
and `src/` *is* the TypeScript bucket. Comparing two runs over two corpora is not a comparison.

---

## 48. The Dial Now Turns, and Says How Far It Can Turn

Audit H4's deferred half. When the three dead knobs were withdrawn (§44),
`--target-reduction-ratio` was kept and explicitly named as its own decision: the planner read it
only as `> 0` to choose knapsack mode over pass-through, and nothing else read it at all, so
`0.01` and `0.99` produced **byte-identical output**. It survived the cull because it is the flag
every document and example uses and making it real is a pipeline change rather than a flag change.

### Two things were broken, not one

**It never reached the machinery.** `pruning:topology-pruner` gated on `budget.maxInputTokens` and
returned early — *"maxInputTokens not specified in budget; topology pruning bypassed"* — whenever
only a ratio was set. That message is visible in the trace of every ratio-only run ever made,
including the 45-file Python bundle used throughout Phase 1c.

**It never stopped.** Compression ran to exhaustion and halted only when it ran out of candidates.
A single TypeScript file at `--target-reduction-ratio 0.3` produced **44.62%**, and later 69.09%
once other work made more regions eligible. Overshooting is not a bonus: every extra elision
spends semantic fidelity, raises drift, and on the CLI is irreversible because no `TokenHasher` is
wired in. Removing more than twice what the caller asked for is a defect.

### The mapping: proportional becomes absolute

`resolveTokenCeiling` (`src/core/budget/`) reads the ratio as a statement about the input —
"remove 30%" is "keep at most 70%" — and resolves it against the incoming bundle. Once absolute it
is an ordinary token ceiling, which is exactly what the pruner and the 0/1 knapsack already solve
against, so no new selection machinery was needed. **Both ceilings are caps, so the tighter wins:**
`maxInputTokens: 500` with `targetReductionRatio: 0.9` on a 10,000-token bundle means "at most 500"
and "at most 1,000", and honouring anything but the smaller violates a limit the caller set.

### Granularity is where this got interesting

The stop rule was first written between items, which is where the running total naturally lives.
Measured, it did nothing on the commonest CLI shape: `optimize one-file.ts` is a **single-item
bundle**, so the check runs once, before anything is elided, and the item then has all of its
regions removed in one call. `0.1`, `0.3`, `0.5` and `0.7` all produced **69.09%** on the same
file. **A ceiling has to bind at the granularity the compression happens at**, which is regions.

Then region *order* turned out to matter more than expected. Taking regions positionally still
overshot badly — 0.1, 0.2, 0.3 and 0.5 all produced **55.2%** — because regions are extremely
uneven. Measured across three of this repository's own sources:

| file | regions | each as % of file |
|---|---|---|
| `core/planner/index.ts` | 3 | **58%**, 9%, 9% |
| `core/engine/index.ts` | 5 | **61%**, 1%, 4%, 10%, 2% |
| `core/validation/index.ts` | 2 | **83%**, 4% |

Every file has one dominant region and it comes first positionally, so any modest target blew past
it on the first step. Selection is now **smallest-first when a ceiling is set**, which approaches
the ceiling in fine increments and reaches for the dominant region only when the target genuinely
requires it. Ties break on `start`, so the order is total and the stage stays deterministic
(invariant 1), and the kept regions are re-sorted **into positional order** before splicing because
`elideRegions` walks a forward cursor and refuses ranges that arrive out of order.

The cost is that one ratio's output is no longer a prefix of a larger ratio's. That property was
written into the first version of the comment and is worth less than hitting the number the caller
asked for.

### What it achieves, stated as a distribution rather than a claim

Frozen corpus, target 30%, 66 files that reduced:

| achieved | files |
|---|---|
| 0–10% | 2 |
| 10–25% | 7 |
| **25–35% (on target)** | **21** |
| 35–50% | 13 |
| **>50% (overshoot)** | **23** |

Mean achieved 43.9%. So the flag now binds — it is no longer a switch — but **adherence is
partial, and the limit is structural**: elision's smallest unit is one region, and 23 files have a
dominant region that cannot be taken in part. Closing that needs sub-region elision, which is not
attempted here and is recorded in `ROADMAP.md` as the work that would.
`test/unit/target-reduction-ratio.test.ts` pins this as a documented limit and deliberately does
**not** assert `achieved <= target` — that would assert a guarantee the implementation does not
make.

### The aggregate fell, and that is the feature

The harness measures at ratio 0.3, so this change makes the corpus figures move by design:

| bucket | before | after | reduced | fallbacks |
|---|---|---|---|---|
| python file | 23.14% | **20.26%** | 30 → **31** | 14 → **13** |
| typescript file | 23.03% | **17.57%** | rose | — |

Runs that used to overshoot to 44–69% now stop near 30%, so each contributing file contributes
less — **and more files survive validation**, because less aggressive elision means less drift.
Reduced counts rose and fallbacks fell in the same measurement that shows the mean falling.

This is the third time in this project that a headline aggregate moved for a reason that is not a
regression (§45's line endings, §46's corpus growth, this). The rule that keeps catching it:
**compare per-file rows over one frozen corpus, never the mean across two.**

---

## 49. A Release That Cannot Be Built Holds No Number, and a Check That Has Never Run Is Not a Check

**Date:** 2026-08-12 · **Status:** Accepted · **Closes:** the v1.3.0 numbering collision;
retires `npm run format`

Two decisions taken together because they are the same shape: a placeholder that reads as a
commitment. One is a version number reserved for work that cannot be done, the other a quality
gate that has never passed.

### The number

`--target-reduction-ratio` binding (§48) was merged and unreleased while `ROADMAP.md` reserved
**v1.3.0** for "Context Selection Quality & Redundancy Elimination" — a release whose two headline
deliverables were both measured unbuildable: BM25 has no query source anywhere in `src/`, and MMR
found **0 of 1,486** real pairs above its 0.90 threshold.

The options were to ship §48 as a patch, renumber the chain again, or take the number. **Taken —
and the reservation released rather than moved**, because moving it is what made this recur. The
identical collision happened at v1.2.0: this document had reserved that number for the same
Selection Quality release, the remediation work shipped into it, and the chain was renumbered one
release to the right. Doing that again would have set up the third occurrence.

**The rule: a release whose preconditions are measured false is described and gated, but holds no
version number.** It gets one when it becomes buildable. A number is a claim about sequence, and
reserving one for work that cannot start makes every shipped release route around it.

Minor rather than patch: nothing was removed, but the same command over the same input now emits
different bytes. `1.2.1` would have understated that; the CHANGELOG files it under `Changed`, not
`Fixed`, for the same reason.

### The check

`npm run format` was `prettier --check .`. It has **never passed**, and nothing has ever invoked
it — CI runs typecheck, lint, build and test; `prepublishOnly` runs the same four. Measured before
removing it, it failed on **148 files**: every markdown document and all 57 TypeScript sources.

Two independent causes, and separating them is what decided this:

| cause | size |
|---|---|
| prettier defaults to `endOfLine: "lf"`; the working tree is CRLF (`core.autocrlf=true`, no `.gitattributes`) | every file, whole-file diffs |
| genuine formatting drift underneath that | ~5,118 lines in `src/`, ~1,900 in the docs |

So this was never "the markdown is unformatted". Making the script pass would have rewritten the
whole repository — including the in-source commentary that is **32.8%** of `src/` and, per
`CLAUDE.md`, is deliberately maintained next to the code it explains rather than in the documents
M11 retired. A formatter with `proseWrap: preserve` would not reflow that prose, but it would
still touch every line of every file it lives in, and the blame trail is part of how this project
reconstructs why a measurement was taken.

**Removed rather than fixed or ignored**, which is audit H4's principle applied to a dev script
instead of a CLI flag. H4 withdrew three flags that were parsed, validated and read by nothing, on
the grounds that a dial reporting success without doing anything is worse than no dial. A check
that has never run is the same object: it is not evidence, and leaving it red is worse than
deleting it, because a permanently-red instrument teaches everyone to skip the one that goes red
for a reason. That is invariant 10 read from the other end — this project has been bitten **ten**
times by a green result from a check that never executed, and a red result nobody reads is the
same failure wearing the opposite colour.

`eslint` remains the enforced gate and is green **without** `eslint-config-prettier`, which was
verified rather than assumed before removing it: it existed only to switch off rules that would
conflict with a formatter that is no longer here.

### Found while bumping the version

`package-lock.json` carried `"license": "MIT"` and `"version": "1.1.0"`. Audit **M3** corrected
the license in `package.json` — npm reads that file, so nothing was published wrongly — but the
lockfile mirror was never regenerated, and a file in this repository went on asserting the
pre-M3 license for two releases. M3 was itself a defect about **a stale second copy of one fact**,
which is the same failure M5b's marker formats had and the same one this entry's `format` script
had. Regenerated with the bump.

---

## 50. A Statement Is a Smaller Thing Than a Function Body

**Date:** 2026-08-12 · **Status:** Accepted · **Follows:** §48

§48 made `--target-reduction-ratio` bind and recorded that adherence was **partial, and the limit
structural**: elision's smallest unit was one region, files typically have one dominant region
(58%, 61%, 83% measured), and a body cannot be taken in part. At target 0.3, 23 of 66 reducing
files still exceeded 50%. This divides the region.

### The precondition was measured before the feature was written

The two deliverables this project has cancelled — BM25 and MMR — were cancelled because their
preconditions failed when measured, after the specs were written. So the question here was asked
first: **do dominant regions decompose at all?** A body that is one indivisible block gains
nothing from finer granularity.

| bucket | files | dominant >50% of file | median sub-spans | indivisible |
|---|---|---|---|---|
| python | 44 | 5 | 9 | **0** |
| typescript | 55 | 22 | 9 | **1** |

Dominant regions divide into ~9 pieces. The precondition holds.

### The instrument was wrong first, and the corpus is what said so

The first probe reported **1 sub-span covering 100% of the dominant region for 44 of 44 Python
files** — a result too uniform to be real. `scanPythonDefBodies` returns a region starting *after*
the first body line's indentation, so region text is dedented on line 1 and fully indented
afterwards; taking the minimum indent across all lines yields 0 and matches only line 1.

The probe's self-test passed, because its fixture began with a newline and therefore did not have
the shape the scanner emits. **A validated instrument is only validated against the inputs it was
shown.** The production splitter carries the same warning, and every Python fixture in
`test/unit/sub-region-elision.test.ts` starts mid-line for this reason.

### What a span may be

Depth-0 boundaries only, so every span is bracket- and quote-balanced: a `;` at depth 0 or the
`}` returning depth to 0 for TypeScript, a line at base indentation with no bracket open and no
triple-quoted string in progress for Python. A nested `if` block is one span, not several.
`elideRegions` would refuse an unbalanced span rather than ship it — but a refusal is a 0% run,
and adherence is the point.

Python spans start after the line's indentation, inheriting `scanPythonDefBodies`' boundary: the
marker must hold the body's column or `PythonValidator` reports `AST_INDENTATION_ERROR`, and the
indentation must stay outside the replaced bytes or rehydration is not byte-identical.
`isSubstantiveRegion` runs **per span**, because a body can be substantive overall while one
statement is nothing but a docstring — eliding that span alone is `HumanEval/0` at finer grain.

### Confined to the ceiling path, which is what makes the A/B mean anything

With no ceiling the stage still takes regions whole: one marker per body rather than nine, and
nothing is asking for a figure. 522 of 576 corpus rows come out byte-identical, and every changed
row is TypeScript or Python under a ceiling.

### The guard, and the trade it resolves

Statements below the marker floor are dropped. In a body of many short lines that can be nearly
all of them, leaving the caller only the survivors and no way to reach for the region as a whole:
one file went **38.9% → 6.6%** against a 30% target. Undershooting by 23 points is not an
improvement on overshooting by 9. A division now stands only if what survives still covers most
of its region.

The threshold was swept, and the sweep is in the source because it shows a trade rather than an
optimum:

| coverage | rows >50% | new fallbacks | fallbacks fixed | closer to 0.3 | further |
|---|---|---|---|---|---|
| 0.25 (≈ no guard) | **8** | 2 | 9 | 48 | 23 |
| 0.50 | 12 | 2 | 4 | 44 | 21 |
| **0.75** | 18 | **0** | 4 | 39 | **11** |
| 0.90 | 33 | 0 | 5 | 13 | 3 |

Aggressive division controls overshoot best — 8 rows above 50% against a baseline of 34 — but
converts **two rows that were reducing into fallbacks**. The cause is not the splitter: a finer
span is likelier to contain a comment carrying an imperative, `cleanup:constraint-preservation`
refuses to lose one, and on a single-item bundle Phase 1c has no other item to keep, so the
refusal is a whole-file fallback. `pip/_internal/commands/cache.py` goes 34.1% → 0% on a comment
reading *"normalized to underscores (_), meaning hyphens can never occur"*.

**0.75 was chosen because it regresses nothing** — 0 new fallbacks, 0 files that stopped
reducing, >50% still nearly halved. Buying a better headline with two working files is the trade
this project keeps having to un-make. Revisit on multi-item bundles, where that constraint
failure names its item and Phase 1c reverts only that one.

### Final position

576 rows, both routes, target 0.3, against the pre-division engine at the same frozen corpus:

| | baseline | after |
|---|---|---|
| rows above 50% | 34 | **18** |
| rows reducing | 95 | **99** |
| new fallbacks / lost reductions | — | **0 / 0** |
| closer to target / further | — | **39 / 11** |

Still open: 18 rows exceed 50% because a single *statement* is itself dominant — one 83%-of-file
span in `python-validator.ts`. Dividing that needs elision inside a control-flow block, which is
a different question from dividing a body and is not attempted here.

---

## 51. Per-Item Drift Has Nothing to Attribute, Because §48 and §50 Closed It

**Date:** 2026-08-12 · **Status:** Accepted · **Closes:** the per-item drift item, without
implementing it

Phase 1c (§47) made validation failures repairable per item and recorded one axis as unfinished:

> Still open on this axis: drift remains a bundle-scoped score. It is *repairable in practice*
> (reverting items lowers it — 0.4122 → 0.0056 on TypeScript) but it never names an item itself,
> so a bundle failing on drift alone still falls back whole.

That was true when written. **It is no longer reachable**, and the two releases since are why.

### The measurement

Frozen corpus, 288 files, file route, target 0.3. Every fallback classified by its actual
`fallbackReason`:

| cause | count | already attributable? |
|---|---|---|
| `CONSTRAINT_DIRECTIVE_LOST` | 29 | **yes** — per item, §47 |
| `SEMANTIC_DRIFT_UNMEASURABLE` | 87 | **yes** — `unwitnessedItemIds`, §33 |
| input not valid UTF-8 | 1 | correct, and unrelated (§35) |
| **`SEMANTIC_DRIFT_EXCEEDED`** | **0** | — the only code that is not |

`SEMANTIC_DRIFT_EXCEEDED` is the sole drift failure per-item attribution would help, and it does
not occur. On multi-item bundles — `src/core` (33 items), `src/stages`, `src/gateway`,
`src/adapters`, pip's 45 Python files, this repository's 62 TypeScript sources — `S_k` measures
**0.0024 to 0.0056** against a threshold of **0.40**, and does not move at ratios 0.3, 0.5, 0.7
or 0.9. It is roughly two orders of magnitude under the gate.

### Why the premise expired

§47's `0.4122` was measured on an engine that elided everything it could. §48 gave the stage a
token ceiling to stop at, and §50 made the unit it removes a statement rather than a whole
function body. Together they cut symbol loss so far that the drift gate no longer binds:
the number that motivated this work is a property of a pipeline that has since been changed
twice. **An open item is a claim about the current build, and it expires like any other.**

### The mechanism is real, and reachable only by asking for it

At `--max-drift 0.001` — four hundred times stricter than the default — the failure does fire,
and behaves exactly as §47 predicted: drift names no item, so `hasUnattributableError` is set,
repair is declined, and **7 items that would otherwise have been reverted were not**. The bundle
fell back whole, and the reported reason was the *constraint* failure the repair would have
fixed.

So the design note is correct about what would happen. What is absent is any default-configured
input on which it happens. Building it would be ~1,000 lines with no observable effect on output
the product can currently emit — the H5 condition, and the same reason BM25 and MMR were not
built (§ROADMAP). The difference worth recording is that this item was not wrong when written;
it was **closed by other work and nobody re-measured it.**

### What would make it live again

Any change that raises symbol loss back above the gate on a default run: whole-item elision of
symbol-bearing content becoming possible again (§43 refuses it), a much more aggressive default
ratio, or a language whose symbol extraction is sparse enough that modest elision destroys most
of the set. **Re-measure before implementing — the check is the table above, and it takes one
corpus run.**

The constraint gate is where the fallbacks actually are: 29 of 29 code-bucket fallbacks, and
§50 measured it as the reason the better sub-region setting costs two files. That is the
per-item axis with something on it.

---

## 52. A Comment Is Where a Codebase Narrates Itself, Not Only Where It Instructs

**Date:** 2026-08-12 · **Status:** Accepted · **Follows:** §42 (H6), §51

§51 measured where the fallbacks actually are: **29 of 29** code-bucket fallbacks on the frozen
corpus are `CONSTRAINT_DIRECTIVE_LOST`. Not drift, not AST — the constraint gate, every time.

§42 scoped that gate by **region**: an instruction to a reader lives in a comment or a docstring,
never in an expression, which stopped it firing on `logger.critical(exc)` and `readonly required?`.
This scopes it by **mood** within that region, because a comment is also where a codebase explains
its own history.

### What the gate was refusing

Inspecting the matched text behind those 29 fallbacks, roughly twelve read like this:

> "The MCP branch of `runCli` **has always** read these two"
> "It **never did**: this branch bypassed pruning entirely"
> "`HTTP_PROXY` and `HTTPS_PROXY` … could **never have worked**"
> "a saving that **never reached** the wire (audit C4)"

Losing one of those costs a reader some history. Losing *"never hash items matching
preserveKinds"* costs a caller a rule. The keyword is identical and the gate refused the whole
file for either.

### Narrowed in the safe direction, three ways

This gate protects content, so unlike §48 and §50 — where a wrong call costs output size — a
wrong call here **silently deletes an instruction**. Three deliberate limits:

1. **Only `never` and `always`.** They are the two keywords equally comfortable describing and
   instructing. `must`, `must not`, `do not`, `required`, `critical`, `only if`, `except when`
   and `make sure to` are untouched — *"must have been called before"* is a requirement about a
   past state, and a perfect-tense test applied to `must` would drop it.
2. **Only perfect or past constructions**, which are provable from the words present: a preceding
   `have`/`has`/`had`, or a following past-tense verb. *"is always deterministic"* and *"do not
   support"* are descriptive too, and are **left firing on purpose** — there the line between
   describing a constraint and stating one is genuinely blurry. Under-narrowing costs reduction;
   over-narrowing costs content.
3. **Unanimity before dropping.** A segment is discarded only if *every* keyword in it is
   narrative-capable and the construction is narrative. *"this has always been true, so you must
   call it first"* still raises a directive, because of the `must`.

### The negative control is the load-bearing test

`test/unit/narrative-directive-scope.test.ts` asserts the eight narrative sentences above stop
firing — and, more importantly, that **sixteen real instructions still do**, several taken
verbatim from this repository. A rule that drops one of those is not a better rule at any
reduction figure, and the test says so rather than leaving it to a reduction number two layers
away.

### Measured

Per-row over the frozen corpus, 576 rows, both routes, target 0.3, against v1.4.0:

| | before | after |
|---|---|---|
| rows byte-identical | — | **572 of 576** |
| fallbacks fixed / new | — | **4 / 0** |
| rows newly reducing / stopped | — | **4 / 0** |
| rows already reducing that changed at all | — | **0** |

The four are `adapters/mcp/tools.ts`, `cli/main.ts`, `gateway/exec.ts` and `gateway/proxy.ts` —
`gateway/exec.ts` being the file that contains *"could never have worked"*. TypeScript file
route: 39 reduced / 16 fallbacks → **43 / 12**, aggregate 18.52% → 24.58%.

### The caveat that matters more than the headline

**Python gained nothing — 0 of the 4.** Every recovered file is this repository's own source,
and this repository is unusually narrative: M11 measured **32.8%** of `src/` as comment prose,
written in a style that explains what used to be true. pip's comments describe behaviour in the
present tense and were never caught by this rule.

So the 6pp on the TypeScript bucket is **not** a portable estimate of what other codebases gain.
It is the corpus-bias trap `CLAUDE.md` warns about, showing up as a favourable number instead of
an unfavourable one — which is the harder direction to notice. What is portable is the shape:
zero regressions, and four files that produced nothing now produce something.

---

## 53. The Roadmap Stops Reserving Version Numbers

**Date:** 2026-08-12 · **Status:** Accepted · **Generalises:** §49

§49 ruled that **a release whose preconditions are measured false holds no version number**. That
handled v1.2.0's collision and v1.3.0's and v1.4.0's, because in each case the reserved slot held
work that could not be built.

**v1.5.0 is the fourth collision and the rule does not cover it.** "Granular Sub-Query
Re-hydration & MCP Tool Extension" is *buildable* — its blocker (M5b, a rehydration regex that
could never match the emitted marker) shipped in Wave 2, and what remains is design work on the
response shape. Its preconditions hold. It simply has not been built, while §52 has been.

So the narrower rule would have forced either an arbitrary version, a patch number for a change
that alters emitted bytes, or renumbering the chain — which is precisely the move §49 identified
as the cause of the recurrence.

### The general rule

**A version number is a fact about what shipped, assigned at ship time. The roadmap describes
releases by name and by gate, and reserves no numbers at all.**

Four collisions in four releases is the evidence. A reserved number is a prediction about the
order in which work will finish, made at the time of least information, and this project has been
wrong about that order every single time — twice because the reserved work turned out to be
unbuildable, once because remediation grew into a release of its own, and now once because a
smaller change simply finished first.

The unshipped sections keep their names, their scope and their measured gates. What they lose is
the number, which was never doing work that a name could not.

`v2.0.0` is retained as written, because a major version communicates *breaking change* rather
than *position in a queue* — it is a statement about compatibility, which is a real property of
the work it describes. If it ships as `v1.9.0` because nothing in it broke compatibility after
all, that is the same correction this entry is making, and it costs a line in `CHANGELOG.md`.

### Why this is worth an entry rather than a silent edit

The failure this prevents is not a mis-numbered release; it is the **half hour each time** spent
deciding whether taking the next number is legitimate, and the risk of resolving it by shifting
the chain and setting up the next collision. Recording the rule ends the question.

---

## 54. The Gateway Forwards the Caller's Bytes, and Measures Them

**Date:** 2026-08-12 · **Status:** Accepted · **Closes:** max_audit.md M7 — the last open finding

M7 said Gateway savings are computed from `summary.tokenEstimate`, a property of the bundle
*render*, while what leaves the process is `JSON.stringify({...parsedPayload, messages})`. It
listed three consequences. Measured before fixing, all three were live, and they are not the same
defect — the status doc's §6 warned that the re-serialization half is not a metrics bug, and that
turned out to be the important half.

### What re-serialization was doing

One elision firing on a hand-written payload — the only shape the Gateway saves on at all:

| client sent | provider received |
|---|---|
| `"temperature": 1.0` | `"temperature":1` |
| `"top_p": 1e3` | `"top_p":1000` |
| `"seed": 12345678901234567890` | `"seed":12345678901234567000` |

The first two are cosmetic. **The third is a different number.** An integer past 2^53 does not
survive `JSON.parse` → `JSON.stringify`, so a provider was being asked for a seed the caller never
chose, by a proxy whose entire promise is faithfulness. Duplicate keys collapse the same way.

This is the mechanism the project already identified as the phantom `-1.39%` in the Python
benchmark harness (Issue 5), reproduced in production code — found there by measuring, and found
here the same way.

### The fix is a splice, not a smaller re-serialization

Elided content is written **into the caller's own bytes**: each message's content is located by
the canonical JSON encoding of the text the parser produced, searched forward from the previous
message's end, and only that span is replaced. Every other byte is the caller's.

**The forward cursor is the whole design.** A first version searched globally and refused
ambiguous matches, which declined **every** payload the Gateway can save on — `session-dedup`
preserves the first copy of a block and elides the later ones, so the encoded text appears more
than once *by construction*. Walking every message in order, replaced or not, keeps position and
identity in agreement. That version's tests passed, because with the splice declining, nothing
changed and every assertion held.

Where the caller's escaping differs from ours the text is equal after parsing but absent from the
raw bytes; there the splice **declines** and the original body is forwarded. Invariant 3's
direction: a lost saving costs tokens, a corrupted field costs correctness, and only one of those
is recoverable by the caller. The same rule refuses any spliced body that is not smaller than the
one that arrived — M7's third consequence, which nothing had ever asserted.

### The metrics were the mild half

Reported against measured, on that same payload: **48.5% claimed, 47.1% on the wire.** Directionally
right and about 1.4pp optimistic — the gap being JSON structural overhead, which the render never
sees and the provider always bills. After pointing the estimate at the forwarded body: **46.3%
against 46.5%.**

Still counted in **tokens**, still through `estimateBundleTokens`. A saving denominated in bytes
and compared against a budget denominated in tokens is precisely the two-estimator defect §19
exists to prevent; what changed is the artefact measured, not the unit.

### The test file was green before it was right

`test/integration/gateway-wire-metrics.test.ts` passed on its first run — 4520 bytes in, 4520 out,
`tokensSaved: 0`. `cleanup:session-dedup` elides a block only once a previous turn has registered
its hash, so a single-turn fixture elides nothing and every assertion holds vacuously. Each test
now asserts the elision fired *before* asserting anything about it, and the file says why.

That is the tenth instance of this project's oldest failure and the second in two sessions: a
green result from a check that never ran. It is worth noticing that both recent instances were in
**new tests written to prove a fix**, which is the moment the temptation to believe a pass is
highest.

### M7 was the last open audit finding

`max_audit.md` is now closed in full. It was gated behind *"only if question B keeps the Gateway"*,
B was answered in §41, and nothing carried it across — recorded in §6 of the status doc rather
than quietly fixed, because the way an item disappears matters more than the item.

---

## 55. The LOW Table Was Never Scheduled, Which Is §54's Failure Mode One Band Down

**Date:** 2026-08-15 · **Status:** accepted · **Scope:** `max_audit.md` L1, L4–L9

§54 closed M7 and recorded *why it went missing*: it sat behind a conditional, the conditional
was resolved, and nothing carried it across, so it entered no wave table. The status doc named
the general rule — **an item that is in no table reads as done, exactly like a check that never
ran reads as a pass** — and then the audit was declared closed in full.

It was not. `max_audit.md` §2 ends with a nine-row LOW table. Waves 0–3, the three decisions and
the unscheduled-M7 row account for every CRITICAL, HIGH and MEDIUM finding. **No wave, no
decision and no status-doc row has ever mentioned L1, L4, L5, L6, L7, L8 or L9.** L2 and L3 are
closed, incidentally, by the C2 `Buffer` work — which is the tell: the two that got fixed are the
two that happened to sit inside someone else's diff.

Re-verified against source 2026-08-15. All seven were open.

### What each one turned out to be

| # | Verified | Disposition |
|---|---|---|
| L1 | open | fixed — env enum values are rejected, not dropped |
| L4 | open, premise wrong | recorded at the site; unreachable, and changing it churns every pinned id |
| L5 | open as documentation | doc corrected; the minimum is right and is kept |
| L6 | open | comment corrected — it is not branch-and-bound |
| L7 | open, **and costlier than rated** | fixed |
| L8 | open | fixed |
| L9 | open as documentation | doc corrected; not widened, because the failure is already safe |

### L7 was rated too low, and the rating is the interesting part

The audit says `scanPythonDefBodies` "fails safe (skip) but silently loses the region" — true,
and it reads like the cost is one region. Measured end-to-end it is the whole file, because a
one-region file has nothing else to elide. Two functions differing only by a blank line after
the `def`:

```
normal.py       434 bytes -> 96 bytes   (77.9%)
blank_first.py  436 bytes -> 436 bytes  (0%, fallback)
```

The `last` scan in that function already skipped blank lines when finding the body's end. Only
the line that reads the body *indent* did not, so the two disagreed about where the body starts.
`indentOf('')` is 0, the region began at column 0, the marker inherited column 0,
`PythonValidator` reported `AST_INDENTATION_ERROR`, and `elideRegions` skipped it as
`post_condition_rejected`.

**The corpus cannot see this fix, and that is a fact about the corpus.** Per-row over the frozen
288-file corpus, **576 of 576 rows are byte-identical** across all fifteen compared fields. The
reason is not that the fix is inert: **0 of 45** Python corpus files contain a blank line directly
after a `def` — pip internals and this repository's own Python are uniformly PEP 8 in that spot.
A real gain that the measurement instrument is structurally blind to is the mirror image of §52's
caveat, where a favourable number came from corpus bias. Same lesson, opposite sign.

### L4's premise does not hold, and that changed the disposition

L4 says that after `cleanup:constraint-preservation` an item's `contentHash` "is no longer a hash
of `item.content`", implying it was one before. On the route that reaches this stage it never
was: `createContextBundle` hashes `{source, sourcePath, content, kind, contentType, metadata,
language}` — a provenance hash — and sets `id` to it. Only `createContextItem`'s default is
content-only.

The narrower defect is real: `hashContent({ ...item, metadata })` folds the *previous* hash in,
so the value is chained and two items identical in every field hash differently on different
histories. It is not changed, because it is unreachable and the change is not free. The one
consumer treating this hash as a content identity is `cleanup:session-dedup`, which keys
cross-turn dedup on it — and that stage runs only under `session_dedup` planner mode, where this
stage is not planned. The knapsack list that plans this stage never plans that one. Changing it
moves `bundle.contentHash` and every pinned id in the suite while moving no output byte.

Recorded at the site with the condition that would make it live: planning both stages in one
list, or any new consumer comparing this hash across a bundle boundary.

### L1 is §30 arriving by the other door

`TOKENDAMPER_PLANNER_MODE=session_dedup` was silently discarded while `--planner-mode
session_dedup` threw. `session_dedup` is a real member of `OptimizationMode`, so it is the worst
shape of the defect — a user has every reason to think it took effect.

§30 established that a flag the command does not consume is a parse error naming where it *does*
apply, because a setting that reports success and changes nothing is worse than one that fails.
An environment variable is the same setting arriving by a different door. All four enum parsers
now reject through one helper rather than one being fixed and three keeping the trap; the
accepted sets are unchanged, and widening `defaultMode` past `pass_through` is left as the
separate question it is.

### Method note

Every fixed case was run against the unfixed engine first: **5 of 7 assertions fail there**, and
the 2 that pass are the negative controls — the no-blank-line region and the still-accepted
environment values — which must pass both ways or they are testing nothing.

`test/unit/audit-low-findings.test.ts`. L4, L5 and L9 are deliberately not pinned there; a test
asserting current behaviour that this entry argues is *acceptable rather than correct* would be a
hazard-pinning test without the hazard.

---

## 56. Go Has the Material, and the Sequencing Warning Was Wrong in the Dangerous Direction

**Date:** 2026-08-15 · **Status:** accepted · **Scope:** precondition check for widening elision

Widening elision beyond TypeScript/JavaScript/Python is the one roadmap item whose preconditions
still hold. Before writing any of it, two things were measured: **how much material a real Go
corpus actually offers**, and **what happens to the safety gates if the region scanner ships
first**. The second turned out to matter more.

### The gates, measured

`selectValidator` returns `null` for Go, C, Java and Rust, so `regionElisionLanguage` is
`undefined` and `selectElisionRegions` returns `[]`. That much was known. What was not:
`extractSymbols` yields **no function symbols at all** for any of them. Probed on one file per
language, the only symbols harvested were incidental matches by the TypeScript regexes —
`type:Point` (because `struct` is an alternative in the class regex) and `import:fmt`.
`computeTotal`, `renderReport` and `do_work` are invisible.

Simulating what a region scanner would produce — signatures kept, bodies replaced, `item.id`
preserved the way real stages preserve it:

| case | symbolsBefore | S_k | astMeasured | measurementGate | fallback |
|---|---|---|---|---|---|
| Go **with** `struct`/`import` | `type:Point, import:fmt` | 0.0000 | **true** | **pass** | **false** |
| Go **without** either | *(none)* | 0.0000 | false | refuse | true |
| C without a struct | *(none)* | 0.0000 | false | refuse | true |

**`ROADMAP.md` and §7 of the status doc both said: add the scanner alone and §33's measurement
gate refuses the item, converting a 0% into a fallback. That is the bottom two rows only.** Real
Go, C, Java and Rust source nearly always carries a struct, class or import, and those manufacture
a symbol that body elision **cannot destroy**, because signatures are retained by construction. So
the gate reports `astMeasured: true`, scores perfect retention, and passes — having tracked
nothing the transform could break. Every function body in the file could be deleted and `S_k`
stays `0.0000`.

**This is C1's shape one step over, and §33 does not cover it.** §33 closed *"the before-set is
empty, so `R_AST` defaults to 1.0"*. This is the sibling: the before-set is **non-empty but
structurally incapable of registering the loss**. §33's gate asks *did evidence exist?*, not *was
the evidence capable of witnessing this transform?* Shipping the scanner first therefore produces
silent unmeasured elision rather than a visible zero — the worse of the two failures, and the one
the docs promised could not happen.

**Order, for that reason:** `extractSymbols` first, then the validator, then
`REGION_ELISION_LANGUAGES` plus the scanner. Step 1 alone is also a free negative control —
reduction must stay 0% everywhere, while drift on a hand-elided file becomes non-zero.

### The material, measured

Ceiling = share of bytes inside `func` bodies clearing the shipped filters (`MIN_REGION_BYTES`
104, `isSubstantiveRegion`), using `scanBraceSpans`'s between-brace boundary. TypeScript and
Python are measured with the **shipped** `selectElisionRegions` over the frozen corpus.

| corpus | files | ceiling, non-test | ceiling, all | median/file | no region |
|---|---|---|---|---|---|
| Go — app (`cli/cli`, `cobra`, `gin`) | 1,028 | **65.36%** | 81.44% | 63.3% | 9.5% |
| Go — stdlib (`golang/go` `src/`) | 5,387 | **54.78%** | 59.81% | 39.5% | 28.2% |
| TypeScript — this repo | 62 | 57.78% | — | 58.6% | 11.3% |
| Python — pip | 45 | 46.88% | — | 53.8% | 2.2% |

TypeScript converts a 57.78% ceiling into **24.56%** achieved at target 0.3. On that conversion Go
lands at roughly **23–28%** — around or above the product's best language. **The precondition
holds.**

### The cross-check moved the number, which is why it was run

App-only read 65.36%; the stdlib pulled it to 54.78%. The cause was checked rather than averaged:
**21.7% of stdlib source bytes sit in files with no elidable region**, dominated by machine-
generated tables the `DO NOT EDIT` filter missed — `cmd/compile/internal/ssa/opGen.go` alone is
3.99 MB, `p256_table.go` 523 KB — plus a long tail of tiny files (median no-region file: 659
bytes). That content is atypical of what a coding assistant is pointed at. **The honest range is
55–65%, not 65%**, and §52's caveat is why a single corpus was not trusted.

### Two findings worth more than the headline

**Test files are the larger prize.** In the app corpus `_test.go` is 53 MB against 36 MB of
source — more bytes than the code — at **92.22%** elidable body with 0.7% having no region. Go's
table-driven test convention puts large literal slices inside function bodies. If Go elision
ships, tests are where most of the saving comes from, and nothing in this project has been
counting them.

**The ceiling is not the constraint; the gates are.** Measured on the frozen corpus, target 0.9
gives TypeScript **21.37%** with 25 files unchanged, against **24.56%** with 12 unchanged at
target 0.3. Pushing harder trips the constraint and drift gates and converts reducing files into
fallbacks — §48's finding reproduced, and it bounds what Go can realise regardless of how much
material it has.

### What this does not establish

The 23–28% projection borrows TypeScript's conversion factor, which embeds **TypeScript's**
fallback rate. **Go's fallback rate cannot be measured until the validator and `extractSymbols`
exist**, because both gates are language-dependent — the same ordering argument, now with a
number attached to why it is worth doing. Go's much lower comment density than this repo's TS
(M11 measured 32.8% comment prose) should make `CONSTRAINT_DIRECTIVE_LOST` fire less, which would
push the figure up; that is an expectation, not a measurement.

The instrument was validated before the result was believed — 12/12 cases including raw-string
literals, both comment forms, interface methods with no body, and closures counted once — because
a scanner that silently misses bodies would understate the ceiling and kill the feature on a
false negative.

---

## 57. A File That Documents the Placeholder Format Is Not a Corrupted Placeholder

**Date:** 2026-08-16 · **Status:** accepted · **Scope:** `detectCorruptedPlaceholders`

`src/core/elision/regions.ts` reduces **29.60%** on the CLI and fell back to **0%** on MCP. Same
file, same ratio, same engine. The trace named the reason:

```
fallbackReason: "Block hash corruption detected: missing block hash [` + 64 hex + `] in token hasher."
```

That is not a hash. It is prose from `regions.ts:17` — *fixed width of `` `<BLOCK_HASH:` `` + 64
hex + `` `>` ``* — the line describing the format the placeholder used to have.

### The defect

```js
new RegExp(`${ELISION_MARKER_PATTERN.source}|<BLOCK_HASH:([^>]+)>`, 'g')
```

Two alternatives in one regex with different strictness. `ELISION_MARKER_PATTERN` requires
`sha256:([a-f0-9]{12,64})`; the legacy alternative accepted `([^>]+)` — anything up to the next
`>`. So it matched from a backtick-quoted `<BLOCK_HASH:` through to a later `>`, captured
`` ` + 64 hex + ` `` as a hash, found it absent from the store, and failed the entire run.

`createBlockPlaceholder` emits `<BLOCK_HASH:${hashContent(...)}>` — a sha256 digest — so
requiring hex removes every prose match at no cost to real detection. The bound now matches the
pattern beside it.

**Blast radius: 22 files in this repository** carry a `<BLOCK_HASH:…>`-shaped string, including
`marker.ts`, `token-hasher.ts`, `token-hashing.ts`, `ARCHITECTURE.md` and `CHANGELOG.md`. Every
one was unoptimizable over MCP, as is any user documentation quoting the legacy format.

### Why no measurement could see it

The check opens `if (!hasher) return []`. **The CLI supplies no `TokenHasher`** — deliberate, and
correct: with no store nothing claims to hold the content, so nothing can be missing. MCP supplies
one at `tools.ts:236`.

`tools/corpus-harness` drives the CLI. **Every corpus number in this project was measured on the
one route where this check is disabled**, so the instrument was structurally blind to it. The
per-row A/B confirms that from the other side: **576 of 576 rows byte-identical** across all
fifteen fields after the fix, because the CLI route never ran the check either before or after.

That is a new shape of §56's caution. There, byte-identical meant *the corpus lacks the shape*.
Here it means *the harness cannot reach the gate*. Both read as "no effect" and neither is.

### It is §52's defect in a second gate

§52 stopped `CONSTRAINT_DIRECTIVE_LOST` refusing a file for its own narrative comments. This is
the block-hash integrity gate refusing a file for **describing the mechanism that processes it** —
and `regions.ts`, the file that defines region elision, was the one it refused.

Two gates have now made the same mistake. Any check that scans emitted content for the product's
own markers is a candidate for the third; the discriminator is that a marker has a *shape*, and
matching on the prefix alone is not enough.

### Measured

| | before | after |
|---|---|---|
| `regions.ts` over MCP | 0.00%, fallback | **32.00%** |
| `token-hasher.ts` over MCP | fallback | **35.28%** |
| minimal file + one `<BLOCK_HASH:…>` comment | 0.00%, fallback | **81.6%** |
| CLI corpus, 576 rows | — | **576/576 byte-identical** |

`test/unit/block-hash-false-positive.test.ts` — 6 of 8 assertions fail against the unfixed engine.
The 2 that pass are the negative controls, and they are the point: a genuine 64-hex placeholder
absent from the store is **still** reported as corruption, and one the hasher knows still
resolves. Narrowing a detector must not cost the detection.

### Provenance

Found by adding `tokendamper mcp` to `.mcp.json` and pointing it at this repository's own source —
the first non-trivial thing tried. M5a and M5b were also MCP-adapter defects that a full unit
suite did not catch. Three findings on that adapter now share a cause: it is the entry mode with
the least end-to-end exercise, not the least tested one.

---

## 58. Docstrings Are Where a Function's Why Survives Elision, So Keeping Them Is a Flag

**Date:** 2026-08-16 · **Status:** accepted · **Scope:** `--keep-docstrings`, Python only

The retention test (an agent answering questions about a codebase it can only see through the
optimizer) found that **3 of the 4** questions the compressed version could not answer lived in
docstrings that body elision had removed — the *why* of a function, not its shape. That pointed
at keeping docstrings. Measured before building, it is a trade rather than a free win, which is
why it ships as an opt-in flag with the default unchanged.

### The measurement

Ceiling = the share of currently-elided body tokens that the leading docstring represents,
measured with real `cl100k_base` over the elidable def bodies of two corpora:

| corpus | bodies with a docstring | tokens given back if kept |
|---|---|---|
| 45-file pip (real third-party) | 42.8% | **14.2%** of the saving |
| expense-analyzer (doc-heavy) | 100% | **21.1%** of the saving |

End-to-end on the doc-heavy project, per-file at target 0.3: **33.4% -> 27.5%** saved, and
docstrings preserved went 26 -> 51. That 5.9pp is the trade, live.

**So it cannot be the default.** On doc-heavy source it gives back a fifth of the win, and the
default path being byte-identical is load-bearing here — the corpus A/B and every published
number depend on it. It is a retention dial the caller opts into.

### The seam, and why it avoids the frozen model

`--keep-docstrings` threads as a *runtime option*, never as a budget field:
`SelectRegionsOptions.keepDocstrings` -> `TokenHashingStageOptions` -> `EngineOptimizationOptions`
-> the CLI flag. `OptimizationBudget` is pinned frozen by `ARCHITECTURE.md` (the H4 disposition),
and this needed nothing from it — it is a transform option like `tokenHasher`, not a budget.

One engine change was required beyond threading: `tokenHashingOptions` was built only when a
`tokenHasher` was present, and the CLI supplies none. Left alone, the flag would have been
silently dropped on the exact route that uses it — the §57 shape again. The context is now built
whenever *either* the hasher or `keepDocstrings` is set.

### Where the region actually changes

Only `scanPythonDefBodies` consults the flag: it advances the region start past a leading
docstring (a `"""..."""` triple-quote, single-line or multi-line, or a single-quoted one-liner)
and any blank lines after it. `splitRegionIntoStatements` never sees the docstring because it
operates *within* the already-narrowed region. If the docstring is the whole substantive body,
the region collapses and `MIN_REGION_BYTES` drops it — correct, since there is no code left to
remove.

**TypeScript and JavaScript are unaffected by construction**, and that is asserted, not assumed:
their doc comments (JSDoc) sit *above* the function, outside the brace-span body the selector
returns, so there is no leading docstring inside the region to keep. `--keep-docstrings` is a
Python-only behaviour with a language-agnostic name, and the name is honest because on other
languages it is simply inert rather than wrong.

### Method

`test/unit/keep-docstrings.test.ts`: the two behaviour-changing cases fail against the unfixed
engine; the three invariants (a body with no docstring is unchanged, a whole-body docstring drops
the region, TypeScript is untouched) pass both ways as negative controls. The default path is
**576/576 byte-identical** on the corpus A/B, because the flag is off.

---

## 59. Go Symbols First, Because the Gate Could Not Tell Body Elision From Deletion

**Date:** 2026-08-20 · **Status:** accepted · **Scope:** `DriftTracker.extractSymbols`, Go

Step 1 of the three that widen elision to Go. §56 measured the precondition and fixed the order —
`extractSymbols`, then the validator, then `REGION_ELISION_LANGUAGES` plus the region scanner —
and this is that first step and nothing else. **Go is still unelidable after it, deliberately.**

### What it adds

Two patterns, both anchored to the start of a line, because a Go function declaration is always a
top-level one:

- `func Name(` and `func Name[T any](` → `fn:Name`
- `func (r *Recv) Name(` → `method:Recv.Name`

Methods are qualified by receiver where the class methods in block 8 are not. Go convention gives
many types in one file the same method names — `String`, `Error`, `Read` — so a bare
`method:String` collapses them and losing ten reads as losing one. Nothing downstream parses these
strings (they are only ever set-compared for `R_AST`), so the resolution costs nothing.

**Not harvested, deliberately.** Anonymous literals (`x := func() {}`) and func types
(`type Handler func(int) error`) have no name to take. An interface method declaration has a name
but no body, so harvesting it would add one more symbol that survives elision by construction —
the exact dependency this step exists to remove.

### What it changes, measured

Same file, same four after-shapes, engine varied and nothing else. `S_k` and the two gates, before
and after:

| after-shape | `S_k` before | `S_k` after | gates before | gates after |
|---|---|---|---|---|
| whole item → marker | 1.0000 | 1.0000 | retention refuses | retention refuses |
| bodies elided, signatures kept | 0.0000 | 0.0000 | both pass | both pass |
| one whole declaration removed | 0.0000 | 0.1667 | both pass | both pass |
| **every declaration removed** | **0.0000** | **0.6667** | **both pass** | **retention refuses** |

`symbolsBefore` goes 2 → 6: `type:Point` and `import:strings` gain `fn:computeTotal`,
`fn:renderReport`, `method:Point.Translate` and `method:Point.String`.

**The fourth row is the defect closing.** A Go file with every function deleted, package and
import and struct left standing, scored `S_k = 0.0000` with `astMeasured: true`, both gates
passing and `fallbackUsed: false`. That is §56's simulation reproduced through the shipped
tracker, and on the CLI, where elision is irreversible, it is data loss reported as a clean run.

### The negative control is not quite the one the skill states, and the difference matters

`widen-language` says drift on a hand-elided file should become non-zero. Measured, that holds for
**declaration loss** and not for **signature-preserving body elision**, which still scores
`0.0000` — row two, unchanged.

That is correct and it is load-bearing. Region elision keeps signatures by construction, so the
symbols survive and there is no semantic loss to report; if row two had moved, step 3 would ship
as a fallback generator. TypeScript behaves identically and §40 already records why.

**So the precise claim is narrower than "drift can now see Go", and it is the one worth having:
before this step the gate could not distinguish rows two, three and four from each other — all
three read `0.0000`. Now it scores them 0.0000, 0.1667 and 0.6667.** A region scanner that takes a
brace span too far, or takes a declaration instead of a body, is a thing the gate can now witness.
That is the failure mode step 3 introduces, and this is the instrument for it.

### Method

Corpus frozen at `7d97049`, 287 files across nine buckets, `dist` pinned at `2f3fe633`, both arms
built with an `src`-only tsconfig so `test/` could not silently block the emit. 574 rows (287
files × 2 routes) per arm.

- **574 of 574 byte-identical.** 0 rows differ across 17 compared fields, `symbolsBefore` among
  them — and the diff asserts its own row count and that every compared field is present, because
  keying on a field the harness does not emit is how a previous A/B reported "differing: 0" over
  two rows.
- **Byte-identical is not inert, and here the reason is countable:** 0 of the 287 corpus files
  match either pattern. There is no Go bucket, and no other bucket contains a line-anchored
  `func`. §56's caution, arriving on the very next change.
- Blast radius outside Go is therefore evidenced by unit cases rather than by the corpus:
  TypeScript that uses `func` as a loop variable and calls `applyFunc`, and Python that names a
  parameter `func`, both yield exactly their own symbols.
- `test/unit/go-symbols.test.ts`: **9 of 14 fail against the unfixed engine.** The 5 that pass
  both ways are named in the file header as controls; one of them — row two above — is a control
  on purpose.

Collecting the corpus also surfaced that the prose bucket is now 17 documents, not 18:
`DECISIONS.md` crossed the recipe's 204,800-byte cap as it grew. The cap was not raised, since
raising it would move every prose aggregate to keep one file whose growth is the reason it stopped
fitting. Recorded in the recipe's own log; prose aggregates from here are not comparable to earlier
18-document ones.

### What this does not establish

- **Go's fallback rate is still unmeasured**, so §56's 23–28% projection still borrows
  TypeScript's conversion factor. That needs step 2, and it is the number most likely to move.
- **Nothing about reduction.** Go reduces 0.00% after this change exactly as before it —
  `supportsRegionElision` decides that, and it consults the validator, not the symbol extractor.
  `trace.languageSupport` still reports Go unsupported and `language-support.test.ts` still asserts
  it.
- **Grouped imports are still not harvested.** `import "strings"` yields `import:strings`;
  `import (\n\t"fmt"\n)` yields nothing, because the JS import regex wants a quote after the
  keyword. Out of scope and immaterial to the argument — imports are on the side of the ledger that
  cannot witness body loss anyway.
- **A Go raw string holding source at column 0 yields a symbol.** Characterized in the test rather
  than fixed: it errs conservatively, because such a symbol sits inside a body, so elision removes
  it and drift becomes more likely to refuse, not less.

---

## 60. Go Gets Its Own Lexer, Because Raw Strings Are Where the TypeScript One Invents Findings

**Date:** 2026-08-21 · **Status:** accepted · **Scope:** `GoValidator`, `selectValidator`

Step 2 of the three that widen elision to Go (§56 fixed the order, §59 was step 1). **Go is still
unelidable after it**: `regionElisionLanguage` requires the language to be in
`REGION_ELISION_LANGUAGES` *as well as* to have a validator, and `'go'` joins that list in step 3.
What this step buys is **coverage** — a `.go` item stops reporting `validated: false` and starts
being checked, which is §23's distinction that an unexamined item is not a passing one.

### Why not just point Go at `TypeScriptValidator`

The grammars share `//`, `/* */` and the three bracket pairs, which is exactly the resemblance
that makes substitution look free. Measured over **9,181 real Go files, 100.8 MB** (`cli/cli`,
`cobra`, `gin`, `golang/go` `src/` — §56's corpus, its stdlib subset hash-verified **5,387 of
5,387** against that session's manifest):

| validator | files flagged | rate |
|---|---|---|
| `TypeScriptValidator` | **73** | 0.80% |
| `GoValidator` | **1** | 0.01% |

The single Go flag is `cmd/compile/internal/syntax/testdata/issue20789.go`, whose own header reads
*"Make sure this doesn't crash the compiler"* — deliberately malformed input, so a **true
positive**. The 72 files the two disagree on are raw strings:

- `` strings.Contains(v, `\`) `` — `cmd/go/internal/fips140`. A TS lexer reads the backslash as
  escaping the closing backtick, never closes the literal, and swallows the rest of the file.
- `cobra/zsh_completions.go` — a 200-line shell template inside one raw string.

Three lexical facts drive all of it. Go's `` ` `` string spans lines, has **no escapes at all**
and routinely holds `"`, `{`, `}` and `\` (struct tags, SQL, templates); rune literals are single
characters, including `'"'`; and there are **no regex literals**, so the TS lexer's
`/`-may-start-a-regex heuristic has nothing to be right about and every wrong guess swallows a
line. This is §17's finding — a verdict decided by quote parity is not validating anything —
measured for Go instead of for shell, perl and tcl.

### 0 findings is what a validator that examines nothing also reports

Invariant 10, so the control runs the other way. Over a 1,312-file deterministic spread of the
same corpus, deleting the last column-0 `}` is caught in **1,159 of 1,163** files (**99.66%**).
Five further mutation classes — dropping the first `{`, mismatching a pair, opening an
unterminated interpreted string, an unterminated raw string, an unterminated block comment — run
95%–100% on the same sample.

**Every non-catch was inspected rather than tolerated, and all of them are mutations that are not
defects**: the brace deleted sits inside a raw string (`internal/platform/zosarch_test.go`, whose
template holds generated Go), inside a `//` comment (`cmd/gofmt/doc.go`, `cmd/cgo/.../callstub`),
or inside a cgo `/* … */` C preamble (`runtime/testdata/.../testsyscallc.go`). Deleting a brace
there changes nothing, so a non-flag is correct — and it is the same property that separates this
validator from the TypeScript one, showing up as an apparent miss.

### The step-2 negative control

Two frozen corpora, engine varied and nothing else, both arms built with an `src`-only tsconfig.

**A Go corpus, 80 files / 160 rows** (frozen separately via `collect.js --recipe`; the shipped
`recipe.json` is untouched, because these roots are a scratch clone and a temp directory is not a
stable root to bake into the repo):

| | step 1 | step 2 |
|---|---|---|
| file route, items no validator looked at | 40 + 40 | **0 + 0** |
| stdin route, same | 40 + 40 | 40 + 40 |
| reduction, every bucket and route | 0.00% | **0.00%** |
| fallbacks | 0 | **0** |
| `outputSha` identical between arms | — | **160/160** |

Exactly **three fields move, on exactly the 80 file-route rows**: `astChecked` 0→1,
`astUnchecked` 1→0, `symbolBearingItems` 0→1. **Coverage moves; output does not.**

The stdin row staying at 40 is not a regression: a piped `.go` carries no filename, and there is
deliberately no Go content probe (§31's rule — a probe may only claim content its validator
already accepts, and §4's TS-versus-prose overlap is why probes are added sparingly).
`--language go` and `--input-name x.go` both reach the validator, and `go`/`golang` were already
accepted spellings.

**The 287-file main corpus is 574/574 byte-identical, 0 rows differing across 17 fields.** As in
§59 that is the corpus lacking the shape rather than the change being inert — it contains no Go
at all, which is why the Go corpus above exists.

### The finding this exposed: `symbolBearingItems` counts the wrong thing

`DriftCoverage.symbolBearingItems` is computed as the set of items **a validator covered**, not
items bearing symbols — it is `astChecked` by another route. The name has been wrong since it was
introduced and nothing could see it, because until §59 every language with symbols also had a
validator and every language without one had neither.

Go between §59 and §60 is the first case where those came apart, and the reported pair is
self-contradicting: over the 80 frozen Go files on the file route, **all 80** report
`symbolsBefore = 3` or more next to `symbolBearingItems = 0`. `symbolsBefore` is the field that
actually counts symbols.

Recorded at the computation site and **deliberately not fixed here**. It is a trace field
consumers parse, so renaming it — or making it count what its name says, which moves the number
for every language and invalidates recorded baselines — is a decision with its own blast radius,
not a ride-along in the commit that exposed it. This is §55's lesson pointed the other way: the
two LOW items that got fixed were the two that happened to sit inside someone else's diff.

### What this does not establish

- **Go's fallback rate under elision is still unmeasured.** The 0 fallbacks above are 0 out of 160
  rows on which *nothing was elided*, so they say nothing about what the constraint and drift
  gates will do once step 3 selects regions. §56's 23–28% projection still borrows TypeScript's
  conversion factor.
- **The guarantee is balance, not syntax** — the same one the README's table states for
  TypeScript. Balanced but meaningless Go passes. What it is for is the failure mode step 3
  introduces: an elision landing inside a raw string, or dropping a `}`, is an unbalanced bracket.
- **The Go corpus is alphabetically-first selection**, which is deterministic and not
  representative (the harness README's own caveat). It is adequate for a coverage measurement and
  would not be adequate for a reduction one.
- **`code` still maps to no validator.** Go reaches `GoValidator` through the `language` and
  `path` branches, by its own grammar — which is the distinction that `null` exists to preserve,
  not one this contradicts. Rust, C, Java, shell and the rest are unchanged and still uncovered.

---

## 61. Go Elides, and the Ordering Discipline Paid for Itself Twice

**Date:** 2026-08-21 · **Status:** accepted · **Scope:** `REGION_ELISION_LANGUAGES`, the Go region
scanner and statement splitter

Step 3 of three, and the one that changes output. §56 fixed the order and measured the
precondition; §59 gave the drift gate Go symbols; §60 gave Go a validator. This adds the scanner,
and Go reduces.

### What it adds

- **`scanGoBraceSpans`**, a Go brace scanner — separate from `scanBraceSpans` for exactly §60's
  reason: Go's `` ` `` raw string spans lines, takes **no escapes**, and holds `{`, `}` and `\`.
  A TypeScript scanner reads `` `C:\path\` `` as an unterminated template literal and every brace
  after it as string content, and a region boundary computed from that is not a function body.
  No regex-literal state, because Go has none.
- **`GO_FUNCTION_HEADER = /^func\b/`**, a keyword test where TypeScript needs a shape test. This
  is most of why Go was the first language added (§56). `FUNCTION_HEADER` matches anything ending
  in `)`, so `CONTROL_FLOW_HEADER` has to subtract `if`/`for`/`while` back out; `^func` needs no
  subtraction, and it excludes `type Point struct {`, `Config{`, `switch v := x.(type) {` and
  every closure form (`go func() {`, `defer func() {`, `handler := func() {`) by construction.
- **`splitGoStatements`**, because **Go ends statements at a newline, not at a `;`**. Semicolon
  insertion means gofmt-ed source has almost none written down, so `splitTypeScriptStatements`
  finds only the `}` boundaries and calls most bodies indivisible — §50's overshoot, one language
  along. The boundary is a newline at depth 0, so a multi-line call, a composite literal and a
  nested block are each one span.
- `'go'` in `REGION_ELISION_LANGUAGES`, plus a Go arm on `isSubstantiveRegion` (`stripGo`).

### Measured

Frozen 80-file Go corpus, target 0.3, engine varied and nothing else:

| bucket | files | reduce | fallback | aggregate |
|---|---|---|---|---|
| application Go (`cli/cli`, `gin`, `cobra`) | 40 | 32 | 8 | **27.46%** |
| stdlib (`golang/go` `src/`) | 40 | 25 | 12 | **19.42%** |

§56 projected **23–28%** from the ceiling, borrowing TypeScript's conversion factor. Application
Go landed at **27.46%**, at the top of that range and **above this repo's TypeScript at 21.22%**
on the same engine. The stdlib's 19.42% tracks its 10pp lower ceiling, which §56 traced to
generated tables rather than averaging away.

**The 287-file main corpus is 574/574 byte-identical, 0 rows differing across 17 fields.**
TypeScript and Python are untouched, because every Go path is gated on `language === 'go'`.

Adherence at target 0.3 over the 57 reducing files: median **35.8%**, with 20 in the 25–35% band,
17 in 35–50% and 14 above 50% — the same profile TypeScript has after §50.

### §56's hazard, measured live rather than simulated

Neutering §59's Go symbol patterns and re-running step 3 reproduces the configuration §56 warned
about — the region scanner without the drift gate that can witness it:

| | scanner-first (no §59) | shipped |
|---|---|---|
| file-route fallbacks | 43/80 | **20/80** |
| rows where drift measured anything | 55/80 | **80/80** |
| median `symbolsBefore` | 2 | **8** |
| application Go aggregate | 14.45% | **27.46%** |

**32 files elide with `S_k = 0.0000`, `astMeasured: true`, both gates passing and no fallback, on
1–5 symbols that are all `type:` and `import:`.** `accessibility.go` loses **78.4%** of its tokens
that way. That is §56's table, on real input, at scale — the gate reporting perfect retention
having witnessed nothing. With §59 in place the same 32 files still pass, and that is correct
(signature-preserving elision genuinely loses no symbols), but the verdict now rests on a median
of 8 real symbols instead of on an import.

**§59 is not a tax on reduction; it is a precondition for it.** Fallbacks more than halve and
application Go goes 14.45% → 27.46%, because without Go symbols many files have *no* symbols and
§33's measurement gate refuses them outright. The safety step and the reduction step turned out
to be the same step.

### Go's fallback rate, and an expectation of §56's that measurement contradicts

§56 could not measure this and said so. Now: **20 of 80 files fall back (25%)**, and the causes are

- **18 `CONSTRAINT_DIRECTIVE_LOST`**
- **2 `SEMANTIC_DRIFT_EXCEEDED`** (both `fuzz_test.go`, `S_k = 0.50`)

**§56 expected Go's lower comment density to make the constraint gate fire *less*. It does not.**
The gate dominates Go's fallbacks exactly as it dominates TypeScript's, and the rate is the same
within noise — 25% for Go against 24% for this repo's TypeScript (15 of 62). Density was the wrong
variable: what trips the gate is Go's *defensive comment style*, and it is §7.5's still-open axis
verbatim — `// This never happens in practice`, `// Should never happen, but we`,
`// The user data should always`, `// does not always result in`, `// Must read more data.`
Every one is descriptive present tense, which §52 deliberately did not attempt.

So the largest remaining gain on Go is not in the scanner. It is in that gate.

### Test files are the larger prize, confirmed end to end

§56 measured `_test.go` at a 92.22% ceiling and flagged that nothing here had been counting them.
Through the shipped pipeline:

| | files | reduce | fallback | aggregate |
|---|---|---|---|---|
| `_test.go` | 40 | 32 | 7 | **26.88%** |
| source | 40 | 25 | 13 | **14.42%** |

Nearly double the saving *and* half the fallbacks. Go's table-driven test convention puts large
literal slices inside function bodies, which is exactly what body elision is for.

### What this does not establish

- **The Go corpus is alphabetically-first selection** — deterministic, and not representative
  (the harness README's own caveat). It is 80 files against the main corpus's 287, and it is
  frozen through a scratch recipe rather than the shipped one, because its roots are a temp-dir
  clone.
- **A signature broken across lines is silently skipped**, and the corpus does not say how often.
  `scanBraceSpans` takes the header from the line carrying the `{`, so a gofmt-wrapped signature
  presents as `) error`. Under-selection costs reduction, never content, which is why it ships
  characterized rather than fixed.
- **Reversibility was not measured separately for Go.** `token-hashing`'s rehydration path is
  language-agnostic and covered by `token-hashing-reversibility.test.ts`; nothing here tested that
  a Go elision round-trips through a real MCP session.
- **Nothing about Rust, C or Java.** Each needs its own three steps, and the header discriminator
  is the hard part for the C family (§56) — `int foo(...)` cannot be told from a prototype, where
  `func` is unambiguous.

---

## 62. Two Dials That Reported Success and Did Nothing, Withdrawn on H4's Terms

**Audit OX-H5.** `--trace-output` / `TOKENDAMPER_TRACE_OUTPUT` and `--mode explain` were parsed,
validated, stored on `ResolvedConfig` — and read by nothing. They are withdrawn from every input
surface. The model fields stay.

### What made these High rather than tidy-up

This project already removed three flags for exactly this defect. Audit H4 took
`--max-output-tokens`, `--max-latency-ms` and `--risk-tolerance` because they were "wired end to
end … while no stage read them", and `README.md` records them as removed in 1.2.0. These two
survived that sweep because they are not `OptimizationBudget` fields — they sit on
`ResolvedConfig`, which nobody thought to audit.

The trace is emitted by a literal:

```ts
io.stderr.write(JSON.stringify(result.trace, null, 2));
```

So `--trace-output stdout` accepted the value, validated it against an enum, threaded it through
the file → env → CLI precedence chain, froze it onto the config, and then the trace went to
stderr. A user setting it to capture a trace in a pipe got stderr anyway and concluded the tool
had ignored them. It had. `appMode === 'explain'` is the same shape with nothing at the end of it
at all.

**Measured before deciding:** `traceOutput` appears at ten sites across `cli/main.ts`,
`config/{load,schema,types}.ts` and `core/model/types.ts`. Every one is a write or a type
declaration. There is no read.

### Withdraw, not implement

Implementing `--trace-output` is two lines. It was still the wrong call, because the flag has no
demand behind it — it was added speculatively, and the one caller in this repository that passes
it (`tools/corpus-harness/measure.js`, `--trace-output stderr`) has been parsing stderr correctly
the whole time *while passing a flag that did nothing*. That is the clearest possible evidence
that nobody needs the other value: the only user asked for the default.

`explain` is worse — implementing it means designing a mode, not honoring a setting.

So: the surfaces go, on H4's terms. `ResolvedConfig.appMode` and `ResolvedConfig.traceOutput`
remain, documented as unconsumed, because `ARCHITECTURE.md` pins the model as frozen and **a field
awaiting an implementation is not the same defect as a dial that reports success.** If
`traceOutput` is ever implemented, `cli/main.ts` reads the field and the surfaces come back — in
that order, never the reverse.

### What is *not* withdrawn, and why the distinction matters

`--mode` stays. It is withdrawn by **value**, not removed, because `--mode bench` has a live
effect — it rewrites the command:

```ts
if (value === 'bench') { command = 'bench'; }
```

That effect is in the *parser*, not in anything that reads `appMode`, which is exactly the
distinction that made this worth checking rather than assuming. An earlier pass through this
finding concluded "`appMode` has no consumers, so remove `--mode` entirely" — true about the
field, false about the flag, and it would have deleted a working route to `bench`.

### Consequences

- **`--trace-output` is now `Unknown argument`.** `TOKENDAMPER_TRACE_OUTPUT` is simply not read,
  matching how the H4 variables were retired; nothing that worked stops working, because it never
  worked.
- **`--mode explain`, `TOKENDAMPER_APP_MODE=explain` and `app.mode: "explain"` are hard errors.**
  That follows the rule v1.6.0 set for the `TOKENDAMPER_*` enums (§55, L1): an unrecognized value
  is reported rather than ignored. Nothing that took effect stops taking effect, because it never
  took effect.
- **A config file still carrying `traceOutput` keeps loading.** The key is no longer validated or
  read, and unknown keys were always ignored. Withdrawing a knob must not turn a file that loaded
  yesterday into a hard error — that would be a real regression in exchange for a cosmetic one.
- **`tools/corpus-harness/measure.js` was updated in the same change.** It passed
  `--trace-output stderr`, which is now a parse error; leaving it would have broken the
  measurement harness this project depends on to check its own numbers. Verified after the
  change: the file route exits 0 and its trace still parses out of stderr.

### One thing this corrected on the way past

The comment above `COMMON_FLAGS` claimed `--target-reduction-ratio` "deliberately stays despite
being nearly as inert — the planner reads it only as `> 0`". **That has been false since §48**,
which resolves the ratio into an absolute token ceiling that both `pruning:topology-pruner` and
`compression:token-hashing` respect, and §50 narrowed the adherence gap further. A comment that
records a decision is load-bearing in this codebase; one that records a *superseded* decision
argues for undoing the fix.

## 63. The Float Pool: Two Small Hashes and Two Recorded Limits

**Date:** 2026-08-23 · **Status:** accepted · **Scope:** `core/model/constructors.ts`, `core/topology/`

Four LOW findings from `oxaudit.md` (the ox-alpha audit of tree `79aedef`), claimed from the
split document's float pool because they are file-disjoint from both lanes' active sets. Two are
code, two are recorded rather than fixed — the same disposition DECISIONS §55 gave its LOW table,
for the same reason: a fix that changes more than the defect is worse than a documented limit.

### L2 — `stableSerialize` no longer collapses `undefined` onto `null`

`JSON.stringify(undefined)` returns `undefined`, and the old `?? 'null'` turned that into
`null`'s serialization, so `{ a: undefined }` and `{ a: null }` hashed identically. A hash is a
statement about the value it was given; two different values must not share one. The fallback now
emits the bare token `undefined`. The output only ever feeds `createHash`, so it does not have to
be valid JSON — it has to be injective. No live path reaches the branch (constructors build
objects by conditional spread specifically so no key is ever `undefined`), which is exactly why
it sat unnoticed: the defensive branch was itself the collision.

### L11 — the extension test reads the basename, not the whole path

`classifyContentShape` took the segment after the last dot of the whole path, so a dotted
directory (`my.dir/file`) leaked directory text into the extension test. Measured before
changing anything: every possible leak lands on an unrecognized string and falls through to the
content probes, byte-identical to an absent extension — **no observable behaviour changes
today**, and the tests pin that rather than assert a behavioural delta that does not exist. What
the pin buys is a tripwire: a future edit that makes a leak reachable (a directory segment that
*is* a known extension) fails loudly instead of silently reclassifying. Same algorithm as
`cli/ingest.ts`'s `extensionOf`; duplicated rather than imported because `core` may not import
`cli`.

### L3 — `h → c` stays, recorded

Removing the alias would make `--language h` an error while `foo.h` stayed accepted on the
filename route. That is the two-routes drift the alias table exists to prevent (`py`, `cc`,
`hpp` are all extension spellings by design). Characterization test added; if anyone removes the
alias, the test tells them to take `.h` off the filename route in the same change or restore it.

### L5 — case-sensitive git path matching stays, recorded

Git porcelain uses the index's casing; a directory walk uses the filesystem's; they agree in
practice. The open case is caller-supplied casing (`optimize SRC/foo.ts` against a repo storing
`src/`), and its effect is a lower topology score — selection quality, never output bytes.
Case-folding one side would make scores depend on the platform's filesystem semantics, and
determinism is invariant 1. Documented at `normalizeGitPath` and the scorer's call site.

### Verification

`npm run typecheck`, `npm run lint` and `npm test` clean; the suite pins each disposition
(`model.test.ts` for L2, `content-classification.test.ts` for L11, `declared-language.test.ts`
for L3). L5 changes no code path, so no corpus run applies; nothing here touches engine output.

---

## 64. The Debt Score Was a Constant, and the Corpus Could Not See the Other Half

**Audit OX-M6 and OX-M7**, both in `computeDebtBreakdown` / `attemptAutomatedRehydration`
(`src/core/engine/index.ts`). Measured over a corpus frozen at `8b447ce`, 289 files, 578 rows
(both CLI routes), target ratio 0.3.

### M7: `debtScore` reported 35.00 on every file that reduced

`computeDebtBreakdown` added `metadata.originalBytes` to `elidedBytes` for any item carrying
`elided: true`. `originalBytes` is the item's **entire** pre-transform length — every stage that
sets it does so from `item.content.length` — and `elided` is a boolean on the whole item. So an
item that lost 5% of its bytes contributed 100% of its size to the numerator.

On the CLI a single file is a single-item bundle, which makes `elidedBytes === totalBytes` whenever
anything was elided at all. The ratio was 1.0 by construction.

**Measured, baseline arm:** of 578 rows, 317 carried any debt at all, and **317 of 317 scored
`debtScore` exactly 35.00** — the `weightElisionRatio * 100` ceiling — whether the file lost 4.7%
or 66.8% of its bytes. `Math.min(1.0, …)` in `calculateDebt` was clamping a ratio with no business
exceeding 1, which is why nothing ever looked wrong. The number was a constant wearing the name of
a measurement, and `--max-debt` was a dial against a value that never moved.

The fix counts bytes actually removed, `originalBytes - content.length`.

**Measured, candidate arm:** 0 of 317 pinned at the ceiling; the distribution runs 1.31 → 34.99
with a median of 33.08. Over the 101 rows that reduce, the implied ratio (`debtScore / 35`) against
the measured byte cut has **correlation 1.0000** — 0.047 against 0.047, 0.198 against 0.198, 0.429
against 0.429. It is now the quantity it claims to be.

**Output did not move.** Per-row over 578 rows the only field that changed is `debtScore`;
`outputSha`, `byteIdentical`, `tokenBefore`, `tokenAfter`, `reduction`, `fallbackUsed`,
`driftScore`, `planMode` and `stageCount` are identical. Debt gates nothing on the CLI, because
`shouldRehydrate` needs 75 and the elision term alone caps at 35.

**The audit's stated mechanism was wrong and the finding was right.** It described a denominator
mixing pre- and post-transform sizes. That does not happen: every stage setting `elided` also sets
`originalBytes`, and untouched items are unchanged, so `totalBytes` was already a clean sum of
original sizes. The numerator was the defect, and it was worse than "skewed" — it was saturated.

### M6: an empty candidate set meant "restore everything"

`attemptAutomatedRehydration` guarded with `candidates && candidates.size > 0 &&
!candidates.has(item.id)`. The `size > 0` clause exists for the *missing* ledger case, where no
statement has been made about which items matter. It also swallowed the case where a ledger exists
and reports **zero** items below the confidence threshold, turning "nothing needs restoring" into
"restore every elision in the bundle".

**Reachability, checked rather than assumed.** None of the three bundled entry points reaches it:
the CLI passes neither hasher nor ledger and returns at the first guard; MCP and `bench` pass a
hasher but no ledger, so `candidates` is `null` and the intended fall-through applies; the Gateway
passes a ledger but no hasher and plans only `cleanup:session-dedup`, so nothing it elides could be
rehydrated. It **is** reachable through the public API — `optimize` is exported, and an embedder
supplying both a `tokenHasher` and a `confidenceLedger` lands on it.

Reproduced there: a 1,481-byte item came back at exactly 1,481 bytes, every elision undone, with
`debtScore` then recomputed to 0 on the restored bundle so the trace reported no debt either.

**The corpus is silent on this, and silence is not agreement.** The `m7 -> m6m7` arm differs on
**0 of 578 rows**, which is exactly what the structure predicts and is *not* evidence the fix is
correct — the corpus runs CLI routes, which supply no ledger, so the instrument cannot see the
shape at all. This is §56's lesson with the sign reversed: byte-identical is not inert, and here it
is not even informative.

**The test had to be rebuilt twice.** The first version passed against the unfixed code, because
the default `maxDebtThreshold` of 75 is unreachable on turn 1 — confidence penalty 0, turn age 0,
elision term capped at 35 — so the branch it claimed to exercise never ran. The committed version
carries two controls: one proving the setup elides at all, and one proving the branch *is* entered
under `maxDebtThreshold: 1` via the no-ledger path, where a full restore is the intended behaviour
rather than the bug.

### What this does not establish

- **Nothing about the Gateway.** Both findings are engine-level; the Gateway supplies a ledger but
  no hasher, and its plan cannot produce a rehydratable elision. Neither fix changes Gateway
  behaviour, and neither was measured there.
- **Nothing about multi-item CLI bundles.** The harness runs one file per invocation. M7's
  correction is larger on multi-item bundles — a partially-elided item over-contributes there too —
  but that is reasoned, not measured.
- **No absolute figure here is comparable to §2.** This corpus is 289 files at `8b447ce`; the
  recipe expected 62 TypeScript and 17 prose files and selected 63 and 18, because the repository
  has grown since the recipe was written. Only the per-row A/B over this one frozen corpus means
  anything, which is the standing rule.
- **`--max-debt` still gates nothing on the CLI.** Debt is now a real number, but the default
  threshold of 75 remains unreachable without a ledger, so no CLI run can trip it. Whether the
  threshold or the weights should change is a separate question and was not touched.
