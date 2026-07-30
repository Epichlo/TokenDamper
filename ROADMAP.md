# TokenDamper Product Roadmap — v1.1.0 → v2.0.0

**Baseline:** v1.0.3 (current). All items below were checked against the actual source
(`repomix-output.xml`), not assumed from a prior model's summary — file/function names cited
are real, and known-already-shipped items have been excluded (see Appendix).

```
v1.0.3 (Current Baseline)
 └── v1.1.0: Measurement Foundation & Performance Caching
      └── v1.2.0: Context Selection Quality & Redundancy Elimination
           └── v1.3.0: AST Code Folding ("Fast" vs "Deep") & Cache Alignment
                └── v1.4.0: Granular Sub-Query Re-hydration & MCP Tool Extension
                     └── v2.0.0: Enterprise Gateway, Remote MCP & Guardrails
```

---

## v1.1.0 — Measurement Foundation & Performance Caching

**Core objective:** accurate token counting, disambiguated config schema, fewer redundant Git calls.

### Pluggable `TokenizerAdapter` architecture
- Replace the `content.length / 4` estimate (used across budgeting, knapsack scoring, and reporting) with a pluggable interface.
- **Default (zero-dep):** enhanced deterministic character/word-ratio estimator. No bundled vocab, no new package.
- **Optional adapter:** tiktoken / `cl100k` provider for exact token counts.
- **Scope note:** the default heuristic is *not* exact. Anything downstream that needs precise token boundaries (see v1.3.0 `cache_control` placement) only gets that guarantee when the optional adapter is enabled — the roadmap should say this explicitly rather than implying the default is sufficient.

### Config schema versioning & migration
- Add `configSchemaVersion: "1.1"` to the `tokendamper.config.json` schema parser (`src/config/schema.ts`).
- Kept distinct from the existing `app.version` field (currently `"0.1.0"`) to avoid collision — the two mean different things and shouldn't share a key name.
- Guarantees existing config files upgrade cleanly when v1.2.0 introduces new scoring toggles.

### Git workspace status TTL caching
- Add a 2,000ms TTL in-memory cache keyed on `repoRoot`, inside `inspectGitWorkspace()` (`src/core/topology/git-inspector.ts`).
- Removes repeated `child_process.execSync` calls across multi-turn Gateway sessions.
- **Benchmark target (verify via `src/bench`):** sub-millisecond cache-hit lookups.

---

## v1.2.0 — Context Selection Quality & Redundancy Elimination

**Core objective:** upgrade context selection with hybrid relevance scoring, and eliminate pairwise
redundancy *without* breaking 0/1 knapsack's optimal-substructure guarantee.

### Hybrid lexical + topological scorer
- Expand `scoreBundleTopology()` to combine Git status + BFS dependency-graph distance with BM25 keyword overlap against the active prompt query.
- Prioritizes items that are both structurally close to dirty files *and* keyword-relevant to the prompt.

### Dual-path redundancy elimination (MMR)

This went through several design iterations before landing here — see rationale below the spec.

**DP solver path** (`N ≤ 100` candidates and residual capacity `≤ 10,000` — matches the actual threshold in `solve01Knapsack()`):
- `solveKnapsackDP()` runs unchanged, on independent topological scores $V_i$, producing the true globally-optimal bundle $S_0$.
- A post-selection pass, `refinePostSelectionRedundancy()`, evaluates pairwise similarity $M_{ij}$ **only across the items actually in $S_0$** (small set, cheap: target `<0.5ms`).
- Where $M_{ij} > 0.90$, eject the lower-density item of the pair and backfill its freed capacity from the remaining candidate pool by density order.
- **Required refinement — this must loop, not fire once:** after backfilling, re-check the newly-added item against the rest of $S_0$ before accepting it. Repeat eject → backfill → recheck until no pair exceeds the threshold (or a small iteration cap is hit — $K \le 100$ makes this cheap even at several passes). A single-shot version can reintroduce redundancy via the backfilled item itself.
- **Required refinement — pinned items are never eviction candidates.** Pinned items (`isPinned`) bypass the knapsack and are always included; if a pinned item is one half of a redundant pair, only the non-pinned item may be ejected.
- **Implementation note:** don't build $M_{ij}$ from scratch — `computeTokenSimilarity()` (Jaccard token overlap) already exists in `src/bench/evaluator.ts`. It's currently bench-only; move it to a shared module (e.g. `src/core/similarity.ts`) so both the bench harness and the runtime refinement pass use the same tested implementation.

**Greedy solver path** (`N > 100` or capacity `> 10,000`):
- `solveKnapsackGreedy()` selects iteratively by marginal value-per-weight, recomputed against the *actual* running selection at each step:
$$\text{Score}(i \mid S) = \frac{V_i - \max_{j \in S}(M_{ij} \cdot V_j)}{w_i}$$
- **Framing note:** describe this as a well-motivated greedy heuristic drawing on submodular-maximization-under-knapsack-constraint theory (the general problem class has known constant-factor approximation results for monotone submodular objectives) — not as a proven $(1-1/e)$ guarantee for this exact value function. Whether this specific MMR-style score is formally submodular hasn't been established; the property/fuzz test suite below is the actual verification mechanism, not a citation.

**Why the split, not one universal mechanism:** an earlier "pre-knapsack static reranking" design was considered and rejected — it requires building the redundancy reference set $S$ *before* the solver runs, using some weight-blind ordering. That set can diverge from what the DP or greedy solver actually selects once weight constraints bind (a heavy, high-value item can be assumed "in" for penalty purposes and then get excluded by the real solver for weight reasons), penalizing items for redundancy with content that never makes it into the final bundle. Computing $M_{ij}$ against the *real* selected/running set — post-hoc for DP, live for greedy — avoids that circularity entirely.

### Property & fuzz test suite expansion
- Extend `test/unit/fuzz-diff-debt.test.ts` with property tests for numeric scoring edge cases: empty bundles, all-identical items, score ties.

### Performance verification target
- **Benchmark target (via `src/bench`):** total context-selection pipeline latency `<10ms` across 20+ item bundles. Not a committed figure — validate once BM25 + MMR are both in the hot path, since combined they add real per-item work beyond today's baseline.

---

## v1.3.0 — AST Code Folding ("Fast" vs "Deep") & Cache Alignment

**Core objective:** dual-mode context compression, and exact provider prompt-cache alignment where the tokenizer allows it.

### User-facing configuration
```json
{
  "planner": {
    "mode": "fast"
  }
}
```
or `--mode fast` / `--mode deep` on the CLI.

- **Fast mode** (default): sub-millisecond execution, zero external runtime dependencies.
- **Deep mode:** surgical, full-grammar folding for complex or heavily-nested source.

### Fast mode: Declaration Boundary Detector + brace-depth tracker
- The existing validators (`ts-validator.ts`, `python-validator.ts`) only track a bracket/quote stack for syntax-balance checking — they have no concept of "this brace opens a function body" vs. an `if`/`try`/object-literal block. Folding needs a dedicated **Declaration Boundary Detector**: a lightweight regex/heuristic layer on top of the existing brace-depth stack that distinguishes top-level function/class/interface/method declarations from control-flow blocks.
- Folds non-dirty declaration bodies into signature stubs:
```typescript
export function processOrder(order: Order): Promise<Result> {
  /* ... [TokenDamper Folded Body] ... */
}
```
- Target: ~80% token reduction per file, 100% AST-symbol retention ($R_{\text{AST}} = 1.0$), zero runtime dependencies.

### Deep mode: optional formal AST parser module
- Opt-in plugin (`@typescript-eslint/parser` / Python `ast`) for users who need full grammatical precision on edge cases (multiline decorators, nested closures).

### `cache_control` ephemeral breakpoint injection
- Automatically inject Anthropic `cache_control: {"type": "ephemeral"}` markers at 1,024-token boundaries after prefix locking.
- **Exact mode:** when the tiktoken adapter (v1.1.0) is enabled — precise boundary placement.
- **Best-effort mode:** default zero-dependency heuristic tokenizer — boundaries are approximate. State this explicitly to users; don't imply the default estimator delivers exact placement.

### Performance verification targets
- **Benchmark target (via `src/bench`):** Fast Mode `<1ms`/file; Deep Mode `~15ms`/file. Unvalidated until built — treat as targets, not committed numbers.

---

## v1.4.0 — Granular Sub-Query Re-hydration & MCP Tool Extension

**Core objective:** interactive partial context un-elision via MCP.

### Extended `rehydrate_context` tool schema
Update `TOOL_DEFINITIONS` in `src/adapters/mcp/tools.ts` — this matches the tool's actual current signature (`text` + optional `sessionId`), extended with an optional `query`:

```typescript
{
  name: 'rehydrate_context',
  description: 'Rehydrate elided placeholders, session refs, or specific query sub-sections',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text containing BLOCK_HASH placeholders or elision refs' },
      sessionId: { type: 'string', description: 'Optional Gateway session ID' },
      query: { type: 'string', description: 'Optional keyword/method query to return targeted matching lines' }
    },
    required: ['text']
  }
}
```

- When `query` is present, scan inside the elided block and return only matching lines/methods instead of un-eliding the whole file. This is a different return shape from today's full-rehydration path (targeted match vs. full text) — design that response shape explicitly before implementation, not as an incidental side effect of adding a field.

---

## v2.0.0 — Enterprise Gateway, Remote MCP & Proxy Guardrails

**Core objective:** enterprise-grade proxy integration and multi-agent remote access.

- **MCP over Streamable HTTP/SSE:** extend `McpStdioServer` (`src/adapters/mcp/server.ts`) to support SSE and HTTP POST transports alongside stdio — enables remote containers, Cursor, Claude Code, and cloud agents over the network. (Note: this is distinct from the Gateway's existing upstream-SSE-passthrough — that's unrelated proxy behavior already in place, not MCP transport.)
- **LiteLLM & AI proxy guardrail plugin:** in-process pre-call guardrail integration (`guardrails: tokendamper`) for LiteLLM and open-source AI proxy gateways.
- **Gateway observability suite:** Prometheus `/metrics` endpoint + structured JSON access logging in `src/gateway/server.ts`.

---

## Version Summary

| Release | Focus | Key Deliverable | Benchmark Target |
|---|---|---|---|
| v1.0.3 | Baseline | 0/1 Knapsack, AST validators, debt/drift ledgers | Current test suite |
| v1.1.0 | Measurement | Pluggable tokenizer, `configSchemaVersion`, Git TTL cache | Sub-ms cache lookups |
| v1.2.0 | Selection quality | BM25 + graph hybrid scorer, dual-path MMR (DP refinement / live greedy) | `<10ms` pipeline selection |
| v1.3.0 | Folding & cache | Fast (zero-dep) vs Deep (AST) mode, `cache_control` (exact/best-effort) | `<1ms` Fast / `~15ms` Deep |
| v1.4.0 | Retrieval | `rehydrate_context` with sub-query matching | Targeted line extraction |
| v2.0.0 | Ecosystem | Streamable HTTP/SSE MCP, LiteLLM plugin, Prometheus metrics | High-throughput multi-agent proxy |
| Milestone 8 | Caching | MCP Schema Deduplication & Cache-Aligned Knapsack | 100% Provider Cache Hit Rates |
| Milestone 9 | Guardrails | Agent Loop Circuit Breaking & Critical Atom Recall Tracking | $S_k \le 0.40$ enforcement |

---

## Milestone 8: MCP Schema Deduplication & Cache Alignment

**Core objective:** Ensure provider cache hit rates via strict prefix pinning.
- **MCP Schema Deduplication:** Convert tool definitions into deterministic, sorted JSON structures at prompt position 0. Use content-addressed hashes to anchor MCP schemas without blowing up context windows or cache blocks.
- **Cache-Aligned 0/1 Knapsack Allocation:** Evaluate item weights in 1,024-token quantizations. Ensure items selected by the knapsack solver preserve exact prefix horizon ordering.

## Milestone 9: Safety & Drift Guardrails

**Core objective:** Stop invisible runaway token usage and prevent semantic information loss.
- **Agent Loop Circuit Breaking:** Integrate a circuit breaker into `DebtTracker`. If $N \ge 5$ consecutive turns show near-identical tool output signatures with high token volume, throttle or warn to prevent runaway costs.
- **Critical Atom Recall Tracking:** Expand `DriftTracker` to verify imperative directives (`TD_PRESERVE`), file paths, line numbers, and API endpoints are never lost. Introduce composite metric $S_k = 1.0 - (w_{\text{AST}} \cdot R_{\text{AST}} + w_{\text{struct}} \cdot R_{\text{struct}} + w_{\text{atom}} \cdot R_{\text{atom}})$.

---

## Appendix: Corrections Made During Review

For traceability — these were caught by checking claims against the actual source rather than
taking a prior draft at face value, and are already excluded/corrected above:

- The original Phase-1 list (fallback output bug, unbounded `traceStore`, missing `SIGINT`/`SIGTERM` handling, no gateway body-size cap) was **already fixed** in the current codebase — confirmed against `src/core/fallback/index.ts`, `src/adapters/mcp/tools.ts`, `src/cli/main.ts`, and `src/gateway/server.ts`. Dropped entirely rather than re-scheduled.
- "HTML dashboard telemetry alerts" for debt/drift thresholds ($D_k > 75$, $S_k > 0.40$) **already ship** in `src/cli/html-reporter.ts` (color-coded HIGH/MEDIUM/LOW and SAFE/HIGH DRIFT badges at those exact thresholds). Removed from v1.4.0.
- Config filename corrected to `tokendamper.config.json` (not `.tokendamperrc`).
- `rehydrate_context`'s example payload corrected to match the tool's real parameters (`text`/`sessionId`), replacing an invented `blockHash` field.
- The MMR mechanism went through three iterations: (1) "modify the knapsack value function directly" — rejected, incompatible with DP's independent-value assumption; (2) "static pre-knapsack reranking pass" — rejected, creates a circularity where items are penalized against a hypothetical selected-set that may not match the solver's actual output; (3) **adopted:** path-specific handling — post-selection refinement for DP, live marginal recomputation for greedy — with the loop-to-convergence and pinned-item exclusion requirements folded in above.
