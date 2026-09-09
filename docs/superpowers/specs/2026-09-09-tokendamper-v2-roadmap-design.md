# Design — the road to v2.0: Fast and Deep as one seam, four languages to N

**Status:** design, approved in outline 2026-09-09. Nothing here is implemented.
**Supersedes:** `ROADMAP.md`'s two unnumbered sections — *AST Code Folding ("Fast" vs "Deep") &
Cache Alignment* and, in part, *Context Selection Quality*. Landing this design means rewriting
those sections, not appending to them.
**Baseline surveyed:** `f7488c5`, working tree clean, `src/version.ts` = `1.7.3`.

> **This document reserves no version numbers.** DECISIONS §53: four reservations in four
> releases were wrong, and a number is a fact about what shipped, assigned at ship time. The four
> releases below are named **R1–R4**. `v2.0.0` is the single exception, because a major signals
> *breaking change* rather than queue position — and §4 below says what actually breaks.

---

## 1. The destination

**Deep mode is a language-coverage feature, not a precision feature.**

TokenDamper elides on four languages — TypeScript, JavaScript, Python and Go — out of seventeen
probed. Every other bucket measures **0.00%** reduction. Each of the four cost a hand-written
lexer, a symbol extractor and a region scanner, landed in that order for the safety reason §56
measured. That is roughly 1,400 lines per language and does not scale to Rust, Java, C#, C++,
Ruby, Kotlin, Swift and PHP.

A tree-sitter grammar supplies all three from one artifact:

| what a language needs today | where Deep gets it |
|---|---|
| `extractSymbols` coverage (DECISIONS §59) | named declaration nodes |
| an `AstValidator` (§60) | `ERROR` / `MISSING` nodes in the parse tree |
| a region scanner (§61) | body node byte ranges |

So:

- **Fast** — the shipped, zero-dependency lexer path. Default. Covers TS/JS/Python/Go/JSON.
- **Deep** — an opt-in tree-sitter (WASM) backend, shipped in a companion package. Covers those
  plus every language a grammar exists for.

### 1.1 Two payoffs this design explicitly rejects

Both were considered and both fail against measurements already in this repository. They are
recorded here so they are not re-proposed.

- **"Deep reduces more on the languages we already have."** The lexer is not the binding
  constraint. Go's fallbacks are **18 of 20** `CONSTRAINT_DIRECTIVE_LOST`; TypeScript's are **15
  of 62** (24%), the same gate. Neither is a parsing failure. Shipping a parser to raise reduction
  would be BM25 and MMR a third time: correct code, no observable effect — the H5 condition.
- **"Deep makes validation a real syntax guarantee."** DECISIONS §46 decided against wiring
  `ts.createSourceFile`, on cost: `typescript` is a *dev* dependency, and promoting it to runtime
  buys install size and parse latency against a lexer that runs in single-digit milliseconds.
  That decision is not reversed here. A *side effect* of Deep is that its languages get a real
  parse — but the claim in `README.md` and `CLAUDE.md` stays **bracket/quote integrity** for the
  Fast path, and `test/unit/validator-guarantee.test.ts` stays as written. If Deep's guarantee is
  ever advertised, it is advertised as Deep's, and that test, the README table and CLAUDE.md's
  opening paragraph change together — which is what that test exists to force.

---

## 2. What is left, surveyed 2026-09-09

Enumerated against each document's own list of items, not against the list of work that was done.
That distinction is DECISIONS §55 and status-doc §8; getting it wrong is how this project twice
declared an audit closed while a whole severity band sat unscheduled.

### 2.1 Release state — live, and it is the trap CLAUDE.md names

`npm view tokendamper version` returns **1.7.2**. Tags run to **v1.7.3**. `CHANGELOG.md`
`[Unreleased]` holds the entire security-review remediation (DECISIONS §73–§74, findings
S-01–S-04) *including a behavioural change* — S-04 makes the Gateway refuse an upstream redirect
with a 502 — plus the README restructure. **None of it has reached a consumer.**

### 2.2 Audits — four documents, all closed

`max_audit.md` · `oxaudit.md` (L17/L18 landed, §72) · `docs/security-review-2026-08-30.md`
(F-01…F-08, V-01…V-03, S-01…S-04) · the per-issue history in CLAUDE.md. Verified against each
document's own finding list, not against the remediation record.

What survives is **not findings**: §9.1 items 5 and 6, the F-06/F-07 accepted residuals, and
D-1/D-2, which downgrade sentences rather than behaviour. See §8 of this document for their
disposition.

### 2.3 Engine gaps

| # | Gap | Measured state | Disposition here |
|---|---|---|---|
| G1 | Language coverage | **4 of 17** reduce; every other bucket 0.00% | **The spine.** R3–R4 |
| G2 | `CONSTRAINT_DIRECTIVE_LOST` on descriptive comments | 24% of TS fallbacks; **18 of 20** Go | **R2** — precondition, see §3.2 |
| G3 | No latency instrument | `stageDurationsMs` is per-stage; no per-file wall clock anywhere | **R2** — precondition, see §3.3 |
| G4 | Sub-statement elision inside control-flow blocks | 18 of 576 rows still >50% achieved | Held — §8 |
| G5 | Drift is bundle-scoped | A bundle failing on drift alone falls back whole | Held — §8 |
| G6 | `isCodeExtension` is a hardcoded 19-entry list | `.rb` `.lua` `.swift` `.kt` `.pl` `.tcl` outside it | **Folded into R4** — see §3.8 |
| G7 | No exact tokenizer | Blocks `cache_control` 1,024-boundary work and Milestone 8 | Held — §8 |
| G8 | `rehydrate_context` sub-query | Unblocked since §44; response shape undesigned | Held — §8 |
| G9 | Ecosystem: MCP-over-HTTP, LiteLLM, Prometheus | `ROADMAP.md`'s v2.0.0 section | Held — §8, and see §4.3 |

### 2.4 Measured false — no number, deliberately

**BM25 hybrid scoring** has no input: there is no query concept anywhere in `src/`, and
`scoreBundleTopology(bundle, gitStatus, graph, budget)` takes none. **MMR** has nothing to
eliminate: over 1,486 real pairs, **zero** exceed the 0.90 threshold; maxima are 0.296 and 0.500.
Neither is scheduled. Both stay in `ROADMAP.md` with their measurements attached.

---

## 3. The four releases

### R1 — Ship the backlog

**Deliverable:** the unreleased security remediation reaches npm.

Nothing in this design gets built first. A tagged version that is not on the registry is the
precise failure the `release` skill exists to prevent, and it is currently live: work landed on
`main` after v1.7.3 was tagged, which is the same sequence that cost v1.6.1 and v1.7.0 their
publishes.

**Scope:** run the `release` skill. Decide the number at ship time against §53 and the skill's
rule — note S-04 changes behaviour for any caller whose upstream redirects, so this is a minor
under this project's usual threshold, not a patch.

**Measurement:** none required. Nothing on the optimize route changes. §12.9 already recorded why
S-03 and S-04 moved no optimized byte, and R1 adds no code.

**Exit:** `npm view tokendamper version` matches the tag, and `npm pack --dry-run` was read
before publishing rather than after.

---

### R2 — The constraint gate, and a clock

Two items. Both are **preconditions for measuring R3–R4 honestly**, which is why they precede a
feature rather than compete with it.

#### 3.1 Why these two and nothing else

R4's entire claim is a number: *language X reduces by N%*. That number is produced by an
instrument. Today the instrument has a known bias (G2) and no time axis at all (G3). Ship the
grammars first and every new-language figure is measured through a gate that discards a quarter
of its files for a reason unrelated to the grammar — and has to be re-measured afterwards, at
which point the comparison is against a moved baseline. This is the §56 ordering argument
applied to measurement rather than to safety.

#### 3.2 The constraint gate — two open axes

DECISIONS §52 exempted a **narrative** use of `never`/`always`, matching perfect and past-tense
constructions: `NARRATIVE_DIRECTIVE_REGEX` at `src/core/constraints/directives.ts:139` requires a
preceding `have`/`has`/`had` or a following past-tense verb. Two things fall through it:

- **Axis A — present-tense descriptive `never`/`always`.** `// Should never happen, but we` (the
  comment CLAUDE.md quotes as dominating Go's fallbacks) is present tense, so §52 does not match
  it. So is `is always deterministic`.
- **Axis B — the other seven keyword alternatives, used descriptively.** `IMPERATIVE_KEYWORD_SOURCE`
  (`directives.ts:3`) covers `must`, `must not`, `never`, `always`, `only if`, `do not`,
  `required`, `except when`, `make sure to`, `critical`. That is nine alternations; §52 touched two of them. `do not
  support`, `required by`, `critical path` are outside its scope entirely.

**This gate protects content, and over-narrowing deletes an instruction, which no reduction
figure buys back.** So the measurement is **two-sided and both sides gate the merge**:

1. **Recovery side** — fallbacks recovered per language over the frozen corpus, per-row, engine
   varied and input frozen. Must be a net gain with **zero** new fallbacks, as §52 achieved
   (4 fixed, 0 new, 572 of 576 rows byte-identical).
2. **Retention side** — a planted-directive corpus in which every document carries a genuine
   imperative that must survive. Must stay at **100% caught**, before and after. The shape
   already exists: Issue 4 records `constraint-preservation` correctly refusing a planted
   imperative in `sample_logs.txt`.

A change passing (1) and failing (2) is refused regardless of the reduction it buys.

**Corpus caution, mandatory:** §52 gained 6pp on TypeScript and **zero** on Python, because all
four recovered files were this repository's own unusually narrative source. This repo is ~94%
TypeScript. Any figure from axis A or B is measured on TS, Python, **and** Go independently, and
reported per language. A favourable aggregate here is the corpus-bias trap arriving in the
direction that is hardest to notice.

#### 3.3 The latency instrument

A mode whose premise is a trade needs a scale before it has two things to weigh. The roadmap's
`<1ms` Fast / `~15ms` Deep targets are unvalidated and cannot be validated today.

**What exists:** `stageDurationsMs` in the engine (`src/core/engine/index.ts:102-123`), surfaced
per stage on the trace; per-validator `durationMs` on `AstCheckResult`; `performance.now()` in
`src/bench/runner.ts:75`.

**What is missing:** a per-file wall-clock figure over a corpus, comparable across engine
variants.

**Build:** extend `tools/corpus-harness/measure.js` with a timing run. Non-negotiable property —
**the timing run is a separate invocation from the byte-identity run.** Wall clock is noisy and
machine-dependent; byte-identity is deterministic and is the harness's load-bearing output.
Mixing them would make a green byte-identity result depend on machine load, which is exactly the
mistake `test/unit/ast-sla-determinism.test.ts` was written to prevent for `slaExceeded`.

Report: per-file p50/p95/max, per stage and end-to-end, with the corpus commit and `dist` hash
pinned as `collect.js` already pins them.

**Exit for R2:** both axes measured two-sided per language with the retention side at 100%; the
timing harness produces a pinned baseline for the current engine on the frozen corpus. That
baseline is what R3 and R4 are compared against.

---

### R3 — The `ParserAdapter` seam, and a negative control

**Deliverable:** core grows a parser seam and a Deep code path. **No new dependency, no new
language, no new grammar, no reduction change.** The companion package does not exist yet.

This is the release that is easy to skip and must not be. Its output is a *measurement*: that a
second backend, wired through the same gates, reproduces the shipped one. A backend first trusted
on a language nobody can hand-check is a backend nobody has checked.

#### 3.4 The seam

Modelled on `TokenizerAdapter` / `createTiktokenAdapter` (`src/core/hashing/tokenizer.ts`), which
is this codebase's established answer to "capability without a dependency": core ships the
interface, and does not bundle an implementation.

```
src/core/parser/
  types.ts      ParserAdapter, ParsedTree, DeclarationNode
  registry.ts   registerParserBackend / resolveParserBackend
```

`ParserAdapter` answers exactly the three questions a language needs, and nothing else:

- `symbols(content): Set<string>` — feeds `DriftTracker.extractSymbols`
- `check(content): AstCheckResult` — satisfies the existing `AstValidator` shape
- `regions(content): ElisionRegion[]` — feeds `selectElisionRegions`

**Three constraints that are not negotiable:**

- **The adapter surface is synchronous.** `AstValidator.validate(content, options):
  AstCheckResult` (`src/core/validation/ast/types.ts`) is sync, and so is every caller down the
  chain. `web-tree-sitter` needs `await Parser.init()` and `await Language.load(wasm)` — so **all
  async work happens at registration**, before the pipeline runs, and parsing is sync thereafter.
  Making the validator interface async would ripple through the engine, the fallback resolver and
  three adapters to buy nothing.
- **Invariant 1 is per-configuration.** Same input, same mode, same bytes out. Fast and Deep
  producing different bytes for the same file is not a violation — it is the feature. State this
  in `ARCHITECTURE.md` when the seam lands, because the invariant reads as absolute today.
- **`selectValidator` becomes a registry lookup with the hardcoded chain as its fallback**
  (`src/core/validation/ast/index.ts:96-133`). The existing if-chain stays and stays first: Fast
  must not change behaviour because Deep exists, and the shipped path must not depend on a
  registry being populated.

#### 3.5 The negative control — staged, because byte-identity is not the right assertion throughout

A parser will legitimately find *better* regions than a lexer. Demanding byte-identical output at
every step would forbid the improvement the feature exists for. So the control is staged, exactly
as §59/§60/§61 staged Go:

| step | what ships | assertion | precedent |
|---|---|---|---|
| **1. symbols** | Deep `symbols()` for TS/JS/Py/Go, nothing wired to elision | Symbol sets equal or superset. Per-file `S_k` **must not fall** on a hand-elided control file | §59: a *falling* `S_k` means the backend manufactures symbols body elision cannot destroy — §56's hazard, and the reason `type:`/`import:`-only files passed every gate having witnessed nothing |
| **2. validator** | Deep `check()` dispatched by language | Disagreement rate against the shipped validator measured over **≥5,000 real files per language**, and **every disagreement inspected and classified**. Corpus output **byte-identical** | §60 exactly: 9,181 Go files, TS lexer flagged 73, Go lexer flagged 1, and all 72 disagreements were read — they were raw strings. Plus its inverse control: delete the last column-0 `}` and confirm the validator *catches* it (99.66% on Go), because **0 findings is also what a validator that examines nothing reports** |
| **3. regions** | Deep `regions()` behind `--mode deep` | Output **may** differ. Every differing row classified as improvement or regression; **fallbacks must not rise**; per-file latency reported against R2's baseline | §61: 574/574 identical on the main corpus *because it contained no Go*, with the real evidence coming from a separately frozen 80-file corpus |

**Steps 1 and 2 are true negative controls and their assertion is byte-identity.** Step 3 is not,
and pretending otherwise would either block the feature or launder a regression as an improvement.

**Exit for R3:** all three steps measured on all four existing languages. Deep on TS/JS/Py/Go is
reachable via `--mode deep` and produces output whose every difference from Fast has been read
by a person.

---

### R4 — v2.0.0

**Deliverable:** `tokendamper-deep` ships; N new languages reduce; the flag surface is
rationalized.

#### 3.6 Packaging

Core stays at **zero runtime dependencies**. The companion package carries `web-tree-sitter` and
the grammar WASM.

```
packages/deep/          # tokendamper-deep, own tsconfig, own publish
src/                    # tokendamper, unchanged build
```

**Do not restructure the existing build to accommodate this.** CLAUDE.md is explicit and the
reason is load-bearing: `tsconfig.build.json` (`src/` only) and `tsconfig.json` (`src/` + `test/`)
are two configs on purpose, and `rootDir: "."` is what keeps output at `dist/src/...` — a src-only
build without it relocates every file to `dist/*` and breaks `main` and `bin` **while still
compiling**. `packages/deep/` gets its own config; core's is not touched.

`test/unit/published-package-scope.test.ts` is extended to cover both tarballs. Core's must not
grow — it went 508 → 223 entries and 3.08 → 1.65 MB in v1.7.2, and a companion package exists
precisely so that stays true.

**Discovery:** the CLI attempts an optional `require('tokendamper-deep')` when `--mode deep` is
passed. Absent, it fails with an actionable message naming the install command — not a silent
downgrade to Fast. A mode that silently does something else is invariant 10's failure: a green
result from a path that never ran.

#### 3.7 Choosing the languages — by measurement, not by grammar availability

§56 is the template and it is not optional. Before a grammar is committed to:

1. **Measure the elidable ceiling** — share of bytes inside body nodes clearing `MIN_REGION_BYTES`
   (104) and `isSubstantiveRegion`.
2. **On at least two independent corpora per language.** Non-negotiable: Go read **65.36%** on
   application code and **54.78%** on the stdlib, and the cause was checked rather than averaged —
   21.7% of stdlib source bytes are in files with no elidable region, mostly generated tables.
   One corpus would have overstated Go by ten points.
3. **Ship only what clears a floor**, with its **own measured fallback rate** — not a rate
   borrowed from another language. §56 projected Go at 23–28% by borrowing TypeScript's conversion
   factor, which embeds TypeScript's fallback rate; that projection happened to land, and §9 of the
   status doc records it as *not established* anyway.

Reference points: TypeScript 57.78% ceiling → **24.56%** achieved at target 0.3; Go application
code 65.36% → **27.46%**; Go stdlib 54.78% → **19.42%**; Python (pip) 46.88% → **22.73%**.

Candidate set, unranked until measured: Rust, Java, C#, C++, Ruby, PHP, Kotlin, Swift, C.

**Test files are the larger prize and nothing in this project has counted them.** `_test.go` is
53 MB against 36 MB of source in the Go application corpus, at **92.22%** elidable, and measured
**26.88%** against source's 14.42%. Measure test and source separately for every candidate.

#### 3.8 Two extension lists are a precondition of every new language

A grammar for Ruby buys nothing while `.rb` is not recognized as source. **Two separate lists
decide that, and they are deliberately separate — do not merge them to fix one.**

- **`isCodeExtension`** (`src/core/model/constructors.ts:1181`) is a *classification* rule and
  decides whether an item is treated as code at all, which decides whether a validator is selected
  (audit H2). Nineteen entries.
- **`INGESTIBLE_EXTENSIONS`** (`src/cli/ingest.ts`) is a *selection* rule for directory walking.
  Its own comment states why sharing them would mean widening one to fix the other, and that
  directory walking should get no vote in whether a file is validated.

**The gap is narrower than the survey implied, and this changes the ordering.** `rs`, `java`, `c`,
`cpp`, `h`, `hpp` are **already** in `isCodeExtension`. So Rust, Java, C and C++ need no list
change and are the cheapest candidates. `rb`, `kt`, `swift`, `php`, `cs` are absent and need both
lists extended.

**Why this is a trap rather than a chore.** Since §33 and §34, falling outside `isCodeExtension`
produces an honest *refusal* rather than a silent deletion — which means a Ruby file with a
working grammar and a missing extension reduces 0% while every gate reports correctly. That reads
exactly like the safety machinery working as designed. Per language, the step-1 control repeated at R4 must
therefore assert the file was **classified as code** before asserting anything about its symbols.

---

## 4. What breaks at 2.0

A major must break something. It breaks these.

### 4.1 `--mode` is withdrawn and the name reused

`--mode` today accepts `optimize | bench` (`src/cli/main.ts:709-720`). `optimize` is the
identity — nothing branches on it — and `bench` sets `command = 'bench'`, which the positional
`tokendamper bench` already does. **The flag is fully redundant with the positional command.**

At 2.0 it accepts `fast | deep` and nothing else. `--mode optimize` and `--mode bench` become
parse errors naming the positional form. This is the same disposal §62 applied to `--mode
explain` and `--trace-output` — a dial that reported success and did nothing — with the
difference that the name is then reused for something real.

Config: `planner.mode` is **not** where this goes. `planner.defaultMode` already means the planner
mode (`session_dedup` / knapsack), and `--planner-mode` is a separate flag accepting only
`pass_through` (`main.ts:742-748`). Deep vs Fast is an *engine backend*, not a planner mode.
It lands as `engine.mode` in config, keeping the two axes visibly distinct.

### 4.2 A config file carrying `mode: "optimize"` keeps loading

§62's precedent: a config still carrying `traceOutput` loads. An unrecognized enum *value* is a
hard error since §55/L1 — but that rule applies to values the code branches on, and this one is
being withdrawn. Withdrawn keys are ignored with a startup warning naming the replacement, not a
throw. Anything else turns a documentation change into an outage.

### 4.3 What does **not** break

The Gateway stays experimental and invariant 8 stands — cross-turn dedup of a sole copy still
saves 0 bytes, and `test/integration/gateway-dedup-reality.test.ts` still pins that. **v2.0 is not
the Enterprise Gateway release `ROADMAP.md` currently describes.** That section's own premise note
is why: a Prometheus endpoint on a pass-through that saves nothing cross-turn instruments nothing.
Those items are held (§8), and `ROADMAP.md`'s v2.0.0 section is rewritten to say so rather than
left to imply a plan.

---

## 5. Testing

Per the repo convention: vitest under `test/unit/` and `test/integration/`; extend the existing
property/fuzz and stress suites rather than adding parallel harnesses.

| release | new tests |
|---|---|
| R2 | `constraint-descriptive-use.test.ts` — both axes, **plus** the planted-directive retention corpus as its own file, so a future change that narrows the gate fails on retention rather than quietly passing on recovery |
| R3 | `parser-adapter-registry.test.ts` (registry falls back to the hardcoded chain when empty); `deep-backend-parity.test.ts` (steps 1 and 2, byte-identity); the step-3 differences pinned as characterization, in the style of `validator-guarantee.test.ts` |
| R4 | `published-package-scope.test.ts` extended to both tarballs; per-language `*-symbols` / `*-validator` suites mirroring `go-symbols.test.ts`, each stating in its header which cases pass against the *unfixed* engine — §59's convention, and the thing that separates a test suite from a green one |

**Corpus discipline throughout:** freeze, pin commit + `sha256sum` manifest + `dist` hash, vary
only `dist/`, diff per row. Use `tools/corpus-harness/`; the hand-rolled loops have been wrong
twice. And the two standing traps: a paired comparison must be made over files that reduce under
*every* variant, and **byte-identical is not the same as inert** — L7 moved 0 of 576 rows because
0 of 45 Python corpus files contained the shape it fixed.

---

## 6. Risks

| risk | why it is real here | mitigation |
|---|---|---|
| A grammar manufactures symbols elision cannot destroy | §56/§59 measured exactly this on Go: 32 files elided at `S_k = 0.0000` with both gates green, one losing 78.4% of its tokens | R3 step 1's assertion is that `S_k` must not *fall*; per-language step 1 repeated at R4 before any grammar is wired to regions |
| Deep is slower than anyone expected and nobody notices | No latency instrument exists today | R2 builds it first; step 3 reports latency against a pinned baseline |
| The companion package drifts from core | Two packages, one engine contract | The contract is `ParserAdapter` in core; the parity suite runs against the published core, and both tarballs are scope-tested |
| G2 recovers fallbacks by deleting real instructions | The gate protects content; there is no reduction figure that buys back a lost directive | Two-sided measurement; the retention side gates the merge independently |
| The 2.0 flag break strands users | `--mode` is in READMEs and possibly in scripts | Withdrawn keys warn rather than throw (§4.2); the parse error names the positional form |

---

## 7. What this design deliberately does not do

- **It does not wire an exact tokenizer.** `cache_control` at 1,024-token boundaries needs
  `isExact: true`, which needs a caller-supplied `cl100k_base` encoder; the default
  `EnhancedHeuristicTokenizer` has 24% mean absolute error. That is a real precondition and it is
  unrelated to parsing. Held.
- **It does not make the Fast validators stronger.** §46 stands; `validator-guarantee.test.ts`
  stays as written. See §1.1.
- **It does not schedule BM25 or MMR.** Both preconditions measured false (§2.4).
- **It does not widen the Gateway.** Invariant 8.
- **It does not fix G4 or G5.** Both are real; neither blocks the spine. See §8.

---

## 8. Held, not forgotten

**An item in no table reads as done.** That sentence cost this project two false "audit closed"
claims (status-doc §6 and §8, DECISIONS §55). Every open item from the §2 survey appears below
with a disposition, so that the absence of one from R1–R4 is a decision rather than an oversight.

| item | disposition |
|---|---|
| G4 — sub-statement elision inside control-flow blocks | **Held.** 18 of 576 rows. Real and narrow. Competes with the spine for the same measurement budget; take it after R4 or in a gap |
| G5 — bundle-scoped drift | **Held.** `SEMANTIC_DRIFT_EXCEEDED` accounts for 0 of 117 corpus fallbacks (§51). Re-measure before scheduling — §51's lesson is that an open item is a claim about the current build and expires |
| G7 — exact tokenizer, `cache_control`, Milestone 8 | **Held.** Precondition is a caller-supplied encoder; `DEFAULT_TOKENIZER` is a one-line change, the dependency decision is not |
| G8 — `rehydrate_context` sub-query | **Held.** Unblocked since §44; the targeted-match response is a different return shape and must be designed, not fall out of adding a field |
| G9 — MCP over Streamable HTTP/SSE | **Held.** No premise problem — this one is simply not on the spine, and is the strongest candidate for the release after 2.0 |
| G9 — LiteLLM guardrail plugin, Prometheus `/metrics` | **Held with a premise note.** M7 (§54) fixed the measurement half, so a metric would now mean what it says; the premise half stands — there is no cross-turn saving to instrument. Export within-payload dedup and the fallback rate, or nothing |
| Security §9.1 item 5 — concurrency and timing | **Held.** Sessions racing on `pruneExpired`/`evictOldestSession`; the `getContent` prefix walk's timing profile |
| Security §9.1 item 6 — does a model act on forged provenance | **Held.** It is what separates Low from Medium on F-06/F-07, and it is an experiment rather than a fix |
| F-06 / F-07 residuals, D-1 / D-2 | **Recorded, not scheduled.** Reasons at §3.1 and §12.5 of the security review; D-1/D-2 downgrade sentences, not behaviour |

---

## 9. What is not established

Stated plainly, because this project's failure mode is a confident number nobody re-derived.

- **No language beyond the four has had its elidable ceiling measured.** The candidate set in §3.7
  is a list of grammars that exist, not a list of languages known to reduce. §3.7 step 1 is where
  that becomes a fact, and a candidate can fail it.
- **`web-tree-sitter`'s initialization cost is unmeasured**, and it is paid per process. For a CLI
  invoked once per file — which is how `tools/corpus-harness/measure.js` drives it — that cost
  lands on every run and could dominate the parse. This is a plausible reason for Deep to be
  unusable at the CLI while fine at the Gateway and MCP, and it is not yet known. Measure it in
  R3 before R4 commits to the packaging.
- **Whether one grammar really supplies all three seams** is an argument from tree-sitter's node
  types, not a measurement. Symbols and validity are near-certain; **regions are the uncertain
  one** — the body node of a Rust `impl` block or a C++ member function may not correspond to what
  `isSubstantiveRegion` assumes. R3 step 3 on the existing four is where that assumption meets
  evidence, on languages where the answer is already known.
- **G2's effect size is unknown.** That 24% and 18-of-20 are the *share of fallbacks* attributable
  to the gate, not the reduction recoverable by narrowing it. Some of those files will fall back
  for a second reason.
- **No projection in this document should be quoted as a result.** The only measured figures here
  are the ones carrying a DECISIONS or status-doc citation.

---

## 10. Sequence at a glance

```
R1  ship the backlog ────────────────► npm matches the tag
R2  constraint gate (2 axes, 2-sided) ─┐
    latency harness ───────────────────┴► a trustworthy instrument
R3  ParserAdapter seam + Deep path ────► a second backend, checked on
    (4 existing languages, 3 steps)      languages we can hand-check
R4  tokendamper-deep + grammars ───────► v2.0.0
    --mode fast|deep, old --mode gone
```

R1 blocks everything. R2 blocks R3–R4's numbers, not their code. R3 blocks R4 absolutely: a
backend first trusted where it cannot be checked is a backend nobody has checked.
