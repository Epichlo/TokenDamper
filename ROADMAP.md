# TokenDamper Product Roadmap — v1.1.0 → v2.0.0

**Baseline:** **v1.5.0** (shipped 2026-08-12 — the constraint gate stops firing on narrative
comments, DECISIONS §52), on top of **v1.4.0** (sub-region elision, §50) and
**v1.3.0** (`--target-reduction-ratio` binds, DECISIONS §48),
on top of **v1.2.0**, which closed the whole audit remediation track in one release rather than
the three this document planned. All items below were checked against actual source, not assumed
from a prior draft; file/function names cited are real, and known-already-shipped items have been
excluded (see Appendix).

> **This document no longer reserves version numbers (DECISIONS §53).** Four reservations in four
> releases were wrong: v1.2.0 took the number held for "Context Selection Quality", v1.3.0 took it
> again, v1.4.0 took "AST Code Folding & Cache Alignment", and v1.5.0 took "Sub-Query
> Re-hydration" — the last of those a release that is perfectly buildable and had simply not been
> built yet, which is why §49's narrower rule did not cover it.
>
> **A number is a fact about what shipped, assigned at ship time.** Unshipped sections keep their
> name, scope and gate; they lose only the number, which was never doing work a name could not.
> `v2.0.0` is retained because a major signals *breaking change* rather than queue position.

> **The v1.1.x numbering below is historical.** v1.1.1 "Green Tree & Correct Metadata",
> v1.1.2 "Data Loss & Corruption" and v1.1.3 "Honest Instruments" were never tagged separately —
> their scopes all shipped in v1.2.0, together with the Scope Decision Gate answers and Phase 1c.
> The sections are kept because they record what each finding was and how it was disposed of.

> ### ⛔ Feature work is gated. Read this first.
>
> A full audit on **2026-08-07** (`max_audit.md`, commit `f93c385`) measured the shipped
> pipeline through all three entry modes. Its findings invalidate the *preconditions* of every
> release below, not merely their priority:
>
> - **The 0/1 knapsack solver is unreachable on every shipping path** (H5). `createContextBundle`
>   emits a one-item bundle for CLI, MCP and bench; prefix locking pins item 0; the solver always
>   selects it. `planner/index.ts:13-59` ignores its `_stageCatalog` argument entirely and returns
>   a hardcoded four-element list. **v1.2.0's BM25 scorer and MMR refinement, v1.3.0's
>   `cache_control` placement, and Milestone 8 all build on that solver** and would therefore
>   produce no observable change on any output the product can currently emit.
> - **A markdown document is deleted whole and every gate reports green** (C1). Reproduced:
>   233 bytes → a 72-byte marker, `fallbackUsed: false`, `S_k = 0.2667`, `unwitnessedItems: []`.
>   Irreversible on the CLI.
> - **The shipped benchmark reports 0.0% reduction and 40% fallback while its regression suite
>   passes** (H3), because the suite asserts against a private inline fixture set the product does
>   not ship. There is currently no instrument that can detect total failure.
>
> `CLAUDE.md` has carried the instruction *"Do this before roadmap feature work"* for some time.
> This document encoded it as: **v1.2.0 does not start until the v1.1.x remediation track lands
> and the Scope Decision Gate is answered.**
>
> ## ✅ That gate is now open — v1.2.0 shipped 2026-08-11.
>
> Every finding in `max_audit.md` is closed, and the three preconditions this notice named are
> answered rather than deferred:
>
> - **H5 — the knapsack is reachable.** `optimize` takes multiple paths and directories; measured
>   on `src/core` at `--max-input-tokens 4000`, 15 of 31 files pruned, 20,540 tokens saved. So
>   v1.2.0's BM25 scorer and MMR refinement now build on a solver that can affect output.
> - **C1 — markdown is no longer deleted whole with every gate green** (DECISIONS §33–§34).
> - **H3 — the instruments are honest.** `bench` runs the shipped fixture set, `baseline.json`
>   asserts measured truth, and a 0% result reports whether a budget was in effect and whether any
>   transform could reduce the language.
>
> **Read `docs/audit-remediation-status.md` §4 before starting feature work.** It carries the traps
> this codebase has for anyone changing it — chiefly that `src/` is its own measurement corpus, so
> aggregate reduction figures are not comparable across a commit and only a per-row A/B over one
> frozen corpus means anything.

```
v1.1.0 (tag @ 807f6f0) — never published to npm
  │
  └── v1.2.0  SHIPPED 2026-08-11 — tag, GitHub release, npm latest
       │      the whole v1.1.1/1.1.2/1.1.3 remediation track + the Scope
       │      Decision Gate answers (H2, M1, M11) + Phase 1c, in one release
       │
       ├── v1.3.0  SHIPPED 2026-08-12 — `--target-reduction-ratio` binds (§48)
       ├── v1.4.0  SHIPPED 2026-08-12 — sub-region elision; the target adheres (§50)
       ├── v1.5.0  SHIPPED 2026-08-12 — a comment narrates as well as instructs (§52)
       │
       └── v2.0.0: Enterprise Gateway, Remote MCP & Guardrails  [B answered: experimental]
              a major signals BREAKING, not queue position — §53

  unnumbered — Granular Sub-Query Re-hydration & MCP Tool Extension
       ✅ Buildable: M5b shipped in Wave 2, so the base rehydration path
          works. What remains is designing the targeted-match response
          shape. It held v1.5.0 and lost it to work that finished first.

  unnumbered — Context Selection Quality & Redundancy Elimination
       ⛔ Holds no version number. BM25 has no query source; MMR found 0 of
          1,486 pairs above its 0.90 threshold. It gets a number when its
          preconditions hold, not before.

  unnumbered — AST Code Folding ("Fast" vs "Deep") & Cache Alignment
       ⛔ Holds no version number. Fast mode is substantially already shipped
          in `elision/regions.ts`; cache alignment needs a caller-supplied
          `cl100k_base` encoder before 1,024-token quantization means anything.
```

---

## v1.1.0 — Measurement Foundation & Performance Caching — **SHIPPED**

**Status:** Shipped as of the `v1.1.0` tag (`807f6f0`); this is no longer upcoming work.
Retained below for detail. `configSchemaVersion` and the Git workspace TTL cache are
confirmed present in source (`src/config/types.ts`, `src/core/topology/git-inspector.ts`).
The tiktoken/`cl100k` adapter sub-item below is **partially** shipped — see the corrected
description under "Pluggable `TokenizerAdapter` architecture."

**Core objective:** accurate token counting, disambiguated config schema, fewer redundant Git calls.

### Pluggable `TokenizerAdapter` architecture
- Replace the `content.length / 4` estimate (used across budgeting, knapsack scoring, and reporting) with a pluggable interface.
- **Default (zero-dep):** enhanced deterministic character/word-ratio estimator. No bundled vocab, no new package.
- **Optional adapter — seam shipped, no bundled provider:** `src/core/hashing/tokenizer.ts`
  exports `createTiktokenAdapter(encoderInstance)`, which builds a `TokenizerAdapter`
  (`name: 'tiktoken_bpe'`, `isExact: true`) from a `cl100k_base`-compatible BPE encoder the
  caller supplies. There is no `tiktoken` package in `package.json` — no bundled provider,
  no new dependency. This is a deliberate zero-dependency design, not an omission: the
  adapter interface is shipped, and exact token counts are available to anyone who wires up
  their own encoder.
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

## v1.1.x — Audit Remediation Track — **✅ SHIPPED IN v1.2.0**

Ordered by (harm prevented) ÷ (effort), with dependency edges made explicit. Finding IDs refer
to `max_audit.md`; that document holds the evidence and reproduction commands, and is not
restated here. Every item marked *verified* was independently reproduced against a scratch build
on 2026-08-08.

### v1.1.1 — Green Tree & Correct Metadata (hours)

**Why first:** the working tree is red. Every fix below this line is unverifiable until it is
green, because a failing baseline cannot distinguish new breakage from pre-existing breakage.
The audit itself had to build to a scratch `outDir` for this reason.

| # | Finding | Work |
|---|---|---|
| 1 | **M2** — Phase C is half-migrated | `npx vitest run` → **2 failed, 37 passed** (*verified*). `src/core/validation/ast/index.ts` sets `CONTENT_TYPE_VALIDATORS.code = null` (correct — a TS lexer scores 39/40 false positives on Perl), but the two hazard-pinning tests still assert the old behaviour: `test/unit/declared-language.test.ts:128`, `test/unit/bench/evaluator.test.ts:151`. Update both to pin the *new* trap. Fix the three stale doc comments (`constructors.ts:90-92`, `:650-654`, `docs/phase-4b-pathless-code-scope.md` §6.3). **Rebuild `dist/`** — it still contains `code: tsValidator`, so `npm start` and the installed binary contradict the source. |
| 2 | **M3** — published license is wrong | `package.json:24` says `MIT`; `LICENSE:1` says Mozilla Public License 2.0 (*verified*). npm surfaces the `license` field as authoritative, so consumers read MIT and receive copyleft obligations. Set `"license": "MPL-2.0"`, fix `CLAUDE.md`'s "MIT", drop the README's "All rights reserved" sitting above an open-source grant. Record the MIT→MPL change in `DECISIONS.md`, which never mentions it. |
| 3 | **M10** — `bench` is broken for every installed user | `DEFAULT_HUMANEVAL_PATH` resolves against `process.cwd()`, and `package.json` `files` is `["dist","README.md",…]` with no `test/` (*verified*). A documented top-level command throws outside the repo. Ship the fixtures and resolve against `__dirname`. |
| 4 | **M4a** — stale README warning | The README still warns that the Gateway bypasses validation. False since Phase 1.0b. Delete it. *(The rest of M4 is deferred to the Scope Decision Gate — its remaining claims cannot be rewritten honestly until those decisions land.)* |

### v1.1.2 — Data Loss & Corruption (days)

| # | Finding | Work |
|---|---|---|
| 5 | **C1** — markdown deleted whole, all gates green | **The only finding that silently destroys user data.** Two changes: (a) `findUnwitnessedItems` (`drift-tracker.ts:315-321`) tests the **before** item for evidence — it must test the **surviving** witness set, so per-item `R_struct_content = 0` with `astMeasured: false` is a refusal regardless of what existed before; (b) drop `filepath:` from `R_struct` — `extractContentMarkers` already excludes it and is currently used only for the `structMeasured` boolean. Add a regression test that a markdown document survives. **⚠ This moves every published reduction number in the repo.** Freeze the corpus per `CLAUDE.md` first, and sequence it *after* v1.1.1 so you are moving from a green, rebuilt baseline. |
| 6 | **C2** — Gateway corrupts non-ASCII bodies | `server.ts:102` is `body += chunk` over raw Buffers (*verified*), so a multi-byte sequence split across a chunk boundary becomes two U+FFFD. This is the identical defect class Phase B (DECISIONS §35) just closed on the CLI, applied to the adapter that reads a socket instead of a disk — and worse there, because the mangled bytes are forwarded to a provider. Accumulate `Buffer[]`, concat on `end`, decode once, then apply the CLI's own round-trip check. Closes **L3** (O(n²) `byteLength` recompute) for free. |
| 7 | **M8 + M9** — env branches and credential echo | *Not in the audit's own recommended order; promoted here.* `TOKENDAMPER_MOCK_UPSTREAM` makes the proxy return the request as if it were the provider's completion; `NODE_ENV === 'test'` bypasses the missing-credentials 401. Response headers are built by spreading the **request's** headers, so `authorization` / `x-api-key` come back out — one env var from a live credential leak. Move both seams into `ProxyHandlerOptions` (which already exists and carries `upstreamOpenAiUrl`) and construct response headers explicitly. |

### v1.1.3 — Honest Instruments (days)

Nothing after this point is trustworthy until this lands: today's green signals come from checks
that did not run.

| # | Finding | Work |
|---|---|---|
| 8 | **H3** — the regression suite cannot detect total failure | `test/integration/bench.test.ts` Test 2 builds a private two-fixture set inline; Test 3 loads `humaneval` only — the one dataset whose fallback rate is 0 *because nothing happens* (*verified*). Meanwhile `codexglue` sits at 0.8 against a `maxFallbackRate: 0.0` baseline and is never run. Point both at `loadBenchmarkFixtures()`. Let them fail. Record measured truth as the baseline and ratchet. **Must follow C1**, or C1's pre-fix numbers get baked in permanently. |
| 9 | **M5a** — MCP's default call is a guaranteed no-op | *Not in the audit's own recommended order; promoted here — highest value-per-effort item in the audit.* `optimize_context`'s `inputSchema` has no `targetReductionRatio`, and nothing tells a caller a budget is mandatory. `maxInputTokens` *is* wired (`tools.ts:147-150`), so this is ~10 lines of schema plus a description that states the requirement — turning an entire advertised entry mode from no-op to functional. |
| 10 | **M5b** — dead rehydration path | `/<ELIDED:\s*ref=…>/` (`tools.ts:210`) cannot match `[TokenDamper Elided: ref=…]` (`stages/cleanup/session-dedup.ts:103`) (*verified*). Session-store rehydration through MCP has never worked. Fix the pattern or delete the path — shipping dead code that looks live is worse than either. **Blocks v1.4.0**, which extends this exact tool. |
| 11 | **M6** — the explainability trace does not explain | `trace/index.ts:24-29` hardcodes `durationMs: 0` and discards every stage's `metrics` and `notes`. Carry them through; measure real durations; fix the pruner's factually false *"All items fit within token budget"* note (it reports that for a 4,600-token file under a 10-token budget). For a product whose thesis is auditability this is the least trustworthy surface in the system. |

### ▼ Scope Decision Gate — decisions, not tasks (weeks)

These four questions determine whether v1.2.0–v2.0.0 are buildable as written. **Answer them
before scheduling any of it.** Each is a decision with a legitimate "narrow the product" answer.

| Q | Finding | The decision |
|---|---|---|
| **A** | **H5** — knapsack unreachable | Give the CLI a multi-item ingestion path (directory, manifest, conversation file) so the solver has a job — **or** move `planner/knapsack.ts`, `planner/cache-aware.ts`, `topology/git-inspector.ts`, `topology/dependency-graph.ts` and `topology/topology-scorer.ts` behind an explicitly labelled "not yet reachable" boundary. ~1,000 LOC and the whole of invariant 6 currently affect no output. **This answer decides whether v1.2.0 and Milestone 8 exist at all.** |
| **B** | **C3 + H1** — the Gateway | Not "fix C3." The `exec` token handoff is broken end-to-end (`TOKENDAMPER_GATEWAY_TOKEN` is written at `exec.ts:58` and read **nowhere** in `src/` — *verified*) **and** the mode saves 0 bytes on realistic traffic, because Phase A correctly concluded a marker the model cannot resolve is deletion, not reference. Either find a transform that survives the gates, or label the Gateway experimental and stop leading the README with it. **Decides v2.0.0's premise** and whether C4/M7 are worth doing. |
| **C** | **H4** — four documented knobs do nothing | **Answered 2026-08-10, DECISIONS §44: removed from the surface.** `--max-output-tokens`, `--max-latency-ms` and `--risk-tolerance` are gone, with their `TOKENDAMPER_*` variables and the MCP `riskTolerance` property; they are now a hard `Unknown argument`. The `OptimizationBudget` fields remain, because `ARCHITECTURE.md` pins that model as frozen, and each now carries a doc comment naming its consumer or stating it has none. **Two deliberately not removed:** `--target-reduction-ratio`, because it is the only budget flag every doc and example uses and making it a real proportional target is a planner change — still open, still named; and `--max-debt`, which unlike the others *is* wired to `DebtTracker` and merely arithmetically inert on the CLI. DECISIONS §30 established the principle for *which command accepts a flag*; §44 applies it to *whether the accepting command reads it*. |
| **D** | **H2** — 3 of 19 languages work | Twelve of nineteen recognised extensions cannot produce a non-zero reduction under any flag combination, because `selectElisionRegions` returns `[]` outside TypeScript/Python and `extractSymbols` yields nothing for Go/Rust/C/shell/SQL/CSS. Three languages is a defensible v1. Nineteen in `isCodeExtension` and `DeclaredLanguage` is not, because it invites a user to declare a language and receive a mute 0%. Narrow the accepted set, or report *why* a declared language cannot be optimized. |

**Follow-on work, sequenced by those answers:**

- **H6** — scope constraint extraction by content type; make retention per-item. 60% of all
  fallbacks involve `CONSTRAINT_DIRECTIVE_LOST`, a nine-word substring match over the joined
  bundle. ⚠ **C1 must land first:** this check is currently the *only* thing protecting markdown
  from deletion — this repo's own README survives solely because it contains "never" and "must".
- ~~**C4**~~ — **done, DECISIONS §45.** Content shape is carried on Gateway items and
  `core/elision` refuses to elide anything structured; egress maps by `payloadSlot` instead of
  array position; the Anthropic `system` item is mapped back. The note that it was "currently
  masked by H1, which is luck, not safety" was **half wrong** — measured, within-payload
  duplication is drift-exempt and shipped a `tool_result` block as a bare string with
  `fallbackUsed: false`. It was live, on the one path the Gateway saves anything on.
- **M7** — measure savings against the bytes on the wire rather than the newline-joined render.
  **Still open — the only audit item that is, and this conditional is why.** It read *"Only if B
  keeps the Gateway"*; B was answered in §41 (the Gateway is kept, labelled experimental), and
  nothing carried M7 across the answer, so it entered no wave and
  `docs/audit-remediation-status.md` went on to claim every item was closed. Re-verified open in
  full 2026-08-12; scope and the re-serialization caution are in that document's §6.
- ~~**M1 + M11**~~ — **done.** "Syntax validity" is now "bracket/quote integrity" in the README
  and `CLAUDE.md`, with a per-language table of what each validator does and does not catch,
  pinned by `test/unit/validator-guarantee.test.ts`; the phase narratives are retired to git
  history. The **4.1:1** figure was stale by the time it was acted on — measured before the
  cleanup it was **1.40:1**, and not because the docs shrank (they had grown to 726 KB) but
  because `src/` had grown faster. Counting the 33% of source that is comment prose, prose:code
  was ~2.6:1.

---

## v1.3.0 — `--target-reduction-ratio` Binds — **SHIPPED 2026-08-12**

The flag every document and example uses was an on/off switch: the planner read it as `> 0` and
nothing else read it at all, so `0.01` and `0.99` produced byte-identical output while compression
ran to exhaustion. `resolveTokenCeiling` now converts the ratio into an absolute token ceiling;
the pruner gates on it and `compression:token-hashing` stops there. DECISIONS §48, `CHANGELOG.md`.

Adherence is **partial and the limit is structural** — at target 30%, 21 of 66 reducing files land
in 25–35% and 23 still exceed 50%, because elision's smallest unit is one region. Sub-region
elision is what closes that and is the next piece of work
(`docs/audit-remediation-status.md` §7).

---

## Unnumbered — Context Selection Quality & Redundancy Elimination

> ### ⛔ Holds no version number, and that is the point.
>
> This section had v1.3.0 reserved while both of its headline deliverables were measured
> unbuildable, which meant a shipped behavioural change had to route around a release that cannot
> be built. **The number was released rather than renumbered again** — the same collision had
> already happened once, when v1.2.0 took the number this document reserved for this same release
> (DECISIONS §49). It gets a number when its preconditions hold.
>
> ### Both headline deliverables failed their preconditions when measured (2026-08-11).
>
> The H5 blocker this notice used to carry **is resolved** — `optimize` takes multiple paths and
> directories, and the knapsack prunes 15 of 31 files on `src/core` at `--max-input-tokens 4000`.
> The solver is reachable. What replaced that blocker is worse, and was found the same way:
>
> **BM25 hybrid scoring has no input.** There is no query concept anywhere in `src/`.
> `scoreBundleTopology(bundle, gitStatus, graph, budget)` takes none, and no entry mode carries
> one — `tokendamper optimize ./src` has no prompt at all. "BM25 keyword overlap against the
> active prompt query" would be scoring against nothing. **Where a query comes from is a product
> decision and has to be answered before any of this is written.**
>
> **MMR has nothing to eliminate.** The spec below ejects one of any pair scoring `> 0.90`.
> Measured over **1,486 real pairs**:
>
> | corpus | pairs | >0.90 | >0.50 | max |
> |---|---|---|---|---|
> | this repo’s `src/core` | 496 | **0** | 0 | 0.296 |
> | pip internals (45 files) | 990 | **0** | 1 | 0.500 |
>
> The instrument was validated before the result was believed — identical files score 1.000, a
> one-line edit 0.998, disjoint prose 0.000 — so the zeros are real. Lowering the threshold does
> not rescue it: the single pair above 0.50 is pip’s `download.py` ~ `wheel.py`, two genuinely
> different commands, and ejecting one would be deleting a file the user asked for rather than
> removing redundancy.
>
> **Why the premise fails.** MMR assumes near-duplicate items. That shape occurs in
> *conversational* context — the same file pasted twice, repeated tool results, overlapping
> retrieved chunks — not in a directory of source files, where every file is deliberately
> distinct. The place it does occur is the Gateway, which plans only `cleanup:session-dedup`,
> where exact-hash duplicates are already handled.
>
> Built as specified, both would be ~1,000 lines of correct code with no observable effect on
> any output the product can emit — the exact condition the audit found in H5. **Do not start
> this release on the strength of the spec below.** Either find a query source and a corpus that
> actually contains near-duplicates, or re-scope to the alternatives in "What to do instead".

### What to do instead — preconditions verified as holding

1. **Widen elision beyond TypeScript/JavaScript and Python.** H2 measured **3 of 17** languages
   reducible; a Go or Java region selector converts whole corpora from 0.00% to something. The
   largest real-world gain available, and the gate (`supportsRegionElision`) is already the
   single place that decides.
2. **Sub-region elision.** `--target-reduction-ratio` is now a real target (§48) but adheres
   only partially: elision’s smallest unit is one region, files typically have one dominant
   region (58%, 61%, 83% measured), and at target 30% **23 of 66** reducing files still exceed
   50%. Finer granularity is what closes that.
3. **Per-item drift.** Phase 1c repairs AST and constraint failures per item; drift remains
   bundle-scoped, so a drift failure still reverts everything.

---

### The original specification, retained for reference

**Read the notice above first.** The spec below is unchanged from when it was written and is
**not** ready to implement.

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

## v1.4.0 — Sub-Region Elision — **SHIPPED 2026-08-12**

Elision's smallest unit was a whole function body, which is why v1.3.0's target adhered only
partially. `splitRegionIntoStatements` divides a region at depth-0 boundaries, so every candidate
is bracket- and quote-balanced. Measured per-row over one frozen corpus at target 0.3: rows above
50% achieved **34 → 18**, rows reducing **95 → 99**, **zero** new fallbacks and **zero** files
that stopped reducing. 522 of 576 rows byte-identical — subdivision is confined to the ceiling
path. DECISIONS §50.

Still open on this axis: 18 rows exceed 50% because a single *statement* is dominant (an
83%-of-file span in `python-validator.ts`). Dividing that needs elision inside a control-flow
block, which is a different question from dividing a body.

---

## Unnumbered — AST Code Folding ("Fast" vs "Deep") & Cache Alignment

> **⚠ Re-scoped by audit. Fast mode is substantially already shipped.** This release was written
> as though body folding did not exist. It does: `selectElisionRegions` (`elision/regions.ts:382-384`)
> already folds function bodies on TypeScript, JavaScript and Python, and `FUNCTION_HEADER`
> (`regions.ts:50`) is precisely the "distinguishes top-level declarations from control-flow
> blocks" discriminator this release schedules as new work — it is combined with
> `CONTROL_FLOW_HEADER` to exclude `if`/`try`/class bodies. The audit rates this among the
> project's genuinely good work (`max_audit.md` §4.4). **Re-derive Fast mode as an increment over
> `regions.ts`, not as a new subsystem**, and measure what is missing before scheduling it.
>
> Two further corrections, **both since superseded — read the updates, not the originals:**
> - ~~**`cache_control` injection is blocked on question A (H5)**~~ — **no longer.** Prefix
>   locking is reachable since §43; `optimize` takes multiple paths and directories. The
>   remaining precondition is a different one and it still binds: 1,024-token quantization is
>   only meaningful with `isExact: true`, which needs a caller-supplied `cl100k_base` encoder.
>   The default `EnhancedHeuristicTokenizer` has 24% mean absolute error, so boundary placement
>   under it is approximate by construction.
> - ~~**The `R_AST = 1.0` target below is not the guarantee it appears to be**~~ — **the
>   arithmetic it describes was fixed.** `R_struct` is no longer pinned at 1.0 for code: §40
>   computes it over `extractContentMarkers`, which excludes `filepath:`, and a ratio whose
>   before-set is empty no longer votes at all — its weight is redistributed. For code
>   `S_k = 1 - R_AST`, so the maximum symbol loss that can pass fell from **66.7% to 40%**.
>   `R_AST` still defaults to 1.0 on an empty symbol set, but §28 and §33 turned that case into
>   a refusal rather than a silent pass. State folding's retention target against the current
>   metric; the "post-C1" caveat is satisfied.

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
- **Exact mode:** requires the caller to construct `createTiktokenAdapter()` (v1.1.0) with
  their own `cl100k_base`-compatible encoder — TokenDamper does not bundle one. Only then
  does `isExact === true` and boundary placement become precise.
- **Best-effort mode (default):** the zero-dependency `EnhancedHeuristicTokenizer`
  (`isExact: false`) is what runs unless a caller has wired up their own encoder — boundaries
  are approximate. State this explicitly to users; don't imply the default estimator
  delivers exact placement.

### Performance verification targets
- **Benchmark target (via `src/bench`):** Fast Mode `<1ms`/file; Deep Mode `~15ms`/file. Unvalidated until built — treat as targets, not committed numbers.

---

## Unnumbered — Granular Sub-Query Re-hydration & MCP Tool Extension

> **✅ Unblocked — M5b shipped in Wave 2 (DECISIONS §44).** This release adds a `query` field to
> `rehydrate_context`, and that tool's session path had **never worked**: its regex
> `/<ELIDED:\s*ref=([A-Za-z0-9_-]+)[^>]*>/` could not match the marker the product actually
> emits. Both sides now derive from `src/core/elision/marker.ts` —
> `renderSessionElisionMarker` and `SESSION_ELISION_MARKER_PATTERN` — so the emitter and the
> matcher cannot drift apart again, which is the defect rather than the regex.
>
> **What remains is design, not a blocker.** The targeted-match response is a genuinely different
> return type from full rehydration, and the note below is right that it must be designed rather
> than fall out of adding a field. Sequence it behind the elision work in
> `docs/audit-remediation-status.md` §7: partial un-elision is most valuable once elision is
> finer-grained than one whole region.

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

> **⚠ Question B is answered (DECISIONS §41) — and the answer was "experimental", which is not
> the same as "proceed".** The half that was broken is fixed: `tokendamper exec` reaches its own
> gateway, and the mode says what it actually does. `TOKENDAMPER_GATEWAY_TOKEN` was written at
> `exec.ts:58` and read nowhere in `src/`, so the server 401'd every request the documented
> command produced. Interception is by **base URL**, not `HTTP_PROXY` — it is an origin server
> and implements neither absolute-form request URIs nor `CONNECT`, and the README now says so
> rather than leading with the Gateway.
>
> **The half that is not fixed is the premise, deliberately (invariant 8).** Cross-turn dedup of
> a sole copy still saves **0 bytes**, because the consumer is a stateless provider API with no
> rehydration mechanism, so the marker is deletion rather than reference.
> `test/integration/gateway-dedup-reality.test.ts` pins that: if a cross-turn saving ever
> appears, either resolvability was implemented or the gate was relaxed. Within-payload dedup
> does save, and is the one path C4 was live on.
>
> **So the sequencing constraint stands even though the gate is open.** A Prometheus `/metrics`
> endpoint on a pass-through that saves nothing cross-turn instruments nothing — and per **M7**,
> still open and re-verified 2026-08-12, the numbers it would export
> (`rawTokens`/`optimizedTokens` from `summary.tokenEstimate`) measure the bundle render, not the
> bytes forwarded. **Fix the measurement (M7) before exporting it.**

**Core objective:** enterprise-grade proxy integration and multi-agent remote access.

- **MCP over Streamable HTTP/SSE:** extend `McpStdioServer` (`src/adapters/mcp/server.ts`) to support SSE and HTTP POST transports alongside stdio — enables remote containers, Cursor, Claude Code, and cloud agents over the network. (Note: this is distinct from the Gateway's existing upstream-SSE-passthrough — that's unrelated proxy behavior already in place, not MCP transport.)
- **LiteLLM & AI proxy guardrail plugin:** in-process pre-call guardrail integration (`guardrails: tokendamper`) for LiteLLM and open-source AI proxy gateways.
- **Gateway observability suite:** Prometheus `/metrics` endpoint + structured JSON access logging in `src/gateway/server.ts`.

---

## Version Summary

**This table was a full renumbering behind the chain at the top of the document until
2026-08-12** — it still listed v1.1.1/v1.1.2/v1.1.3 as "Next — blocking" after all three had
shipped inside v1.2.0, and mapped every later release to the number it held before the
remediation track was inserted. Corrected below; the numbering now matches the chain.

| Release | Focus | Key Deliverable | Benchmark Target | Status |
|---|---|---|---|---|
| v1.0.3 | Prior release | 0/1 Knapsack, AST validators, debt/drift ledgers | Current test suite | Shipped |
| v1.1.0 | Prior release | Heuristic tokenizer, `configSchemaVersion`, Git TTL cache | Sub-ms cache lookups | Shipped @ `807f6f0` |
| ~~v1.1.1~~ | Green tree | M2, M3 license, M10 bench packaging, M4a README | `npm test` green; `dist` rebuilt | ✅ **in v1.2.0** |
| ~~v1.1.2~~ | Data loss | C1 drift measurement gate, C2 Gateway `Buffer`, M8/M9 | Markdown survives; Gateway byte-identity | ✅ **in v1.2.0** |
| ~~v1.1.3~~ | Honest instruments | H3 bench baseline, M5a MCP budget, M5b rehydrate marker, M6 trace | Suite can fail; trace carries real metrics | ✅ **in v1.2.0** |
| ~~Gate~~ | Scope decisions | A: H5 · B: C3/H1 · C: H4 · D: H2 | Decisions recorded in `DECISIONS.md` | ✅ **all four answered, §41–§46** |
| v1.2.0 | Audit remediation | The whole remediation track + Phase 1c | 614 tests green | Shipped 2026-08-11, npm `latest` |
| v1.3.0 | Prior release | §48 — `--target-reduction-ratio` is a real ceiling | 21 of 66 files on target at 0.3 | Shipped 2026-08-12 |
| **v1.4.0** | **Baseline (shipped)** | §50 — sub-region elision; the target adheres | rows >50%: 34 → 18, zero regressions | **Shipped 2026-08-12** |
| *unnumbered* | Selection quality | BM25 + graph hybrid scorer, dual-path MMR | `<10ms` pipeline selection | ⛔ **Both preconditions measured false** — holds no number |
| *unnumbered* | Folding & cache | Fast (zero-dep) vs Deep (AST) mode, `cache_control` | `<1ms` Fast / `~15ms` Deep | ⛔ Fast largely shipped; cache needs an exact tokenizer — **holds no number** |
| *unnumbered* | Retrieval | `rehydrate_context` with sub-query matching | Targeted line extraction | ✅ Unblocked (M5b shipped); response shape still to design |
| v2.0.0 | Ecosystem | Streamable HTTP/SSE MCP, LiteLLM plugin, Prometheus metrics | High-throughput multi-agent proxy | ⚠ B answered *experimental*; **M7 before exporting metrics** |
| Milestone 8 | Caching | MCP Schema Deduplication & Cache-Aligned Knapsack | 100% Provider Cache Hit Rates | ⚠ A answered — knapsack reachable; needs an exact tokenizer |
| Milestone 9 | Guardrails | Agent Loop Circuit Breaking & Critical Atom Recall Tracking | $S_k \le 0.40$ enforcement | ⚠ C1 + H6 both shipped; re-derive against the current metric |

**Not in this table, because it is not a release: `docs/audit-remediation-status.md` §7 carries
the near-term work** — sub-region elision, widening elision beyond three languages, per-item
drift, and M7. Those have measured preconditions that hold, which the v1.3.0 row does not.

### Measured starting position (2026-08-07, `f93c385`)

The numbers any of the above will be judged against. Source: `max_audit.md` Appendix B.

| Metric | Value |
|---|---|
| CLI reduction, own TS corpus @ `trr=0.5` | **14.04%** aggregate — 42 of 64 files (65.6%) at exactly 0% |
| Shipped `bench`, all fixtures | **0.0%** reduction, **40%** fallback, "100% syntax pass" |
| Gateway, cross-turn dedup | **0 bytes saved**, 100% fallback |
| Languages reaching non-zero reduction | **3** of 19 declared (+ markdown, which is C1, not a feature) |
| Leading fallback cause | `CONSTRAINT_DIRECTIVE_LOST` — 24 of 40 |
| Determinism / CLI fail-open byte-identity | ✅ holds |

---

## Milestone 8: MCP Schema Deduplication & Cache Alignment

> ~~**⛔ Blocked on Scope Decision Gate — question A (H5).**~~ **A is answered and this half is
> unblocked (DECISIONS §43).** "Cache-Aligned 0/1 Knapsack Allocation" is invariant 6, and
> invariant 6 was unimplemented in practice — `applyCacheAwarePrefixLocking` and
> `solve01Knapsack` were exercised only by unit tests building bundles through
> `createBundleFromItems`, which no production code called. `optimize` now takes multiple paths
> and directories: on `src/core` at `--max-input-tokens 4000`, 15 of 31 files are pruned and
> 20,540 tokens saved. A shipping path can affect the cache hit rate.
>
> **The exactness precondition still binds, and it is now the whole gate.** 1,024-token
> quantization is only meaningful with `isExact: true`, which requires a caller-supplied
> `cl100k_base` encoder. The default
> `EnhancedHeuristicTokenizer` has 24% mean absolute error — **worse than the `ceil(len/4)`
> estimate it replaced** (17%). Boundary placement under the default is approximate by
> construction.

**Core objective:** Ensure provider cache hit rates via strict prefix pinning.
- **MCP Schema Deduplication:** Convert tool definitions into deterministic, sorted JSON structures at prompt position 0. Use content-addressed hashes to anchor MCP schemas without blowing up context windows or cache blocks.
- **Cache-Aligned 0/1 Knapsack Allocation:** Evaluate item weights in 1,024-token quantizations. Ensure items selected by the knapsack solver preserve exact prefix horizon ordering.

## Milestone 9: Safety & Drift Guardrails

> **⚠ Re-derive against the current metric — C1 and H6 have both shipped, so the two blockers
> below are closed and their replacements are smaller.** Retained with the corrections inline,
> because what each one warned about is still the reason to measure before building:
>
> - ~~**The composite $S_k$ with a new $w_{\text{atom}} \cdot R_{\text{atom}}$ term adds a third
>   weight to a formula whose second term does no work.**~~ **Fixed in §40.**
>   $R_{\text{struct}}$ is no longer pinned at 1.0 for code: it is computed over
>   `extractContentMarkers`, which excludes `filepath:`, and a ratio whose before-set is empty no
>   longer votes — its weight is redistributed rather than defaulting to perfect retention. The
>   maximum symbol loss that can pass fell from 66.7% to **40%**. Note the fix this milestone
>   proposed (drop `filepath:`) was measured **inert on its own**: an empty marker set defaulted
>   $R_{\text{struct}}$ straight back to 1.0. A third term is now addable — but derive its weight
>   against the post-§40 formula, not the one described here.
> - ~~**"Verify imperative directives are never lost" already ships, and it is the leading cause
>   of 0% reduction."**~~ **Scoped in §42 (H6) and made per-item in §47 (Phase 1c).**
>   `CONSTRAINT_DIRECTIVE_LOST` was a nine-word substring match over the joined bundle with no
>   attribution, accounting for 24 of 40 fallbacks and firing on `required: ['rawInput']` in a
>   JSON schema literal. Imperatives are now read in comments and prose rather than expressions,
>   and a failure names its item and reverts only that item. `TD_PRESERVE` can be formalized
>   without hardening a defect into a spec — measure the current fallback mix first, since the
>   24-of-40 figure predates both fixes.
>
> The **Agent Loop Circuit Breaking** half is unaffected by the above and can proceed independently
> — though note `DebtTracker` is arithmetically inert on the CLI today: with no ledger, maximum
> achievable $D_k$ is **35** against a default threshold of **75** (*verified: `debtScore: 35`*).

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
- **Baseline correction:** this document previously stated `Baseline: v1.0.3 (current)` and listed the entire v1.1.0 section as upcoming work. A ground-truth check against `git tag`, `CHANGELOG.md`, and source confirmed `v1.1.0` is tagged (`807f6f0`) and shipped — `configSchemaVersion` (`src/config/types.ts`), the Git workspace TTL cache (`src/core/topology/git-inspector.ts`), and a heuristic tokenizer are all present in source. Baseline corrected to v1.1.0 and the v1.1.0 section marked shipped rather than removed, since its optional tiktoken/`cl100k` adapter sub-item is not independently confirmed.

### Revision 2026-08-08 — audit remediation track inserted

Basis: `max_audit.md` (2026-08-07, commit `f93c385`), whose load-bearing findings were
independently reproduced against a scratch build before this document was changed. What changed
and why:

- **A blocking v1.1.x track and a Scope Decision Gate were inserted ahead of v1.2.0.** `CLAUDE.md`
  has carried *"Do this before roadmap feature work"* without the roadmap reflecting it; the
  instruction now lives where the scheduling happens. Release numbering v1.2.0–v2.0.0 was
  deliberately **left unchanged** so existing cross-references (e.g. v1.3.0 `cache_control` →
  v1.1.0 `createTiktokenAdapter`) stay valid — the remediation work is versioned as patch
  releases against the shipped baseline instead of renumbering the chain.
- **Three items absent from the audit's own recommended order were promoted into the track:**
  M8+M9 (a credential echo one env var from being live), M5a (~10 lines that convert the entire
  MCP mode from guaranteed no-op to functional), and M10 (`bench` throws for every installed
  user). The audit's §5 lists 14 items and omits M1, M5, M7, M8, M9, M10 and all nine L-findings.
- **M2 was moved from the audit's #4 to first.** The tree is red (2 failing tests, reproduced), so
  every subsequent fix would land on a baseline that cannot distinguish new breakage from old.
- **v1.3.0 was re-scoped rather than gated.** Its "Declaration Boundary Detector" was scheduled as
  new work; `FUNCTION_HEADER` + `CONTROL_FLOW_HEADER` in `elision/regions.ts:50,384` already
  implement that discriminator, and `selectElisionRegions` already folds bodies on TS/JS/Python.
  This is a case of the roadmap scheduling something that shipped — the same class of error the
  original Phase-1 correction above records.
- **Milestone 9 was flagged for re-derivation, not deferred.** Its proposed
  $w_{\text{atom}} \cdot R_{\text{atom}}$ term would add a third weight to a formula whose
  $R_{\text{struct}}$ term is a pinned constant for code, and its `TD_PRESERVE` directive tracking
  is a formalization of `CONSTRAINT_DIRECTIVE_LOST` — currently the single largest cause of 0%
  reduction. Both need C1 and H6 first.
- **A "measured starting position" table was added to the Version Summary.** Every benchmark target
  in this document was previously stated without the number it improves on. Per audit §3.3, a
  target with no baseline is the same shape as a green check that never ran.
