# CLAUDE.md — TokenDamper

Context file for Claude Code. Read this before touching the codebase.

## What this is

TokenDamper is a **deterministic context optimization engine** for AI coding assistants
(Claude Code, Codex, Gemini CLI, Aider). TypeScript, CommonJS, Node >=20.19, MPL-2.0.
It sits between a developer tool and an LLM provider API and reduces token count while
preserving **bracket/quote integrity** and provider prompt-cache alignment.

**Not "syntax validity" — audit M1, closed by measurement.** The TypeScript "AST-lite validator"
builds no AST; it is a lexer detecting unbalanced brackets and unterminated strings. Probed
against the shipped code, it *passes* `const x = ;`, `import from "x";`, `let 123abc = 5;`,
`const a = 1 +++++ 2;` and plain English prose, and fails only on `super(; }`. Python is
meaningfully stronger (missing colons, malformed `def`, bad dedent) and still passes prose; JSON
is a real parser and is correct. `test/unit/validator-guarantee.test.ts` pins every one of those
as a characterization test, and the README carries the same table — if you strengthen a
validator, that test fails on purpose and both need updating together.

Three entry modes: **CLI**, **local Gateway HTTP proxy**, **MCP server (stdio)**.

The differentiator vs. LLMLingua/Headroom/summarizers is *determinism + syntactic
guarantees + fail-open fallback* — not the raw reduction percentage. Any change that
weakens determinism or the fallback guarantee defeats the point of the project.

## Commands

Standard `npm` scripts (see `package.json`). Run the CLI: `node dist/src/cli/main.js` (or `npm start`), bin name `tokendamper`.

```
tokendamper optimize <input-file|->
tokendamper optimize <file> <file> ...      # multi-item bundle
tokendamper optimize <directory>            # walked, sorted, filtered
tokendamper bench [dataset-path]
tokendamper exec -- <command>
tokendamper mcp
```

**Flags are command-scoped and enforced (DECISIONS §30).** `SUPPORTED_FLAGS` in
`src/cli/main.ts` is keyed by what `runCli` actually consumes; anything else is a parse error
naming where it does apply. `bench` takes the config/budget flags plus `--report-json` and
`--quiet`; `mcp` takes the config/budget flags (it silently took **none** before — its branch
read `parsed.configPath` and the parser never set it); `exec` forwards everything to the child.

**Second critical flag, for stdin:** `--language`. Without it a piped payload has no filename,
classification falls to content probes, no validator covers the item and reduction is ~0%
(0.07% on this repo's TypeScript vs 19.27% with it, cl100k, DECISIONS §29 — a 2026-08 figure on
a smaller corpus; for current numbers use the baseline in `docs/audit-remediation-status.md`,
never a remembered one). `--input-name` declares a filename instead and is equivalent. Pathless
MCP calls take `language`/`path` on `optimize_context`. Unrecognized names are rejected, never
ignored.

**Critical:** with no budget flag, the planner returns `pass_through` with an empty
`stageIds` array — zero stages run and reduction is guaranteed 0%. This is not a bug;
it has repeatedly been mistaken for one (see benchmark Issue 1). Always pass a budget
when testing reduction.

**`--target-reduction-ratio` is a real target as of DECISIONS §48 — the numbers moved, on
purpose.** It used to be an on/off switch: the planner read it as `> 0` and nothing else read it,
so `0.01` and `0.99` produced byte-identical output. Now `resolveTokenCeiling`
(`src/core/budget/`) converts the ratio into an absolute token ceiling against the input bundle,
`pruning:topology-pruner` gates on that ceiling instead of `maxInputTokens` (it used to bypass
itself entirely when only a ratio was set), and `compression:token-hashing` **stops** once the
ceiling is met.

Two consequences that will otherwise look like regressions:

- **Corpus aggregates fell and that is the feature working.** The harness measures at ratio 0.3.
  Python file went 23.14% → **20.26%**, TypeScript file 23.03% → **17.57%** — while *fallbacks
  fell* (python 14 → 13) and *reduced counts rose*. Runs that used to overshoot to 44–69% now
  stop near 30%, so more files survive validation and each contributes less. **Compare per-file
  adherence, not the mean.**
- **Adherence is partial, and the limit is structural.** Elision's smallest unit is one region —
  usually a whole function body — and files typically have one dominant region: measured at 58%,
  61% and 83% of the file across three of this repo's own sources. At target 30% over the frozen
  corpus, 21 of 66 reducing files landed in 25–35%, 13 in 35–50%, and **23 still exceeded 50%**
  because the dominant region cannot be taken in part. Closing that needs sub-region elision and
  is not attempted. `test/unit/target-reduction-ratio.test.ts` pins this as a documented limit
  and deliberately does **not** assert `achieved <= target`.

Region selection is **smallest-first when a ceiling is set** (positional order otherwise), chosen
by measurement: positional order takes the dominant region first, which made 0.1, 0.2, 0.3 and
0.5 all produce the same 55.2%. Kept regions are re-sorted into positional order before splicing,
because `elideRegions` walks a forward cursor and refuses out-of-order ranges.

Config file: `tokendamper.config.json` (not `.tokendamperrc`).

## Architecture

Linear pipeline. **No DAG.** The architecture is frozen — `ARCHITECTURE.md` describes
what must be implemented, not what should be redesigned.

```
Raw Input
  -> Adapter (CLI / Gateway / MCP)
  -> OptimizationRequest -> ContextBundle + OptimizationBudget
  -> Stateless 0/1 Knapsack Planner
  -> Linear Engine (stages in order)
  -> Validators (ConfidenceLedger, DebtTracker, DriftTracker)
  -> Fallback if unsafe
  -> Output + explainability trace (stderr / JSON)
```

| Path | Role |
|---|---|
| `src/core/model/` | Frozen immutable domain model. Source of truth. |
| `src/core/validation/` | Validators + AST-lite validators under `validation/ast/` (ts, python, json) |
| `src/core/fallback/` | Fallback-to-raw path |
| `src/core/hashing/` | `TokenHasher` (`<BLOCK_HASH:sha256>` placeholders), tokenizer |
| `src/core/ledger/` | `ConfidenceLedger`, `DebtTracker` (D_k), `DriftTracker` (S_k) |
| `src/adapters/mcp/` | stdio JSON-RPC 2.0 server + `tools.ts` (`TOOL_DEFINITIONS`) |
| `tokendamper-benchmark/` | Python harness comparing TokenDamper vs. Headroom |

Knapsack-mode stage order (from `src/core/planner/index.ts`):
`cleanup:constraint-preservation` → `pruning:topology-pruner` →
`compression:token-hashing` → `compression:delta-compression`.
Note `cleanup:session-dedup` is in the registry catalog but **not** in this list — it never
runs via the CLI or MCP paths (both call `core/engine.optimize()`, which only executes
`plan.stageIds`). It runs only under the `session_dedup` planner mode, which the Gateway
pins via `config.planner.defaultMode`; that mode plans exactly `['cleanup:session-dedup']`
and takes precedence over budget-derived knapsack selection.

## Invariants — do not break these

1. **Stages are pure, deterministic, side-effect free.** Same input → same bytes out.
2. **Validators must not mutate the bundle.**
3. **Fallback means the user gets usable output, never a crash** (fail-open).
4. **Only `stage-registry` imports concrete stage implementations.**
5. **Drift threshold `S_k <= 0.40`** triggers `SEMANTIC_DRIFT_EXCEEDED` and fallback
   (`src/core/validation/index.ts`, override via `--max-drift`).
6. **Cache alignment:** selection preserves pinned-prefix ordering and 1,024-token block
   boundaries. Reordering the prefix busts provider prompt caches, which usually costs
   more than the tokens saved.
7. **Pinned items (`isPinned`) bypass the knapsack and are always included.**
8. **The Gateway plans exactly one stage (`cleanup:session-dedup`) on purpose** — and that
   stage saves **0 bytes** on ordinary cross-turn traffic, also on purpose. Do not widen the
   stage list, and do not "fix" the 0. The original rationale was Issue 2 containment; the
   live blocker is now drift (`token-hashing` measures `S_k = 0.60` on JSON). Cross-turn
   dedup of a **sole** copy is refused because the consumer is a stateless provider API with
   no rehydration mechanism, so the marker is deletion, not reference. Within-payload dedup
   works and is exempt via `resolveRecoverableElisions`. Gateway mode is documented as
   **experimental** on that basis (DECISIONS §41), and
   `test/integration/gateway-dedup-reality.test.ts` pins the measurement: if a cross-turn
   saving ever appears, either resolvability was implemented or the gate was relaxed.
9. **The Gateway maps `finalBundle` back onto the parsed payload, never `emittedOutput`** —
   `emittedOutput` is a *rendered stream for a human or a model*, not an API payload, so using
   it reintroduces Issue 5. (It used to be a newline-joined blob; since §43 it is a
   `==> path <==` delimited envelope for multi-item bundles and bare content for one item.
   Neither is valid JSON for a provider, so the invariant is unchanged — only its reason is
   restated.)
10. **When a check passes, confirm it ran.** A green result from a check that never executed
    is worse than a red one — it has happened **nine** times in this project already. Read
    `AstValidatorResult.validated` and `trace.astCoverage`, not `valid`, when the question is
    whether anything looked (DECISIONS §23). The same now applies to drift: read
    `trace.driftCoverage` (`measured`, `astMeasured`, `unwitnessedItems`), **not `driftScore`**
    — `0.0000` means "retained everything" and "found nothing to look at" indistinguishably.
    The ninth and tenth instances are **both closed by Phase A** (DECISIONS §33 and §34), and
    it took both halves — read this if you are tempted to revert either.
    - **§33 — the measurement gate no longer asks whether a validator was watching.** Any item
      that changed, was not pruned away, and yields neither symbols nor content markers is
      refused. §28 had scoped that rule to validator-covered items to protect prose; measured,
      the scope protected the wrong population. All 25 real markdown documents carry content
      markers and were never in reach of it, while what it excluded was uncovered **code** —
      `Unicode_Collate_Locale_ja.pl` at **57,037 → 19 tokens (100%)** on the *file-argument*
      route, `S_k = 0`, `measured: false`, `fallbackUsed: false`, because nothing covers `.pl`.
      `DriftReport` now carries `measurementGate` and `retentionGate` separately, so `0.400`
      stops being one comparison arbitrating two opposite configurations.
    - **§34 — a bare `#` line no longer makes a document.** That is what closed §32's
      "the coverage report itself is the thing that lies": `tclConfig.sh`'s 79 "headings" were
      all `#` shell comments, and they **forged the very evidence §33 checks**. Shell over stdin
      was byte-identical under §33 alone. §34 without §33 would merely have moved those files
      from the forged failure to the honest one. A *shape* discriminator (not the count
      threshold §32 imagined — counts point the wrong way) takes code misclassified as markdown
      from **114 of 264 files to 12** with **zero** prose casualties.
    - **Measured end state:** every uncovered-language bucket goes to **0.00%** reduction, and
      **258 of 258** rows in the AST-covered and prose buckets are **byte-identical** to
      baseline. `docs/phase-0-measurement-baseline.md`, DECISIONS §33–§34. [retired]
    - **The Gateway keeps within-payload dedup and loses cross-turn sole-copy dedup.**
      `resolveRecoverableElisions` substitutes recoverable elisions back before the gate runs,
      so they are structurally invisible to it. The lost case is the one §9 of
      `docs/phase-1-stabilization-summary.md` already called a marker the model cannot resolve. [retired]
    - **Still open:** a symbol-free code file the **pruner** removes is invisible to drift (the
      `!after` branch is a deliberate exemption — selection is not elision); and
      `isCodeExtension` remains a hardcoded 19-entry list that decides whether a real source
      file is validated at all. `.pl`, `.tcl`, `.rb`, `.lua`, `.swift`, `.kt` are outside it.
      What changed is that falling outside it now yields a **refusal** rather than a silent
      deletion.
    Historical, and still worth knowing: Phase 4b.1 (§29) established that "validator-covered"
    was itself route-dependent — the same barrel file was deleted unwitnessed over stdin because
    nothing covers a pathless item. §33 makes coverage irrelevant to the refusal, so both routes
    now behave the same; what a declaration still buys is *coverage*, not the refusal.

## Where the project actually is (read this first)

**v1.2.0 shipped 2026-08-11** — tagged, GitHub release, and published to npm as `tokendamper@1.2.0`
(`latest`), carrying Phase 1c and the three decisions the audit deferred. `DECISIONS.md` §36–§48
carries the reasoning; `docs/audit-remediation-status.md` is the index and is the doc kept current.

**v1.3.0 shipped 2026-08-12** — §48 (`--target-reduction-ratio` binds, which moves every reduction
number in the docs) and §49. Current measured baseline: python file **20.26%**, typescript file
**17.57%** (288 files, both routes, `5c7919b`) — status doc §2, re-measured 2026-08-12, not the
Wave 2 figures a prior session may quote.

**There is no `npm run format`, and do not add one back without reading DECISIONS §49.** It was
`prettier --check .`, it had never passed, and nothing invoked it — CI and `prepublishOnly` both
run typecheck, lint, build, test. It failed on 148 files for two independent reasons (CRLF vs
prettier's `endOfLine: "lf"`, plus ~5,118 lines of real drift in `src/`), so making it pass meant
rewriting the repository including the in-source commentary. `eslint` is the style gate.

**Version numbers in `ROADMAP.md` are reservations and two have been wrong.** §49's rule: a
release whose preconditions are measured false holds **no** number. "Context Selection Quality"
is now unnumbered for that reason — do not renumber the chain to make room for it.

**One audit finding is still open: M7.** This file and the status doc both claimed every finding
was closed; M7 was gated in the roadmap behind *"only if question B keeps the Gateway"*, B was
answered in §41, and nothing carried it across the answer. Gateway savings are still computed
from `summary.tokenEstimate` — the bundle render — rather than the bytes on the wire, and nothing
asserts the rewritten body is no larger than the original. Status doc §6 has the scope, including
why the re-serialization half is not a metrics fix.

The roadmap's feature gate is open. **But two of the next release's headline deliverables failed
their preconditions when measured, and that is recorded rather than discovered again:**

- **BM25 hybrid scoring has no input.** There is no query concept anywhere in `src/` —
  `scoreBundleTopology(bundle, gitStatus, graph, budget)` takes none, and no entry mode carries
  one (`tokendamper optimize ./src` has no prompt at all). Scoring "against the active prompt
  query" would be scoring against nothing. **Decide where a query comes from before writing any
  of it.**
- **MMR has nothing to eliminate.** The spec ejects one of any pair scoring `> 0.90`. Measured
  over **1,486 real pairs** — 496 in this repo's `src/core`, 990 in the 45-file pip corpus —
  **zero** pairs exceed 0.90. Maxima are 0.296 and 0.500. The instrument was validated first
  (identical files → 1.000, one-line edit → 0.998, disjoint prose → 0.000), so the zeros are real.
  Lowering the threshold makes it dangerous rather than useful: the one pair above 0.50 is pip's
  `download.py` ~ `wheel.py`, two genuinely different commands.

Both would be ~1,000 lines of correct code with no observable effect — the H5 condition again.
MMR's premise fits *conversational* redundancy (the same file pasted twice, repeated tool
results), which is Gateway traffic; the Gateway plans only `session-dedup`, and exact duplicates
are already handled there.

**Candidates with preconditions that do hold today:** widen elision beyond TS/JS/Python (H2
measured 3 of 17 languages reducible — the largest real-world gain available); per-item drift, to
finish what Phase 1c started; sub-region elision, which is what would make
`--target-reduction-ratio` adhere tightly rather than partially.

## Known bugs — historical per-issue record

> **Start at `docs/audit-remediation-status.md`.** It carries what is merged, the measured corpus
> baseline, what remains, and the traps this codebase has for anyone changing it. The entries
> below are the older per-issue history and **all of them are now closed**; the status doc is the
> one that is kept current.
>
> Waves 0, 1, 2 and most of 3 are merged (DECISIONS §36–§44). **Wave 2 is done** — the MCP entry
> mode is no longer a guaranteed 0% no-op (`optimize_context` takes `targetReductionRatio`, and
> reports `budgetApplied` when it does not), MCP session rehydration matches a marker the product
> actually emits, the Gateway no longer reads test seams from `process.env` or returns the
> caller's credentials as response headers, `bench` runs when installed, and three knobs that did
> nothing are gone from the surface. **C4 is closed too (§45).** The three decisions (H2, M1, M11)
> are taken (§46) and Phase 1c is done (§47). ~~Every task-shaped audit item is done~~ — **M7 is
> not**, and was never in a wave; see the note above and status doc §6. That sentence is left
> struck through rather than deleted, because "every item is done" is precisely the kind of claim
> this project keeps having to correct by measuring.
>
> §45 is worth reading even if you never touch the Gateway: C4 was recorded as "masked by the
> drift gate — that is luck", and measurement found it **live** on within-payload duplication,
> which drift exempts and which is the only case the Gateway saves anything on. That is the third
> audit *reachability* claim this project has corrected by measuring (§40, §42, §45). Do not defer
> a defect because a doc says it is latent.
>
> Two things Wave 2 established that outlive it: a 0% result now has to say whether anything ran
> (this is invariant 10 applied to budgets, and H2 is the same question one layer down), and the
> corpus A/B method in the status doc §2 is the one that caught its own two false greens.

Both documents that used to hold the detail here — `tokendamper-headroom-known-issues.md` and
`purposed architecture changes.md` — were retired by audit M11. Their live content is below and
in `docs/audit-remediation-status.md`; `docs/retired-documents.md` says how to read the originals
out of git. Summary:

- **~~Gateway bypasses validation entirely~~ — FIXED (Phase 1.0b).** `src/gateway/proxy.ts`
  now routes through `core/engine.optimize()`, so validators, `DriftTracker`,
  `ConfidenceLedger`, `DebtTracker` and the fallback resolver all run on proxy traffic and
  `fallbackUsed` is a computed value. Invariants 3 and 5 now hold on all three entry modes.
  The Gateway pins the planner to `session_dedup` mode, so `cleanup:session-dedup` is still
  the only stage that runs on live traffic — deliberately, because `token-hashing` would hit
  Issue 2 on JSON payloads. Two constraints to know before changing this path: the Gateway
  maps `result.finalBundle` items back onto the parsed payload and must **not** use
  `emittedOutput` (the fallback resolver renders a newline-joined blob, not a valid API
  payload); and it passes a **per-request** `ConfidenceLedger`, because a session-scoped one
  decays earlier turns below `validation.minimumConfidence` (default 1) and would force a
  fallback on every turn after the first.
- **~~Issue 2: eliding stages corrupt JSON content~~ — FIXED (Commits 29f66b3, e9ea50d,
  b11dcb0, 642abcb, Commit C).** All three eliding stages now route through
  `core/elision.elideItem`, which resolves the syntax from the same `selectValidator` the
  checker uses and renders the marker validly for it — JSON elisions become
  `{"__td_block__":"<marker>"}`, and `TokenHasher.rehydrateText` unwraps them. The Gateway
  no longer hardcodes `contentType: 'text'`; message content is classified, so
  `selectValidator` and `DriftTracker.extractSymbols` finally see JSON as JSON.
  Three things to know before building on this:
  - **The classification half of this fix was partial, and this entry used to overstate it.**
    It closed JSON. It did not close code: `classifyContent` answered `html` for TypeScript
    (46 of this repo's 57 sources), `selectValidator` has no `html` branch, and a pathless
    item — the Gateway shape — therefore got **no validator at all**, returning
    `valid: true, issues: 0` on a file with an unterminated string literal. That is the same
    vacuity Phase 1a is recorded as having closed, arriving by a different route. Fixed in
    Phase 1.5: DECISIONS §22 (the classifier) and §23 (an unvalidated item now reports
    `validated: false` and shows on `trace.astCoverage` instead of reading as a pass).
    Pathless code is closed for **Python** and for anything **declared**. Phase 4b.1
    (DECISIONS §29) added `--language` / `--input-name` and the MCP `language` / `path`
    properties; Phase 4b.2 (§31) added a Python content probe that sets `contentType` and
    `language` together and **only claims content `PythonValidator` already accepts**, so a
    detection can never make an item less valid than leaving it alone. Undeclared, undetected
    pathless code — every non-Python language over stdin, the Gateway and MCP — is still
    unchecked and still visible on `trace.astCoverage`. There is deliberately **no TypeScript
    probe**: §4 measured TS positives (0.283–1.000) overlapping prose negatives (to 0.333),
    because this repo's prose is documentation *about* TypeScript. `--language` is what TS
    over stdin gets.
  - The load-bearing mechanism is **correct-by-construction rendering**, not the
    post-condition check. Only `JsonValidator` rejects a bare placeholder; the TS and
    Python AST-lite validators accept it, so `post_condition_rejected` is unreachable
    today. Placeholder injection into TS/Python content is caught only by drift.
  - This did **not** make `token-hashing` safe to run on the Gateway. It is lossy, sets no
    `recoverable` flag, and measures `S_k = 0.60` on JSON — so it now fails the drift gate
    instead of the AST gate. Invariant 8 still stands.
- **Issue 5 — the premise is wrong; Phase 1b needs re-deriving.** The claim was: *"on
  fallback, `session.json` emits -1.39% — output is larger than input, because fallback
  re-renders `currentBundle` instead of echoing raw input bytes."* Measured 2026-08-03,
  both halves fail.
  - `src/core/fallback/index.ts` returns `output: request.rawInput` when
    `shouldFallback` — fallback **already** echoes raw bytes. All four
    `tokendamper-benchmark/test_data` payloads fall back through the CLI and emit
    byte-identical output. It is the **success** branch that re-renders
    (`items.join('\n')`).
  - The **-1.39%** is a benchmark-harness artifact. `run_benchmark.py:75-77` special-cases
    session payloads and sets `orig_tokens = count_tokens(json.dumps(messages))`, a
    re-serialization that drops the file's pretty-printing (15,785 chars) while TokenDamper
    is handed and echoes back the raw file (16,131 chars). Reproduces to two decimals.
  A case for splitting fallback may still exist — the success path's newline join is lossy
  for multi-item bundles, which is why the Gateway must map `finalBundle` positionally
  (invariant 9) — but it is a **different defect with different evidence**. Do not scope
  Phase 1b from the -1.39%. See `NOTES-FOR-DOCS.md`. [retired]
  **Phase B settled both halves (DECISIONS §35).** The live one was neither: `rawInput` is a
  *decoded string*, so `readFileSync(path, 'utf8')` turned invalid bytes into U+FFFD before any
  stage ran and the fallback echo could not restore them — a Latin-1 `vimspell.sh` came back
  **1,462 → 1,466 bytes with `fallbackUsed: true`**. The CLI now keeps the `Buffer`, writes it
  on fallback, and forces a fallback when input fails a UTF-8 round-trip. Fallback
  byte-identity went **502/504 → 504/504**. The newline join turned out to have **no live
  consumer** — CLI, MCP and bench are all single-item via `createContextBundle`, and the
  Gateway bypasses `emittedOutput` — so it is pinned by `test/unit/fallback-render.test.ts`
  rather than fixed.
- **Issue 3 / Phase 1d — investigated 2026-08-03, threshold unchanged, remedy undesigned.**
  Full record was `docs/phase-1d-drift-investigation.md` (retired — `docs/retired-documents.md`);
  its §10 and §12 carried the caveats on its benchmark numbers, so treat any figure quoted from
  it as needing that context. **The threshold is not the defect; do not tune it.**
  - Bench reality at `targetReductionRatio: 0.30`: `avgReduction` **0.00%**,
    `fallbackRate` 0.40, all ten fixtures byte-identical. The 7.82% that briefly appeared
    was the estimator mismatch, not a saving (§12, DECISIONS §19).
  - `S_k = 0.60` is a **formula constant** — `w_AST` exactly — produced whenever
    `R_AST = 0` and `R_struct = 1`. It is not a measurement of how much was lost, and it is
    the **ceiling** for code, not a midpoint.
  - `extractSymbols` returns empty on the optimized side **correctly**: `token-hashing`
    replaces the item's whole content with a 77-byte placeholder. No validator is involved
    in extraction — it is regex over `item.content`, identical under all five contentType
    tags. Only the `jsonkey:` branch reads the tag.
  - ~~Cause is **granularity**: `token-hashing` is whole-item and `createContextBundle` makes
    a single-item bundle for CLI/bench, so `R_AST` is a boolean.~~ **Both halves are now false,
    and several notes below still reason from them — read this first.** `token-hashing` prefers
    sub-item regions and, since §43, **refuses whole-item elision of a symbol-bearing item
    entirely** (it can never survive validation, so attempting it only guaranteed a fallback).
    And `optimize` accepts multiple paths and directories since §43, so a CLI bundle is no longer
    single-item — `createMultiItemRequest` builds one item per file. `R_AST` is a real ratio on
    both routes. (Symbol-free files still pass trivially — `R_AST` defaults to 1.0 when
    `symbolsBefore` is empty; that case is the measurement gate's, §37.)
  - ~~For code, `R_struct` is pinned at 1.0 — the only marker is `filepath:`.~~ **Fixed in §40.**
    `R_struct` is computed over `extractContentMarkers`, which excludes `filepath:` and
    metadata-derived markers, and a ratio whose before-set is empty no longer votes at all — its
    weight is redistributed. For code `S_k = 1 - R_AST`, so the maximum symbol loss that can pass
    fell from 66.7% to **40%**. Note the audit's proposed fix (drop `filepath:`) was measured
    **inert** on its own: an empty marker set defaults `R_struct` back to 1.0.
  - The old "Headroom independently chose `router:noop`, so this is probably correct" claim
    is **retracted** — on re-run Headroom hit a 20-second backend timeout and failed open.
    Same 0%, different mechanism. Do not cite it as corroboration.
  - **The semantic gate was investigated 2026-08-04 and precondition (a) is disposed of:
    `docs/phase-1d-semantic-gate-disposition.md`. Nothing implemented.** §18's proposed [retired]
    markers for code (brace balance, function/class boundaries, imports) are measured to be
    near-constants under the shipped selector — it preserves them by construction — so they
    would replace one decorative constant with four. Only comments and docstrings vary.
    Three findings to carry: `HumanEval/0` is **already caught** (`selectElisionRegions`
    returns `[]`, `S_k` pins at 0.60, input echoed) so stop citing it as the live hole;
    `R_AST` and `R_struct` **default to 1.0 when the *before* set is empty**, which scored
    "nothing to measure" as "perfect retention" and let `src/index.ts` be deleted whole at
    86.15% with `S_k = 0.0000` — **fixed 2026-08-05, DECISIONS §28**, for validator-covered
    items only; prose and pruner-removed items are still unwitnessed, now reported on
    `trace.driftCoverage` rather than enforced; and on real Python **86% of
    elided function bodies contribute no symbols**, so the drift gate is nearly inert there
    and it is `cleanup:constraint-preservation` that catches docstring loss — only when the
    prose is phrased as an imperative.
- **Issue 4 (not a bug):** constraint-preservation correctly refused to drop a planted
  imperative-tagged line in `sample_logs.txt`. `BLUE-PANDA-992` is a synthetic test
  string, not a credential.

Issues 2 and 5 are the same class of failure: a **round-trip invariant violation**.
The agreed direction is three scoped changes (no rewrite):

1. ~~Content-type becomes a first-class tag on `ContextBundle`.~~ **Done, but not at that
   seam.** The tag belongs on `ContextItem`, where it already existed — `selectValidator`
   dispatches per item, so a bundle-level tag would key the transform and the check at
   different granularities, reproducing Issue 2's shape while appearing to fix it. Bundles
   are heterogeneous (a 12 KB JSON tool result next to a one-line question), and
   `statistics.contentTypeCounts` is already the bundle-level view. See `NOTES-FOR-DOCS.md`. [retired]
   The planner-level gate (§3.6 of the design doc) is still **not** implemented: nothing in
   `src/core/planner/` reads `contentType`.
2. ~~Per-stage checkpointing replacing the single global validate→fallback gate.~~ **DONE as
   Phase 1c, DECISIONS §47 — but per *item*, not per stage.** This entry's own warning is why:
   a validation failure is often not attributable to a stage, because `validate()` runs over
   every item in the final bundle and a failure can originate in an item no stage touched. It
   *is* attributable to an **item**, and that is the axis the fix uses.
   - `ValidationIssue.itemId` is a field now, not text inside `message`. `validate()` returns
     `attribution` — `repairableItemIds` plus `hasUnattributableError`.
   - The engine reverts named items, re-validates through the **same** `validate`, and adopts
     the result only if it passes. Repair changes which bundle is offered, never what counts
     as valid.
   - Drift splits: `SEMANTIC_DRIFT_UNMEASURABLE` names items via `unwitnessedItemIds` (§33) and
     is repairable; `SEMANTIC_DRIFT_EXCEEDED` names none and is not.
   - **The gate is "is there a principled subset to revert?", not "is every error attributed?"**
     The stricter rule was tried and measured too strict — see §47 before re-tightening it.
   - Measured: 45-file Python **0.00% → 22.73%**, 61-file TypeScript **0.00% → 19.47%**;
     574/574 single-file corpus rows unchanged; 14/14 single-file fallbacks still byte-identical.
   - Read `trace.itemsReverted`, not just `fallbackUsed` — a partial success is not a clean run.
3. ~~Split fallback into **raw passthrough** vs. **bundle rendering**.~~ **DONE (Phase B,
   DECISIONS §35)** — though the live defect was not the one this item names. The fallback
   branch already returned `request.rawInput`; what made that *not* byte-identical was that
   `rawInput` is a decoded string, so non-UTF-8 input was corrupted at read time. The CLI now
   keeps the `Buffer` and writes it on fallback, and input failing a UTF-8 round-trip forces a
   fallback through the engine (`EngineOptimizationOptions.inputNotRepresentable`) — through
   the engine, because an adapter that returns early emits no trace, which is indistinguishable
   from a crash. Byte-identity **502/504 → 504/504**. The success-path newline join has no live
   consumer and is pinned, not fixed; see §35's last two sections before changing it.

Do this before roadmap feature work. `tokendamper-roadmap-v1.1-v2.0.md` schedules BM25
scoring, MMR, AST folding and Prometheus metrics on top of a pipeline that currently
0%-fails on structured payloads.

## Conventions

- Tests: vitest, under `test/unit/` and `test/integration/`. There is a property/fuzz
  suite (`test/unit/fuzz-diff-debt.test.ts`) and stress tests
  (`knapsack-stress`, `m2_stress`, `bench-table-stress`) — extend these rather than
  adding parallel harnesses.
- Every behavioral change should be reflected in `CHANGELOG.md`; architectural decisions
  go in `DECISIONS.md`.

## Gotchas

- `DriftTracker` exempts elisions tagged `recoverable: true` by substituting their
  pre-optimization content before scoring. `cleanup:session-dedup` sets that flag **only
  when an intact copy of the content survives elsewhere in the same outbound payload** — it
  preserves the first occurrence and elides the copies after it. A sole copy is still
  elided but carries `recoverable: false` and is scored in full. The earlier rationale
  ("the session store can restore it, so the marker is a pointer") does **not** hold on the
  Gateway path: the consumer is a stateless provider API with no rehydration mechanism, so
  elided content is deleted, not referenced. Do not infer the exemption from `elided` or
  `originalContentHash`; `token-hashing` sets both and must stay fully scored.
  See DECISIONS.md §16 and the §16 entry in `NOTES-FOR-DOCS.md`. [retired]
- **This repo is its own corpus. Freeze it before measuring, or the measurement moves under
  you.** Every reduction figure in this project is measured over `src/**/*.ts` and the
  repository's own `*.py` — the same files a session edits while it works. A re-run after
  three commits is not a re-run: a previous session read movement as a behavioral change when
  it was reading its own edits. **Copy the corpus to a scratch directory, record the commit
  and a `sha256sum` manifest, and point the CLI at the copy.** `tools/corpus-harness/` does
  exactly this — `collect.js` freezes and pins (commit, `dist` hash, `dirty` flag), `measure.js`
  re-verifies every hash and runs both routes, and both assert their counts. Use it rather than
  hand-rolling the loop; the hand-rolled ones have been wrong twice (the repo moving mid-run,
  and a 4b.3 glob that silently measured 132 of 144 files). Then vary only the engine —
  patch `dist/` and restore it — never the input. Two corollaries that have both bitten:
  a paired comparison must be made over the files that reduce under *every* variant (a variant
  that converts fallbacks into reductions changes the denominator and can make a strictly
  worse rule look better on the mean); and the corpus is ~94% TypeScript, which is not a
  neutral sample for anything language-dependent — a docstring rule that costs 0.45pp here
  costs 6.8pp on real Python (`docs/phase-1d-semantic-gate-disposition.md` §2). [retired]
- **Classification has a blast radius over items no stage touched.** `validate()` runs
  `validateBundleAst` over *every* item in the final bundle, so changing what
  `classifyContent` returns can fail an item nothing transformed. To see it, measure
  **turn 1** of a Gateway session: `cleanup:session-dedup` has no previous block hashes
  there and cannot elide anything, so any fallback is a false positive by construction.
  That is how the fenced-prose defect in DECISIONS.md §17 was found.
- **Version is reconciled at 1.1.0 — closed 2026-08-04, stop re-listing it.** `src/version.ts`
  is the single source (`TOKENDAMPER_VERSION = '1.1.0'`); `package.json`, `CLI_ADAPTER_VERSION`,
  `MCP_ADAPTER_VERSION`, `SERVER_VERSION` and `config.appVersion` all derive from it, and the
  `v1.1.0` tag exists. ROADMAP.md:6 already carries its own correction retracting the v1.0.3
  baseline. There was never a code discrepancy — only this note outliving the fix, which put it
  on every status list for weeks.
- `configSchemaVersion` **already exists** in `src/config/types.ts`, despite the roadmap
  listing it as a v1.1.0 item to add.
- **Token counting goes through exactly one place: `estimateTokens` /
  `estimateBundleTokens` in `src/core/hashing/tokenizer.ts`.** `countTokens` is called from
  nowhere else, and there is no inline `ceil(len / 4)` left. Do not add a second estimator —
  until `1b1e999` there were two (tokenizer on a bundle's input side, `ceil(len / 4)` on
  every output side) and every reduction ratio compared one against the other, so
  byte-identical output reported an 11–22% saving. DECISIONS.md §19;
  `test/unit/token-estimator-unity.test.ts` guards it.
- The default estimator is `EnhancedHeuristicTokenizer`, and it is **not** the more accurate
  one. Scored against real `cl100k_base`, it has 24% mean absolute error against
  `ceil(len / 4)`'s 17%. It is the default because `TokenizerAdapter` is the seam a real BPE
  tokenizer plugs into and the planner already denominates cache blocks in adapter units.
  Anything needing exact token boundaries (e.g. `cache_control` placement) still cannot be
  exact until `createTiktokenAdapter` is wired to a real encoder — which is now a one-line
  change to `DEFAULT_TOKENIZER`.
- Several items in the roadmap's Phase 1 were already fixed in the codebase (fallback
  output bug, unbounded `traceStore`, missing SIGINT/SIGTERM, gateway body-size cap).
  Verify against source before implementing anything from a planning doc.

## Reference docs in repo

**`docs/audit-remediation-status.md`** — current audit state, measured baseline, what is next.
Start here for anything audit-related; it is the doc kept current.

`ARCHITECTURE.md` (canonical, frozen) · `ROADMAP.md` · `DECISIONS.md` · `CHANGELOG.md` ·
`max_audit.md` (the audit itself — note several of its *reachability* claims were measured wrong;
see §40, §42 and §45) · `docs/architecture/milestone_*.md` · `docs/v1_deployment_audit.md` ·
`tokendamper-benchmark/BENCHMARK_RESULTS.md`

**`docs/retired-documents.md`** — audit M11 retired twelve narrative documents (~230 KB) whose
conclusions already lived in `DECISIONS.md` and the status doc. That file maps each one to where
its conclusion now lives and gives the `git show` command to read the original. Citations marked
`[retired]` in source comments and here point at documents in git history, not missing files —
they are still accurate about what was measured and when.
