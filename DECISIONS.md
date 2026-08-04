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
  `yaml` for a decision.

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
