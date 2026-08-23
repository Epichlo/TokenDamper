# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

> **Entries citing retired documents are deliberate.** Audit M11 retired twelve narrative files;
> older entries still name them, because a changelog records what was true at the time and
> rewriting it would falsify that. See `docs/retired-documents.md` for where each conclusion
> lives now and how to read the original out of git.

## [Unreleased]

### Added
- **The CLI says when whole files were dropped to meet the budget.** `pruning:topology-pruner`
  removes entire items rather than eliding them, so the file is simply absent from stdout with no
  marker — and a caller piping that into a model cannot notice, because the model will not report
  a file it was never shown. It infers the API and is confidently wrong. Measured on a real
  8-item project at ratio 0.3, two modules vanished silently. The count was already in the trace;
  *which* files, and the fact that it happened, were nowhere a person reading a terminal would see.

  Pruning turns out to be common rather than exceptional: on a five-module fixture it fired at
  **every** ratio from 0.05 to 0.5, because `resolveTokenCeiling` derives the ceiling from the
  bundle, so a gentler ratio still lands below it.

- **`--keep-docstrings` keeps a Python function's docstring when its body is elided (DECISIONS
  §58).** The retention test found 3 of 4 lost answers lived in docstrings -- the *why* of a
  function, not its shape. Off by default, because measured it is a trade: keeping docstrings
  gives back **14.2%** of the saving on real pip code and **21.1%** on doc-heavy source
  (end-to-end 33.4% -> 27.5% on the expense-analyzer project, docstrings preserved 26 -> 51). The
  default path is 576/576 byte-identical; the flag is a runtime option that never touches the
  frozen `OptimizationBudget`, and it is inert on TypeScript/JavaScript, whose doc comments sit
  outside the body.

- **`DriftTracker.extractSymbols` sees Go function and method declarations (DECISIONS §59).**
  Step 1 of the three that widen elision to Go, and **Go is still unelidable after it** — reduction
  stays 0.00%, `trace.languageSupport` still reports Go unsupported, and 574 of 574 corpus rows are
  byte-identical. What it closes is a measurement hole, not a reduction one: a Go file with every
  function deleted but package, import and struct left standing used to score `S_k = 0.0000` with
  `astMeasured: true`, both gates passing and `fallbackUsed: false`, because the only symbols Go
  yielded were `type:` and `import:` ones that survive elision by construction. It now scores
  **0.6667** and the retention gate refuses.

  Signature-preserving body elision still scores 0.0000, which is required rather than a gap — that
  is what region elision does, and if it moved, step 3 would ship as a fallback generator. The
  change is that the gate can now tell those two apart; before, they were the same number.

- **Go has an AST-lite validator, so `.go` items are checked instead of skipped (DECISIONS
  §60).** Step 2 of the three that widen elision to Go, and **Go is still unelidable after it**
  — `regionElisionLanguage` needs the language in `REGION_ELISION_LANGUAGES` as well as a
  validator, and that is step 3. Measured on 80 frozen Go files: on the file route items no
  validator looked at go **80 → 0**, reduction stays **0.00%** in both arms, no new fallbacks,
  and output is **160/160 byte-identical**. Coverage moves; output does not.

  It is a Go lexer rather than a reuse of the TypeScript one, and the difference is measured
  over 9,181 real Go files (100.8 MB): the TypeScript lexer flags **73 (0.80%)**, this one
  flags **1 (0.01%)**, and that one file is the Go compiler's own deliberately-malformed
  testdata. The 72 it disagrees on are raw strings — `` strings.Contains(v, `\`) `` and a
  200-line shell template — because Go's backtick string has no escapes, spans lines, and is
  full of quotes and braces. Same finding as DECISIONS §17, measured for Go.

  A piped `.go` with no `--language` is still uncovered: there is no Go content probe, by the
  same rule as §31. Declare it, or pass `--input-name`.

  **It also exposed a reporting defect, recorded rather than fixed.**
  `DriftCoverage.symbolBearingItems` counts validator-*covered* items, not items bearing symbols.
  Go between §59 and §60 was the first language ever to have symbols without a validator, and that
  made the pair self-contradict: all 80 frozen Go rows reported `symbolsBefore = 3`+ next to
  `symbolBearingItems = 0`. `symbolsBefore` is the honest field. It is a trace field consumers
  parse, so changing it is its own decision — see DECISIONS §60.

- **Go elides. Elision now reduces four languages instead of three (DECISIONS §61).** Step 3 of
  three, and the one that changes output: a Go brace scanner, a `^func` keyword header test, and
  a statement splitter that boundaries on newlines because Go ends statements by semicolon
  insertion rather than by a written `;`.

  Measured on a frozen 80-file Go corpus at target 0.3: **application Go 27.46%** (32 of 40
  reducing) and **stdlib 19.42%** (25 of 40) — against this repo's TypeScript at 21.22% on the
  same engine, so the newest language is also the strongest. §56 projected 23–28% and
  application Go landed at the top of it. **The 287-file main corpus is 574/574
  byte-identical**: every Go path is gated on the language, so TypeScript and Python do not move.

  **`_test.go` is where most of the saving is** — 26.88% against 14.42% for source, with half
  the fallbacks, because Go's table-driven tests put large literal slices inside function bodies.

  Go now reports as supported on `trace.languageSupport`, and the "elision reduces
  TypeScript/JavaScript and Python only" explanation has been corrected wherever it is emitted.

  **Go falls back on 25% of files, and 18 of the 20 are `CONSTRAINT_DIRECTIVE_LOST`** — the
  descriptive-present-tense axis §52 deliberately left open (`// This never happens in practice`,
  `// Should never happen, but we`). §56 expected Go's lower comment density to make that gate
  fire less; measured, it dominates exactly as it does for TypeScript, at the same rate. The
  largest remaining gain on Go is in that gate, not in the scanner.

## [v1.6.0] - 2026-08-16

**Two defects that reached provider traffic, and an audit closed in full.** `max_audit.md` had
been declared closed twice while findings were open; this release ships the work that actually
closed it, plus a defect found by pointing an MCP client at this repository's own source.

**The one thing that can break a startup:** an unrecognized `TOKENDAMPER_*` enum value is now a
hard error instead of being silently ignored. Nothing that worked stops working — the setting
never took effect — but a stale or typo'd `TOKENDAMPER_LOG_LEVEL=verbose` that used to fall back
to the default now fails at startup. See the L1 entry below.

Minor rather than major on this project's standing rule: nothing removed, but the same command
over the same input emits different bytes. Minor rather than patch for the same reason.

### Fixed
- **`tokendamper exec` exits with the code its child exited with (audit OX-H1).** `runExecCommand`
  always resolved the real code. `runCli` threw it away: the `exec` branch fired the promise,
  attached a `.catch`, and returned a synchronous `0` that had already been assigned to
  `process.exitCode` before the child finished. The process stayed alive only because the spawned
  child holds the inherited stdio, so the code did arrive — into nothing. `tokendamper exec --
  aider … && next-step` therefore ran `next-step` after a failed tool, and any CI step wrapping a
  build in `exec` reported green regardless. Invariant 10 at the process boundary.

  `runCli` now returns `number | Promise<number>` — a union rather than a blanket `async`, because
  `optimize`, `bench` and `mcp` have their code immediately and every existing caller reads the
  result directly. `await` handles both.

  **The larger half of this fix was not in `exec` at all.** `package.json`'s `bin` points at
  `dist/src/cli/main.js`, so the shipped command runs the `require.main === module` block at the
  foot of the file — not the exported `main()` that tests and the wrapper call. The two had drifted
  into separate copies of the same assignment, and the copy at the foot carried a
  `typeof exitCode === 'number'` guard that was harmless dead code while `runCli` always returned a
  number. The moment `exec` returned a promise it became a silent drop: **the installed binary
  would have gone on exiting 0 with the entire suite green behind it.** The block now delegates to
  `main()`, and `test/integration/cli-exec-exit-code.test.ts` pins the delegation as well as the
  codes, because the defect was duplication rather than any particular line.

  Verified end to end on the built binary, not only through `runCli`: requested 0/3/42 give exit
  0/3/42, an unresolvable command gives 1, and `optimize` still exits 0.

- **`npm test` no longer collects suites belonging to other checkouts (audit OX-H3).** The
  repository had no vitest config, so collection used vitest's default `include` and walked the
  whole tree from the root. Agent worktrees live under `.claude/worktrees/<name>/` and each is a
  *full* checkout, `test/` included — so every stale worktree silently contributed a second, older
  copy of the entire suite. Measured: the canonical suite is **78 files / 723 tests**; the audit's
  run in a tree holding one stale worktree reported **155 / 1410**, almost exactly double, with the
  extra half two commits behind `main`.

  The cost is not wall-clock. A stale copy passes against its own frozen source, so a green run
  says nothing about the tree being edited — invariant 10 (a check that never looked reads exactly
  like a check that passed) arriving through the test runner itself. CI was never affected, because
  a fresh checkout has no `.claude/`, so "the suite" meant two different things locally and
  remotely.

  `vitest.config.ts` now anchors `include` to `test/**/*.test.ts` and restates `node_modules`,
  `dist` and `.claude` in `exclude` — restated because specifying `exclude` *replaces* vitest's
  default rather than extending it, and `dist` is not hypothetical: `tsc -p tsconfig.json` compiles
  `test/` as well as `src/`, so any build leaves a second copy of every suite in `dist/test/`.
  `globals: true` is set to make `tsconfig.json`'s existing `types: ["node", "vitest/globals"]`
  declaration true rather than decorative — no test relies on it today, all 78 import from
  `'vitest'` explicitly.

  `test/unit/test-collection-scope.test.ts` pins it, and pins the half that an anchored `include`
  puts at risk: that every suite in the repo really does live under `test/`, so the anchor is not
  hiding one. The guard was mutation-checked rather than assumed — widening the include, dropping
  `.claude` from exclude, deleting the config, and planting a suite outside `test/` each fail it.
  `npm run lint` needed no equivalent guard; it is already path-scoped as `eslint src test`.

- **A file that documents the block-hash placeholder format is no longer mistaken for a corrupted
  one — DECISIONS §57.** `detectCorruptedPlaceholders` scanned for `<BLOCK_HASH:([^>]+)>`, matching
  any text up to the next `>`. This repository's own `src/core/elision/regions.ts` contains the
  line *fixed width of `` `<BLOCK_HASH:` `` + 64 hex + `` `>` ``*, so the scan captured
  `` ` + 64 hex + ` `` as a hash, found it absent from the store, and failed the whole run.

  | | before | after |
  |---|---|---|
  | `regions.ts` over MCP | 0.00%, fallback | **32.00%** |
  | `token-hasher.ts` over MCP | fallback | **35.28%** |

  **22 files in this repo** carry a `<BLOCK_HASH:…>`-shaped string — `ARCHITECTURE.md` and
  `CHANGELOG.md` among them — and every one was unoptimizable over MCP. The capture now requires
  `[a-f0-9]{12,64}`, matching `ELISION_MARKER_PATTERN` beside it; a genuine placeholder absent
  from the store is still reported, which the tests pin as a negative control.

  **Only MCP was affected, and that is why nothing caught it.** The check returns early without a
  `TokenHasher` and the CLI supplies none, so the corpus harness — which drives the CLI — could
  not reach the gate. **576 of 576 corpus rows are byte-identical**, and here that means the
  instrument never ran the check rather than that the change is inert.

- **The Gateway forwards the caller's bytes instead of a re-encoding of them — audit M7, the last
  open finding (DECISIONS §54).** When an elision fired, the proxy rebuilt the request with
  `JSON.stringify`, which rewrote fields it had never touched. Measured on one payload:

  | client sent | provider received |
  |---|---|
  | `"temperature": 1.0` | `"temperature":1` |
  | `"top_p": 1e3` | `"top_p":1000` |
  | `"seed": 12345678901234567890` | `"seed":12345678901234567000` |

  The first two are cosmetic. **The third is a different number** — an integer past 2^53 does not
  survive `JSON.parse` → `JSON.stringify` — so a provider was asked for a seed the caller never
  chose. Duplicate keys collapsed the same way. Elided content is now spliced into the original
  bytes and everything else is left alone; where the caller's escaping differs from ours the
  splice declines and the request is forwarded unchanged, because a lost saving costs tokens and
  a corrupted field costs correctness.

- **A forwarded body can no longer be larger than the one that arrived.** M7's third consequence;
  nothing had ever asserted it.

- **A Python function whose body starts after a blank line is optimizable again — audit L7
  (DECISIONS §55).** `scanPythonDefBodies` read the body indent off `def` + 1 without checking
  whether that line was blank; `indentOf('')` is 0, so the region began at column 0, the marker
  inherited column 0, and `PythonValidator` rejected it. The audit rated this "fails safe (skip)"
  — measured, it costs the whole file, because a one-region file has nothing else to elide:

  | file | in | out |
  |---|---|---|
  | no blank line after `def` | 434 B | **96 B** (77.9%) |
  | blank line after `def` | 436 B | 436 B (0%, fallback) |

  **576 of 576 corpus rows are byte-identical**, because 0 of 45 Python corpus files have a blank
  line in that position. The instrument is blind to this one, which is §52's corpus-bias caveat
  with the sign reversed.

- **An unrecognized `TOKENDAMPER_*` enum value is rejected instead of silently ignored — audit
  L1.** `TOKENDAMPER_PLANNER_MODE=session_dedup` was discarded and the default used, while
  `--planner-mode session_dedup` threw; `session_dedup` is a real `OptimizationMode`, so nothing
  told the user their setting had not applied. All four enum variables now reject through one
  helper, naming the accepted values. Accepted sets are unchanged.

- **The TypeScript validator counts a line continuation as a line — audit L8.** Both escape sites
  advanced two characters without asking whether the skipped one was a newline, so every reported
  position after a `\`-newline read one line short.

### Changed
- **Three dead Gateway metric fields removed (M7 residue).** `GatewayOptimizationOutcome` still
  computed `rawTokens`/`optimizedTokens`/`tokensSaved` from `summary.tokenEstimate` after
  `wireTokenMetrics` replaced them at both call sites. The two disagree by design — 48.5% against
  47.1% on the same payload — and a field that looks authoritative next to the one that replaced
  it is how a closed finding comes back.

- **Three LOW findings are recorded rather than changed, with the reason at the site (DECISIONS
  §55).** L4 (`contentHash` chaining — unreachable; the audit's premise that it was ever a
  content-only hash does not hold), L5 (`getOverallConfidence` returns the minimum — correct for
  a safety gate; the doc comment was what was wrong), L9 (a 12-hex prefix is ample for provenance
  and birthday-bound for identity — not widened, because `TokenHasher.resolve` already treats an
  ambiguous prefix as unresolvable). L6's "Branch & Bound" comment named a search the code does
  not perform and now names the 1/2-approximation guard it is.

- **Gateway savings measure the bytes forwarded, not the bundle render (M7).** `rawTokens` and
  `optimizedTokens` came from `summary.tokenEstimate`, a property of items joined for a human or
  a model rather than the JSON a provider bills. Reported against measured on the same payload:
  **48.5% claimed against 47.1% actual**, now **46.3% against 46.5%**. Still counted in tokens
  through the one estimator — a saving in bytes compared against a budget in tokens is the
  two-estimator defect DECISIONS §19 exists to prevent.

## [v1.5.0] - 2026-08-12

**The gate stops refusing a file for its own commentary.** `CONSTRAINT_DIRECTIVE_LOST` accounted
for **29 of 29** code-bucket fallbacks (§51), and roughly twelve of those were a codebase
narrating its own history — *"has always read these two"*, *"could never have worked"* — not
instructing anyone. Four files that produced nothing now reduce, with 572 of 576 corpus rows
byte-identical and no regressions.

**This release also ends the version-reservation problem (DECISIONS §53).** v1.5.0 was held for
"Granular Sub-Query Re-hydration", and unlike the previous three collisions that release is
perfectly *buildable* — it simply had not been built, so §49's rule ("preconditions measured
false → no number") did not cover it. The general rule replaces it: **the roadmap reserves no
version numbers at all; a number is a fact about what shipped, assigned at ship time.** Four
reservations in four releases were wrong, each for a different reason, which is enough evidence
that predicting the order work finishes is not something this project should encode in a number.

Minor rather than patch, consistent with v1.3.0 and v1.4.0: nothing removed, but the same command
over the same input emits different bytes on 4 of 576 corpus rows.

### Changed
- **A narrative use of `never`/`always` in a comment is no longer a constraint directive
  (DECISIONS §52).** The constraint gate accounts for **29 of 29** code-bucket fallbacks on the
  frozen corpus, and roughly twelve of those were sentences like *"the MCP branch has always read
  these two"* or *"could never have worked"* — a codebase narrating its own history, not
  instructing anyone. §42 scoped this gate by region (a comment, not an expression); this scopes
  it by mood within that region.

  Narrowed in the safe direction three ways: only `never`/`always` (so *"must have been called"*
  is untouched), only provable perfect/past constructions (so *"is always"* keeps firing), and
  only when *every* keyword in the segment is narrative.

  **Per-row over 576 corpus rows: 572 byte-identical, 4 fallbacks fixed, 0 new, 0 files that
  stopped reducing, and no change to any row that was already reducing.** TypeScript file route
  39 → 43 reducing, 16 → 12 fallbacks.

  **The gain is not portable, and the caveat is the point.** All four recovered files are this
  repository's own source, which M11 measured as 32.8% comment prose written in a
  what-used-to-be-true style. Python gained nothing. The 6pp on the TypeScript bucket is the
  corpus-bias trap `CLAUDE.md` warns about, appearing as a favourable number — the harder
  direction to notice.

## [v1.4.0] - 2026-08-12

**The target adheres.** v1.3.0 made `--target-reduction-ratio` bind and recorded that adherence
was partial for a structural reason: elision's smallest unit was a whole function body, and files
typically have one dominant region. This divides the region into its statements, which takes the
population of files overshooting past 50% from **34 rows to 18** with **zero regressions** —
no new fallbacks, no file that stopped reducing.

**Numbered 1.4.0, and the roadmap's reservation on that number was released** rather than moved,
per the rule adopted in §49: a release whose preconditions are measured false holds no version
number. "AST Code Folding & Cache Alignment" is now unnumbered — its Fast-mode half is already
shipped in `elision/regions.ts`, and its cache-alignment half needs a caller-supplied
`cl100k_base` encoder before 1,024-token quantization means anything. This is the third time a
reservation has collided with real work; releasing the number is what stops it recurring.

A minor rather than a patch, for the same reason as v1.3.0: nothing is removed, but the same
command over the same input emits different bytes on 54 of 576 corpus rows.

### Changed
- **Elision divides a region into its statements when a ceiling is set (DECISIONS §50).** The
  smallest thing the stage could remove was a whole function body, which is what made
  `--target-reduction-ratio` overshoot: files typically have one dominant region — 58%, 61%, 83%
  measured — and a body cannot be taken in part. `splitRegionIntoStatements` divides at depth-0
  boundaries only, so every candidate is bracket- and quote-balanced and removing one cannot cut
  a statement in half.

  **Per-row A/B over one frozen corpus, 576 rows, both routes, target 0.3 — no regressions:**

  | | baseline | after |
  |---|---|---|
  | rows above 50% achieved | 34 | **18** |
  | rows reducing | 95 | **99** |
  | new fallbacks | — | **0** |
  | rows that stopped reducing | — | **0** |
  | moved closer to target / further | — | **39 / 11** |

  522 of 576 rows are byte-identical; every changed row is TypeScript or Python under a ceiling.
  Subdivision is confined to the ceiling path, so a run with no target behaves exactly as before.

  **A division that would throw most of its region away is refused**, because the marker floor
  drops short statements and the caller would lose the whole region as an option — measured at
  38.9% → 6.6% on one file before the guard. The threshold was swept rather than chosen; §50
  carries the table, including the setting that scores better on overshoot and costs two working
  files, and why that trade was not taken.

## [v1.3.0] - 2026-08-12

**The flag that did nothing now does what it says.** `--target-reduction-ratio` is the flag every
document and example uses, and until this release it was an on/off switch: any value produced
byte-identical output, and compression ran to exhaustion rather than to the requested figure.

**Numbered 1.3.0, and the roadmap's reservation on that number was released rather than worked
around.** `ROADMAP.md` had v1.3.0 reserved for "Context Selection Quality & Redundancy
Elimination", whose two headline deliverables were both measured unbuildable — BM25 has no query
source anywhere in `src/`, and MMR found 0 of 1,486 real pairs above its threshold. A release that
cannot be built should not hold a version number while a shipped behavioural change waits behind
it; that section is now unnumbered and gated on its preconditions instead. The same collision
happened once before, when v1.2.0 took the number this document had reserved for the same
release — resolving it by renumbering the chain twice is what made it recur (DECISIONS §49).

A minor rather than a patch: nothing is removed, but the same command over the same input emits
different bytes, and `Changed` is where that belongs.

### Changed
- **`--target-reduction-ratio` is a real target — audit H4's deferred half (DECISIONS §48).**
  It was an on/off switch: the planner read it as `> 0` and nothing else read it, so `0.01` and
  `0.99` produced byte-identical output. `resolveTokenCeiling` now converts the ratio into an
  absolute token ceiling, `pruning:topology-pruner` gates on that ceiling instead of
  `maxInputTokens` (it used to bypass itself entirely when only a ratio was set), and
  `compression:token-hashing` stops once the ceiling is met instead of eliding everything it can.

  **Corpus aggregates fall by design.** The harness measures at ratio 0.3, so runs that used to
  overshoot to 44–69% now stop near 30%: python file 23.14% → 20.26%, typescript file 23.03% →
  17.57% — while fallbacks *fell* (python 14 → 13) and reduced counts *rose*, because less
  aggressive elision survives validation more often. Compare per-file adherence, not the mean.

  **Adherence is partial and the limit is structural.** Elision's smallest unit is one region and
  files typically have one dominant region (58%, 61%, 83% measured). At target 30%, 21 of 66
  reducing files landed in 25–35% and 23 still exceeded 50%. Sub-region elision is what would
  close that; it is not attempted here.

### Documentation
- **Audit finding M7 is reinstated as open, having been silently dropped.** No behaviour changed;
  what changed is that the documents stop saying every audit item is closed.
  `docs/audit-remediation-status.md` §6 records the finding, its three consequences re-verified
  against source at `5c7919b`, and why the re-serialization half is not a metrics fix. M7 was
  gated in `ROADMAP.md` behind *"only if question B keeps the Gateway"*; question B was answered
  in DECISIONS §41 and nothing carried M7 across the answer, so it entered no wave table and
  read as done. **An item that is in no table reads exactly like a check that never ran.**

- **The measured baseline was re-taken rather than annotated** (status doc §2): 288 files / 576
  rows at `5c7919b`, clean tree, both routes, target 0.3 — python file **20.26%**, python stdin
  **19.78%**, typescript file **17.57%**, everything else 0.00%. The previous table was pre-§48
  *and* over a different corpus (297 files: typescript 60 → 62, prose 29 → 18 after M11), so it
  was stale twice over while being labelled "the numbers to compare against".

- **Stale gates cleared across `ROADMAP.md`.** Its Version Summary table was a full renumbering
  behind the chain at the top of the same document, still listing v1.1.1–v1.1.3 as "Next —
  blocking" after all three shipped inside v1.2.0. v1.5.0 was marked blocked on M5b, which
  shipped in Wave 2; Milestone 8 blocked on question A, answered by §43; Milestone 9 pending C1
  and H6, both shipped; v1.4.0's `cache_control` blocked on H5, whose actual remaining
  precondition is tokenizer exactness. Each is now marked with what replaced it, not deleted.

- **`README.md`'s Phase 1c table is labelled as pre-§48.** Its 22.73% / 19.47% were measured at
  target 0.3 before that ratio bound; the same corpora now read 20.26% / 17.57% with fewer
  fallbacks.

### Removed
- **The `format` script, `prettier`, `eslint-config-prettier`, `.prettierrc.cjs` and
  `.prettierignore` (DECISIONS §49).** `npm run format` has never passed and nothing has ever
  invoked it: CI runs typecheck, lint, build and test, and so does `prepublishOnly`. Measured
  before removing it, `prettier --check .` failed on **148 files** — every markdown document and
  all 57 TypeScript sources — for two independent reasons: prettier defaults to
  `endOfLine: "lf"` against a CRLF working tree, and the real formatting drift underneath that is
  ~5,118 lines in `src/` plus ~1,900 in the docs.

  Making it pass would have rewritten the whole repository, including the in-source commentary
  that is 32.8% of `src/` and is maintained next to the code it explains. This is audit H4's
  principle applied to a dev script rather than a CLI flag: **a check that has never run is not a
  check, and leaving it red teaches everyone to ignore the one instrument that is red for a
  reason.** `eslint` remains the enforced style gate and is green without
  `eslint-config-prettier`, which existed only to defer to a formatter that is no longer here.

### Fixed
- **`package-lock.json` carried `"license": "MIT"` and `"version": "1.1.0"`.** Audit M3 corrected
  the license in `package.json` and the lockfile mirror was never regenerated, so a file in the
  repository still asserted the pre-M3 license. Not a published claim — npm reads `package.json` —
  but M3 was about a stale copy of exactly this fact, and this was the last one.

## [v1.2.0] - 2026-08-11

**The audit remediation release.** 78 commits beyond `v1.1.0`, closing every finding in
`max_audit.md` and the architectural work that followed from it. `docs/audit-remediation-status.md`
is the index; `DECISIONS.md` §36–§47 carries the reasoning.

**Numbered 1.2.0 rather than 1.1.1**, for two reasons. The roadmap planned the remediation as
three releases — v1.1.1 "Green Tree & Correct Metadata", v1.1.2 "Data Loss & Corruption",
v1.1.3 "Honest Instruments" — and this ships all three plus the Scope Decision Gate answers
(H2, M1, M11) and Phase 1c. And it removes command-line surface, which a patch release is not
permitted to do.

### ⚠ Breaking

- **Three CLI flags removed**, along with their environment variables: `--risk-tolerance`
  (`TOKENDAMPER_RISK_TOLERANCE`), `--max-output-tokens` (`TOKENDAMPER_MAX_OUTPUT_TOKENS`) and
  `--max-latency-ms` (`TOKENDAMPER_MAX_LATENCY_MS`). They are now a hard `Unknown argument`
  error rather than being accepted and ignored.

  **Nothing functional was lost.** No stage, validator or planner ever read them — risk tolerance
  reached one benchmark display column and stopped. A script passing them will now fail instead
  of silently doing nothing, which is the point: the previous behaviour reported success for a
  setting that had no effect (audit H4, DECISIONS §44).

- **MCP `optimize_context` no longer accepts `riskTolerance`.** Same reason. It gained
  `targetReductionRatio`, which is the parameter that actually does something.

- **`GatewaySessionStoreInterface` requires `getSession`.** Any third-party implementation must
  add it. Reading a session must not create one (audit M5).

- **The Gateway no longer reads `TOKENDAMPER_MOCK_UPSTREAM` or `NODE_ENV`.** Both are now
  explicit options (`mockUpstream`, `allowMissingUpstreamCredentials`). A proxy in an environment
  that happened to set either no longer changes behaviour (audit M8, DECISIONS §44).

### Highlights

- **The MCP entry mode does something.** `optimize_context` had no budget parameter, so it was a
  guaranteed 0% no-op that reported success. Measured through the stdio server: 0 stages / 0.0%
  without a budget, 4 stages / **69.1%** at `targetReductionRatio: 0.3`.
- **`optimize` takes multiple files and directories**, which is what makes the 0/1 knapsack
  reachable at all. On this repo's `src/core` at `--max-input-tokens 4000`: 31 files in,
  **15 pruned, 20,540 tokens saved** by the planner.
- **One bad item no longer reverts the good ones** (Phase 1c). On the 45-file Python corpus the
  stages were already achieving 42.52% while the product emitted **0.00%**, because 26 constraint
  failures across 14 items reverted all 45. It now emits **22.73%**.
- **Structured provider content survives the Gateway.** A `tool_result` block could ship as a
  bare string — a `400` from Anthropic — and the audit's "masked by the drift gate" assessment
  was wrong for the one case the Gateway actually saves on.
- **A 0% result now says why.** Whether a budget was in effect (`budgetApplied`), whether any
  transform could reduce the language at all (`trace.languageSupport`), and whether items were
  reverted (`trace.itemsReverted`).
- **`tokendamper bench` runs when installed.** It threw for every user outside a checkout.
- **The docs say what the validators actually check** — bracket/quote integrity, not syntax
  validity — with a per-language table pinned by tests.

### Known limitations, stated deliberately

- Elision reduces **TypeScript/JavaScript and Python only**. Twelve of nineteen recognised
  extensions cannot produce a non-zero reduction under any flag; runs on them now say so rather
  than returning a silent 0%.
- **Gateway mode is experimental** and saves nothing across turns by design.
- `--target-reduction-ratio` engages the planner but is **not** a proportional target; the planner
  reads it only as `> 0`.
- Drift remains bundle-scoped: a run failing on drift alone still falls back whole.

### Documentation
- **`docs/audit-remediation-status.md` is the entry point for audit work**, and `CLAUDE.md` points
  at it. It carries what is merged, the measured corpus baseline, exactly what Wave 2 requires,
  and the traps this codebase has for anyone changing it — replacing status prose scattered across
  several documents rather than adding to it (audit M11).

  `CLAUDE.md` corrections, all of which other notes reasoned from: *"`createContextBundle` makes a
  single-item bundle for CLI/bench, so `R_AST` is a boolean"* is false on both halves since §43;
  *"for code, `R_struct` is pinned at 1.0"* is fixed by §40 (and the audit's proposed fix for it
  was measured **inert**); invariant 9's rationale restated, since `emittedOutput` is no longer a
  newline-joined blob; the 19.27% figure marked as belonging to a smaller corpus.

- **Corpus harness recipe: `typescript` 57 → 59**, the two files H5 added. `collect.js` would
  otherwise refuse on the next run — which is it working as designed. A clean post-wave baseline
  is recorded in the status doc: Python **23.14%** (file) / **22.66%** (stdin), TypeScript
  **25.35%** (file) over 59 files. That last figure is *not* comparable to §43's 29.55%: same
  engine, larger denominator.

- **Corpus harness recipe, again after Wave 2: `typescript` 59 → 60, `prose` 28 → 29.** The
  TypeScript file is `src/bench/fixtures/bundled-path.ts` (M10); the prose file is
  `docs/audit-remediation-status.md`, which landed in `7a1b5a7` **after** the `dd540fe` baseline
  was recorded and was therefore already outstanding. `collect.js` refused on both before
  measuring anything.

  TypeScript file reads **23.26%** over 60 files, down from 25.35% over 59 — and that movement is
  entirely the denominator: `reduced` is unchanged at 33, and a per-row A/B against the
  pre-Wave-2 engine over the *same frozen corpus* found **594 of 594 rows identical** across 15
  fields. Wave 2 changes no stage output. See DECISIONS §44.

### Added
- **A file that fails a check no longer reverts the rest — Phase 1c, audit §3.1.** Validation is
  bundle-scoped and fallback was all-or-nothing, so on the frozen 45-file Python corpus the
  stages achieved **42.52%** and the run emitted **0.00%**: 26 `CONSTRAINT_DIRECTIVE_LOST` errors
  across 14 items reverted all 45, with drift at 0.0359 against a 0.40 gate and AST clean.

  Failures that name an item now revert only that item; the repaired bundle goes back through the
  **same** `validate` and is emitted only if it passes. Repair changes which bundle is offered,
  never what counts as valid.

  | bundle | before | after | reverted |
  |---|---|---|---|
  | 45 Python files | 0.00% | **22.73%** | 14 |
  | 61 TypeScript files | 0.00% | **19.47%** | 21 |

  Three supporting changes: `ValidationIssue.itemId` is a field rather than text interpolated
  into `message` (recovering it by regex would have been audit M5b exactly); `validate()` returns
  `attribution` with `repairableItemIds` and `hasUnattributableError`; and `trace.itemsReverted`
  names what was put back, so a partial success cannot be mistaken for a clean run.

  **The refusal rule was tried too strict and corrected by measurement.** "Refuse if any error is
  unattributable" reads as the conservative choice, but the TypeScript bundle fails on both
  attributable constraint losses *and* `SEMANTIC_DRIFT_EXCEEDED` at 0.4122 — so the failure that
  named nothing discarded the attribution that named 21 items, and the run stayed at 0.00%. The
  gate is now "is there a principled subset to revert?", which is safe because the candidate is
  re-validated regardless: reverting items lowers semantic loss, and drift fell 0.4122 → 0.0056
  (TypeScript) and 0.0359 → 0.0141 (Python).

  Repair declines, and routes to the real fallback, when *every* changed item would be reverted —
  that is a fallback wearing a different name, and the distinction is load-bearing because
  fallback echoes `request.rawInput` (the CLI writes the original `Buffer`) while repair renders
  from items. DECISIONS §35 exists because those are not the same bytes for non-UTF-8 input.
  Measured: 14 of 14 single-file fallbacks remain byte-identical, and **574 of 574 corpus rows
  are unchanged** — the harness measures single-file runs, where repair cannot fire.

- **A 0% run now says whether the language could ever have been reduced — audit H2.** Twelve of
  nineteen recognised extensions cannot produce a non-zero reduction under any flag combination,
  and that was indistinguishable from a file with nothing worth compressing. `trace.languageSupport`
  now carries `supported`, `unsupported`, `unsupportedLanguages`, `noneSupported` and a `reason`,
  and `validate()` raises an **info** issue (`LANGUAGE_NOT_ELIDIBLE`) that does not vote on the
  verdict. Every language is still accepted — pass-through is byte-identical, and refusing it
  would remove a working behaviour to make a point.

  Measured, elision reduces **3 of 17** probed languages (TypeScript, JavaScript, Python), which
  is the audit's headline and the corpus agreeing independently. The predicate is
  `supportsRegionElision` and nothing looser: a first attempt asked "does the item yield symbols?"
  and called Go supported, because a trivial Go file yields exactly one — `import:fmt`, an
  incidental match by the TypeScript import regex.

- **`optimize` accepts multiple paths and directories — audit H5**: `tokendamper optimize a.ts
  b.ts` and `tokendamper optimize ./src`. This is what makes the 0/1 knapsack reachable:
  `createContextBundle` produced exactly one item for every shipping entry point, prefix locking
  pinned item 0, the solver always selected it, and `itemsPruned` was always 0 — so the knapsack,
  cache-aware prefix locking, topology scoring, the dependency graph and the git inspector could
  not affect any output the product could produce. Measured on `src/core` at
  `maxInputTokens: 4000`: **31 items, 15 pruned, 20,540 tokens saved by the planner.**

  One item renders as its content and nothing else, so CLI, MCP and bench stay byte-identical.
  More than one renders with a `==> path <==` header per item. Fail-open is **per file** — each
  file's original bytes, never a re-encoding — so DECISIONS §35 holds per item; the stream as a
  whole is not byte-identical because the headers are TokenDamper's. Directory walks are sorted
  (prefix locking pins the first ~1,024 tokens, so order decides what bypasses the knapsack) and
  skip `node_modules`, `dist`, `.git` and friends.

  **Multi-file runs still fall back on real corpora**, and not for any reason this change can fix:
  on the 45-file Python corpus, drift 0.0359 and AST clean, but 26 constraint failures across 14
  items revert all 45. Validation is bundle-scoped and fallback is all-or-nothing (audit §3.1,
  Phase 1c). This delivers the mechanism; §3.1 stands between it and the outcome. See DECISIONS §43.

### Removed
- **Twelve narrative documents, 226 KB — audit M11.** `NOTES-FOR-DOCS.md`, `study.md`,
  `purposed architecture changes.md`, `tokendamper-headroom-known-issues.md`, and the eight
  `docs/phase-*` / `docs/issue-2-*` files. Markdown drops from 31 files to 19, and markdown:src
  from 1.40:1 to **0.95:1**. `docs/retired-documents.md` maps each file to where its conclusion
  now lives and gives the `git show` command to read the original.

  **The 4.1:1 premise was stale**: measured before acting it was already 1.40:1, and not because
  the docs had shrunk — they had grown to 726 KB — but because `src/` grew faster. Since **32.8%
  of `src/` is comment prose**, prose:code actually ran ~2.6:1. The in-source commentary is
  deliberately kept: the failure mode M11 names is two copies of an argument kept in sync by hand,
  and a comment next to its code is not that.

  Twenty-five source and test citations to retired documents are marked `[retired]` rather than
  re-pointed — the citation names something git still holds, and re-pointing 25 of them by hand
  would risk mapping some to the wrong place. `CHANGELOG.md` and `DECISIONS.md` keep their older
  citations untouched, each with a note saying why: they record what was true when written.

- **Three knobs that were parsed, validated and then read by nothing — audit H4.**
  `--max-output-tokens` and `--max-latency-ms` (with `TOKENDAMPER_MAX_OUTPUT_TOKENS` and
  `TOKENDAMPER_MAX_LATENCY_MS`) reached no consumer anywhere in the pipeline;
  `--risk-tolerance` / `TOKENDAMPER_RISK_TOLERANCE` / the MCP `riskTolerance` property reached
  exactly one, `cli/bench-table-renderer.ts:97`, which prints it in a column. Setting any of them
  exited 0 and changed nothing.

  Removed from the **surface only** — the `OptimizationBudget` fields stay, because
  `ARCHITECTURE.md` pins that model as frozen; each now carries a doc comment naming its consumer
  or stating it has none. A removed flag is a hard `Unknown argument` error, not a silent no-op.

  `--target-reduction-ratio` deliberately stays despite the planner reading it only as `> 0`:
  it is the only budget flag every doc and example uses, and making it a real proportional target
  is a planner change. See `docs/audit-remediation-status.md`.

### Fixed
- **Structured message content was flattened to a string and shipped as one — audit C4, and it
  was *live*, not latent.** The Gateway ingests a provider message as
  `JSON.stringify(msg.content)` and used to write the optimized item back as a plain string, so a
  message whose content was `[{"type":"tool_result","tool_use_id":"toolu_01ABC",…}]` could reach
  the provider as a bare string — a `400 invalid_request_error` on Anthropic, and broken
  multimodal parts on OpenAI.

  The audit records this as "masked by H1 — that is luck". **Measured, the mask covers only half
  the cases.** A cross-turn *sole* copy is scored in full by drift and does fall back. Content
  duplicated **within one payload** is elided `recoverable: true`, which drift exempts by
  substitution — no fallback, and it ships. On the pre-fix engine that payload returned
  `messages[2].content` as the string `"{\"__td_block__\":\"[TokenDamper Elided: …]\"}"` with
  `fallbackUsed: false` and `tokensSaved: 42`. Within-payload duplication is also the only case
  the Gateway saves anything on at all (DECISIONS §41), so C4 was live on exactly the path the
  mode exists for.

  Items now carry `contentShape`, and `core/elision` refuses to elide anything structured —
  at the shared chokepoint rather than in the Gateway, so the guard survives any widening of the
  stage list. `ElisionSkipReason` gained `'structured_content'`, which failed to compile in all
  three eliding stages until each acknowledged it, and stages report
  `skippedStructuredContent`. Untagged items are treated as plain text, so CLI, MCP and bench are
  unaffected — confirmed by **594 of 594 corpus rows identical** to the pre-fix engine.

- **A hole in `messages` shifted every later item onto the wrong message — audit C4.** Ingestion
  skips falsy entries with `if (!msg) continue`, while egress indexed `finalBundle.items[idx]` by
  array position. Also **not** masked: the pinning test fails against the pre-fix engine with
  `expected 'ok' to be 'export function helper0…'` — the assistant's message had received the
  previous item's content. Items now carry `payloadSlot` and egress looks it up, which also
  survives a stage that reorders or drops items.

- **The Anthropic `system` prompt is mapped back — audit C4.** It was ingested as `items[0]`
  while the egress map started at `itemOffset`, so any change to it was dropped from `finalBody`
  while `optimizedTokens` — and therefore `tokensSaved` and `dedupRatio` — still counted it as
  saved. **This path is unreachable today** (`cleanup:session-dedup` refuses system items, and
  rehydration needs `rehydrateRefs`, which the Gateway does not set); the change makes the
  mapping correct for when it is not, and guards the `finalBody` rebuild against dropping or
  duplicating `system`.

- **The MCP entry mode did nothing — audit M5a.** `optimize_context` had no
  `targetReductionRatio` parameter, so a client calling the tool as documented got
  `pass_through`, zero stages, the input back unchanged and `reductionRatio: 0` with **no
  error**. The parameter is now in the schema (range-checked, and rejected rather than clamped),
  the description states that a budget is required, and the response carries `budgetApplied`,
  `planMode`, `stagesExecuted` and a `notice` when no budget was in effect — so a 0% result can
  no longer hide whether anything ran. Measured through the stdio server on
  `src/core/planner/index.ts`: **0.0% / 0 stages without a budget, 69.1% / 4 stages at
  `targetReductionRatio: 0.3`**, cross-checked against the CLI's `tokenEstimateSaved: 586` on the
  same file.

- **MCP session rehydration had never worked — audit M5b.** `rehydrate_context` looked for
  `<ELIDED: ref=… >`; `cleanup:session-dedup` emits `[TokenDamper Elided: ref=… bytes=… kind=…]`.
  The pattern could not match any marker the product produces, so the tool returned its input
  unchanged on every call. `renderSessionElisionMarker` and `SESSION_ELISION_MARKER_PATTERN` now
  live together in `core/elision/marker.ts` and are used by both sides; the new test builds its
  marker by **running the stage** rather than restating the format, which is how the two drifted
  apart in the first place.

- **Gateway response headers were the caller's request headers — audit M9.** Both optimize paths
  spread `cleanHeaders` into the response, and `cleanHeaders` strips only `host` and
  `content-length` — so `authorization`, `x-api-key` and cookies came back out on the way down.
  Response headers are now constructed explicitly.

- **`bench` threw for every installed user — audit M10.** The bundled datasets resolved against
  `process.cwd()` only, and `test/` was not in `package.json`'s `files`. Fixtures now ship, and
  resolve against the working directory first and the package root second — the root found by
  walking up to the nearest `package.json`, because this module runs at two different depths
  (`src/…` under vitest, `dist/src/…` compiled) and a fixed `..` offset is right for exactly one.
  Verified by running the built CLI from a directory with no `test/` tree. Also:
  `loadBenchmarkFixtures` no longer throws `EISDIR` when handed a directory.

- **MCP reads no longer create state, and traces no longer leak between servers — audit M5
  (minor).** `get_session_metrics` and `resources/read` called `getOrCreateSession`, so asking
  about an unknown session invented it — reporting a plausible all-zero record and, under
  `maxSessions`, potentially evicting a live one; both now use the new read-only
  `GatewaySessionStore.getSession` and report a miss. `traceStore` was a module-level `Map`
  shared by every server in the process and is now per-server. `initialize` now negotiates
  against the client's requested protocol version instead of asserting its own unconditionally.

- **Three defects H5 exposed, each fixed with it**: pruning was scored as semantic drift
  (`findUnwitnessedItems` exempted pruned items but the ratios compared whole bundles — now scored
  over retained items, guarded on ids corresponding so a caller that rebuilds its bundle gets more
  measurement rather than none); whole-item elision of a symbol-bearing item is no longer attempted
  (since §40 it scores `S_k = 1.0` and can never survive validation — two pure-`types.ts` files
  were taking a 16-file batch down); and `TD_PRESERVE:` no longer matches its own implementation
  (`drift-tracker.ts` and `cli/html-reporter.ts` each acquired a phantom content marker, and one
  such marker being elided drove `R_struct` to 0 and a 16-file batch to `S_k = 0.4053` on a run
  with **99.1%** real symbol retention — this also retires the `html-reporter.ts` regression §40
  recorded as deliberate). Also: envelope headers were counted on the output side only, so a
  multi-item fallback reported 72,973 → 73,667 tokens, the same shape as the phantom −1.39%
  (Issue 5). Corpus: **1 row changed, 0 regressions**, TypeScript 27.33% → **29.55%**.

- **Constraint directives are extracted from prose regions, and checked per item — audit H6**:
  the nine-keyword imperative scan (`must`, `never`, `required`, `critical`, …) is written for
  natural-language prompts and was applied to raw content of every kind. In source, `required`
  and `critical` are ordinary identifiers, and `CONSTRAINT_DIRECTIVE_LOST` was the single largest
  cause of code not being optimized — **24 of 40 fallbacks** on the audit's corpus.

  Measured over a frozen 293-file corpus, classifying every dropped directive by origin: Python
  **16 prose / 38 code** (nearly all `logger.critical(...)`), TypeScript **38 prose / 13 code**
  (`readonly required?`, error-message literals). So neither extreme works — trusting it
  everywhere keeps 51 false positives, and the audit's proposed "skip `code` entirely" discards
  54 genuine constraints including the Python docstring case that
  `docs/phase-1d-semantic-gate-disposition.md` measured this check to be the only thing catching.
  The separator is the **region**, not the content type.

  Extraction now covers line comments, block comments and Python docstrings within code, and
  whole content for prose types. Retention is checked **per item** rather than against a joined
  blob — previously a directive from item A was satisfied if the string appeared anywhere in item
  B, so the check could pass for content that was destroyed, and a loss anywhere failed the whole
  run with no attribution. Items absent from the after-bundle are skipped (selection is not
  elision, matching `findUnwitnessedItems`).

  | bucket / route | before | after |
  |---|---|---|
  | python (file) | 14.98% | **23.14%** |
  | python (stdin) | 14.88% | **22.66%** |
  | typescript (file) | 23.38% | **27.33%** |

  **20 of 586 rows changed, none regressed.** TypeScript now has zero code-sourced directives
  remaining; every surviving `CONSTRAINT_DIRECTIVE_LOST` is a genuine imperative in a comment or
  docstring, which is the check working rather than misfiring. Landed after §37 deliberately —
  this check was previously the only thing preventing markdown deletion. See DECISIONS §42.

- **`tokendamper exec` reaches its own gateway — audit C3, L2 (partial)**: `runExecCommand`
  injected a token as `TOKENDAMPER_GATEWAY_TOKEN`, a variable **nothing in `src/` read** and no
  third-party client has heard of, while the server required it on every request. Reproduced by
  spawning a real child: every request returned `401`, and `exec` exited **0**. The existing
  suite passed throughout because its gateway test presented the header no real client sends.

  Loopback peers are now trusted — the server binds to `127.0.0.1`, so a loopback peer was
  already the only peer able to connect, and the token was protecting one local process from
  another while costing the entire mode. Determined from `req.socket.remoteAddress` (never a
  header, since `X-Forwarded-For` is attacker-supplied), including `::1` and `::ffff:127.0.0.1`.
  The token is still enforced on any non-loopback bind.

  **`HTTP_PROXY`/`HTTPS_PROXY` are no longer set.** `GatewayServer` implements neither
  absolute-form request URIs nor `CONNECT`, so any child honouring them would have failed to
  reach the provider entirely — a second failure, independent of the 401 and masked by it.
  Base-URL interception is now the only supported mechanism. Also removes `?token=` query
  authentication (a credential in logs and shell history) and makes the header comparison
  constant-time.

### Changed
- **The documented guarantee is "bracket/quote integrity", not "syntax validity" — audit M1.**
  The TypeScript validator builds no AST; it is a lexer detecting unbalanced brackets and
  unterminated strings. Probed against the shipped code, it passes `const x = ;`,
  `import from "x";`, `let 123abc = 5;`, `const a = 1 +++++ 2;` and plain English prose, failing
  only on `super(; }`. `README.md` gains a per-language table of what each validator does and does
  not catch; `CLAUDE.md` says the same; `test/unit/validator-guarantee.test.ts` pins every row as
  a characterization test, so strengthening a validator fails the test on purpose and the table
  has to move with it.

  Wiring the real TypeScript compiler API was **refused on cost, not principle**: `typescript` is
  a development dependency today, and promoting it to runtime costs install size and parse latency
  against a lexer that runs in single-digit milliseconds.

- **Gateway test seams are parameters, not environment variables — audit M8.**
  `TOKENDAMPER_MOCK_UPSTREAM=true` made the proxy return the caller's own optimized prompt with a
  200 as though a model had written it, and `NODE_ENV === 'test'` waived the missing-credentials
  401 — a variable many CI systems set for unrelated reasons. Both env reads are **removed**, not
  demoted to fallbacks, and replaced by `mockUpstream` and `allowMissingUpstreamCredentials` on
  `ProxyHandlerOptions`, `GatewayConfig` and `ExecOptions`.

  Ten tests in `test/unit/gateway.test.ts` failed the moment the `NODE_ENV` branch went — they
  had been passing *because vitest sets that variable*, none of them mentioning it. That is the
  finding, demonstrated.

- **Gateway mode is documented as experimental, and the cross-turn saving claim is withdrawn —
  audit H1, M4**: measured over real sockets on two-turn conversations where a resent history
  contains each block once, the Gateway saves **0 bytes and falls back on every turn**, for code,
  prose and JSON tool results alike.

  This is a design conclusion, not a defect. `cleanup:session-dedup` marks an elision recoverable
  only when an intact copy survives in the same payload (§16); a sole copy seen only in a previous
  turn is refused because the consumer is a stateless provider API with no rehydration mechanism,
  so the marker would be deletion rather than reference. No cross-turn transform is available
  without provider-side resolvability, which does not exist.

  README, ARCHITECTURE.md and CLAUDE.md invariant 8 now say so. The measurement is pinned by
  `test/integration/gateway-dedup-reality.test.ts` rather than left as prose — if a cross-turn
  saving ever appears, either resolvability was implemented or the drift gate was relaxed.

  The remaining M4 claims are resolved rather than deferred: knapsack planning marked
  implemented-but-unreachable (H5), token hashing qualified as irreversible on the CLI by design,
  and `TOKENDAMPER_RISK_TOLERANCE` marked as having no effect on optimization (H4, still open).
  See DECISIONS §41.

- **`R_struct` no longer votes on evidence it never gathered, and a local variable is no longer
  a symbol — audit C1b, §3.2**: two changes that only work together.

  **The audit's proposed fix is inert on its own.** §3.2 proposed computing `R_struct` over
  `extractContentMarkers` to exclude the indestructible `filepath:` marker, and said this "would
  fix both cases at once". Measured, it fixes neither: removing the only marker an item had
  leaves the before-set empty, and an empty set defaults `R_struct` back to **1.0** — the
  identical free 0.40 by another route. That change alone was byte-identical across all 586 rows
  of a frozen 293-file corpus. The free 0.40 comes from the **empty-set default**.

  So an unmeasured ratio is now *excluded* from the score rather than defaulted, with its weight
  redistributed. For code `S_k = 1 - R_AST`, and the maximum symbol loss that can pass falls from
  **66.7% to 40%**. When neither ratio measured, retention stays silent — that case belongs to
  the measurement gate (§37).

  **Applied alone, that cost 14 TypeScript files and 11.75pp — guarding against loss that was
  almost entirely fictitious.** `extractSymbols` matched `const|let|var` anywhere, so function
  locals counted as semantic symbols on par with exports, and body elision is exactly what
  removes them. On `src/core/engine/index.ts`, 42 of 63 symbols "lost" — **41 function-local**;
  on `tokenizer.ts`, 9 of 17 — **all 9**. No exported function, type or interface was lost in
  either case, because `selectElisionRegions` retains signatures by construction. Python is the
  control: no locals rule, 0.0% measured symbol loss, unaffected by either half.

  | arm | TS files reducing | TS saved | Python |
  |---|---|---|---|
  | before | 22 | 14.00% | 14.98% |
  | C1b alone | 8 | 2.25% | 14.98% |
  | symbol fix alone | 30 | 25.59% | 14.98% |
  | **both (shipped)** | **29** | **23.38%** | 14.98% |

  The gate is stricter *and* reduction is higher, because it now measures semantic loss instead
  of noise. One file regresses — `src/cli/html-reporter.ts`, whose sole content marker is
  `TD_PRESERVE:` harvested from a **regex literal** in the file implementing that directive's
  highlighting. Left in deliberately: it fails conservatively (byte-identical fallback, no data
  loss) and special-casing it would over-fit the metric to one file.

  Two hazard-pinning tests asserted properties this abolishes and were updated with their
  findings preserved: the 0.60 "ceiling for code" (which was the symptom, not a safety property)
  and C1a's note that the retention gate could never fire for markdown (it now does). See
  DECISIONS §40.

- **The explainability trace now explains — audit M6**: `buildTrace` projected every
  `StageResult` down to `{ stageId, status, durationMs: 0, changed }`, discarding each stage's
  `metrics` and `notes` and hardcoding the duration. `StageTrace` now carries `metrics` and
  `notes` verbatim, and `durationMs` is measured by the engine with `performance.now()` — by
  the engine because a stage that read a clock would stop being a pure function of its input
  (invariant 1), and `performance.now()` because most stages finish inside a millisecond and
  integer resolution would report the same uninformative `0` the constant already did.

  A CLI trace now shows, for example, `regionsHashed: 4`, `bytesSaved: 14509` and
  `irreversibleElisions: 1` with the note explaining that no token hasher was supplied so the
  removed content is retained nowhere — none of which was previously knowable from the trace.

  **`pruning:topology-pruner`'s note was not vague, it was false.** It returned "All items fit
  within token budget; no pruning required." unconditionally whenever `itemsPruned === 0`;
  measured, a 5,405-token file at `maxInputTokens: 10` reported that all items fit. The note now
  distinguishes the three cases and names the mechanism (everything pinned by cache-prefix
  locking → pinned items bypass the knapsack → the budget could not be enforced), and the
  metrics carry `bundleTokens` and `maxTokens` so the claim is checkable. This does not fix H5,
  but it stops the trace concealing it. Guarded by `test/unit/trace-explains.test.ts`, verified
  to fail 4/4 against the unfixed trace. See DECISIONS §39.

- **The Gateway no longer corrupts non-ASCII request bodies — audit C2, L3**:
  `GatewayServer.onRequest` accumulated the body with `body += chunk`, decoding each chunk
  independently, so a multi-byte UTF-8 sequence straddling a chunk boundary became U+FFFD on
  both sides — at the socket, before the pipeline exists, on the bytes forwarded upstream.
  Measured with two-write splits on a continuation byte: `héllo — ünïcode ✓ 日本語 😀` went out
  94 B and forwarded as **98 B** (`h��llo …`); CJK 76 → **82 B**; box-drawing 89 → **95 B**. A
  corrupted body is always *longer*, because U+FFFD re-encodes to three bytes.

  Now collects `Buffer[]`, concatenates on `end`, and decodes once. Bodies that fail a UTF-8
  round trip — which correct concatenation does not fix, since the decode is still lossy — are
  forwarded verbatim rather than optimized or rejected: optimizing would have every stage
  reasoning about content the caller never sent, and rejecting is not a transparent proxy's
  call. `ProxyRequestResult` gains `bodyBytes` for this, preferred over `body` by both the
  upstream `fetch` and `writeProxyResult`.

  This is DECISIONS §35 at a different seam. Phase B applied that reasoning to the adapter that
  reads from disk and not to the one that reads from a socket, where it is worse — the bytes
  reach a provider, not a terminal. MCP was never affected: `setEncoding('utf8')` installs a
  `StringDecoder`, which holds partial sequences across chunks; manual concatenation is exactly
  what bypasses it.

  Also removes the O(n²) body-size check, which re-measured the whole accumulated string on
  every chunk (L3). Guarded by `test/integration/gateway-byte-fidelity.test.ts`, verified to
  fail 4/4 against the unfixed server. See DECISIONS §38.

- **A document whose witnesses were all destroyed is no longer certified — audit C1a**:
  `DriftTracker.findUnwitnessedItems` asked *did evidence exist before?* (it built its probe
  from the **before** item), so an item whose witnesses were entirely destroyed was exempt on
  the grounds that they had once been there. Measured on this repository's own files, on both
  routes: `CODE_OF_CONDUCT.md` **3,542 → 72 bytes** and `SECURITY.md` **1,154 → 72 bytes**, at
  `fallbackUsed: false`, `validation.passed: true`, both gates reporting `pass` — and
  unrecoverable on the CLI, which supplies no `TokenHasher`.

  Neither gate could fire, and the arithmetic is closed-form: prose yields no symbols so
  `R_AST = 1.0` as an empty-set default (a free 0.60), and `filepath:` is derived from
  `item.path` and survives any content transform, so `R_struct = 1/(N+1)` for N headings. Hence
  `S_k = 0.4·N/(N+1)`, which approaches 0.40 from below and never reaches it, against a gate
  firing on `> 0.40`. The two stdin rows landed on **exactly 0.400** and were admitted by the
  strict comparison.

  An item that changed is now refused when it yields no symbols **and** no content-derived
  markers survive in the *after* item. Scoped to symbol-free items, so whole-item elision of
  code still refuses as `SEMANTIC_DRIFT_EXCEEDED` (the accurate reason) rather than being
  relabelled; and strictly additive, so every §33 refusal still refuses.

  Cost, over a frozen 293-file corpus (586 rows, both routes): **4 rows changed, all four this
  defect.** Everything else byte-identical — TypeScript 14.00%, Python 14.98%, uncovered
  buckets 0.00%, all unchanged. Prose goes 0.67% → 0.00%, which was the loss. Guarded by
  `test/unit/drift-unwitnessed-elision.test.ts`, verified to fail against the unfixed tracker.
  See DECISIONS §37.

  **Deferred:** `filepath:` is still counted in `R_struct` (audit C1b). That is why `R_struct`
  is pinned at 1.0 for code, and why a code file can lose 66.7% of its symbols and pass. It
  moves every published figure and wants its own measurement pass.

- **The regression baseline now measures the fixture set the product ships — audit H3**:
  `test/integration/bench.test.ts` Tests 1–5 loaded `loadBenchmarkFixtures('humaneval')`, and
  Test 2 did not use the shipped fixtures at all — it built a private two-fixture set inline
  under an artificial `maxInputTokens: 50` and asserted 40% reduction against that. The suite
  was green while `tokendamper bench` printed **0.0% reduction, 40% fallback**. The two facts
  never met because no test ran the combined set: humaneval is the half that cannot fall back
  (0.00), codexglue sits at **0.80**, and only humaneval was ever loaded.

  All five tests now load the shipped combined set, and `baseline.json` records **measured
  truth** rather than a target: `minTokenReductionRatio` 0.40 → **0.0**, `maxFallbackRate`
  0.0 → **0.40**. The old values are retained in an `aspirational` block so the gap stays
  visible instead of being deleted.

  The new assertions use **equality**, not `>=`. A `>=` check against a measured floor of 0.0
  is vacuously true and can never fail — the same defect one level up. Equality means an
  *improvement* breaks the suite too and has to be recorded deliberately, which is what makes
  it a ratchet. Verified able to fail: mutating the recorded numbers turns 3 of 6 tests red.

  Two things the measurement surfaced that were not previously written down: every non-fallback
  fixture also reduces **exactly 0%**, because `BenchmarkRunner` supplies a `TokenHasher` and
  the engine rehydrates what it elided — so the shipped set produces no reduction by two
  independent mechanisms, not one; and `syntaxPassRate: 1.0` is now asserted *alongside* the
  40% fallback rate, since syntax is evaluated on emitted output and emitted output on fallback
  is the input. Test 3 keeps the historical `aba84df` finding intact, rescoped to humaneval,
  which is the only population it was ever true of.

- **The stale Gateway warning in `README.md` is removed — audit M4a**: it claimed the Gateway
  "bypasses TokenDamper's validation pipeline" and that `fallbackUsed` is "hardcoded `false`".
  Both have been untrue since Phase 1.0b (`proxy.ts` imports and calls `core/engine.optimize`;
  `fallbackUsed` is `result.fallbackUsed`). Replaced with the measured status rather than
  deleted, because removing a false warning while leaving the feature claims uncaveated would
  have made the page less accurate, not more: the notice now records that cross-turn dedup
  saves 0 bytes on ordinary traffic (H1), that `tokendamper exec` returns 401 to its own child
  (C3), and that non-ASCII bodies can be corrupted at the socket (C2). The contradicting note
  under the architecture diagram is corrected the same way.

### Changed
- **License metadata corrected to MPL-2.0 — audit M3**: `package.json` declared `"license":
  "MIT"` while `LICENSE` is a full Mozilla Public License 2.0 and `README.md` stated the project
  is licensed under it. `package.json` is publishable (`"private": false`, `files`,
  `prepublishOnly`) and npm treats its `license` field as authoritative, so scanners read MIT —
  permissive — and receive MPL-2.0 copyleft. `package.json` and `CLAUDE.md` now match `LICENSE`.
  "All rights reserved" is dropped from the README copyright notice, where it sat directly above
  an open-source grant and asserted its opposite. See DECISIONS §36.

- **`contentType: 'code'` no longer selects the TypeScript validator — Phase C**:
  `CONTENT_TYPE_VALIDATORS.code` is now `null`. `code` is a *family* tag set from a file
  extension covering ~19 languages, of which the AST-lite suite implements three; mapping the
  whole family to TypeScript meant every non-TS member was lexed by a scanner written for a
  different grammar. That is not a weaker check, it is a check that **invents** findings —
  measured false `AST_UNTERMINATED_STRING` / `AST_UNBALANCED_BRACKET` verdicts at perl 39/40,
  tcl 30/40, shell 22/40, powershell 7/40 (c and css 0/50, because the C-family scanner happens
  to fit). Shell and PowerShell are in `isCodeExtension` today, so those were live false
  verdicts on the file route: `$'…'` quoting, `'` inside comments, `${…}` expansion and
  `[[ … ]]` tests are ordinary syntax a TS lexer misreads. This is DECISIONS §17's finding —
  a verdict decided by apostrophe parity is not validating anything — reached from the
  extension side instead of the fence side, and removed for the same reason rather than tuned.

  **Nothing that was genuinely covered loses coverage.** TypeScript, JavaScript, Python and
  JSON all reach their validator through the `language` and `path` branches of
  `selectValidator`, which run *first* and are unchanged. What changes is that the remainder
  now report `validated: false` and appear on `trace.astCoverage` — DECISIONS §23's
  distinction, that an unexamined item is not a passing one.

  Two hazard-pinning tests asserted the old mapping deliberately and were updated to pin the
  new one (`test/unit/declared-language.test.ts`, `test/unit/bench/evaluator.test.ts`): the
  trap they record changed shape from *wrong* validation to *absent* validation, so the pins
  were kept and re-aimed rather than deleted. Three stale doc comments were corrected with
  them (`src/core/model/constructors.ts` ×2, `docs/phase-4b-pathless-code-scope.md` §6.3).
- **Fail-open now returns the caller's bytes — Phase B (DECISIONS §35)**: `resolveFallback`
  returns `request.rawInput`, which reads like a byte-identical echo and is not one —
  `rawInput` is a string the CLI decoded with `readFileSync(path, 'utf8')`, and that call turns
  every invalid byte into U+FFFD, which re-encodes to three bytes. Found by the Phase 0 harness:
  of 504 fallback runs, 502 were byte-identical and two were not. `vimspell.sh`, a Latin-1 file
  containing "Fernández-Sanguino_Peña", came back **1,462 → 1,466 bytes with
  `fallbackUsed: true`** — invariant 3 failing silently on the path whose purpose is safety.

  The CLI now reads bytes and decodes second, writing the `Buffer` on fallback. Input that does
  not survive a UTF-8 round-trip forces a fallback via a new
  `EngineOptimizationOptions.inputNotRepresentable`, because every stage and estimator
  downstream reasons about the decoded string — a reduction measured against corrupted input is
  worse than none. The check is a round-trip, not a BOM or charset sniff; valid UTF-8 with
  multi-byte characters is unaffected and pinned by test.

  **The refusal goes through the engine, not the adapter.** The first implementation returned
  early with the right bytes and *no trace at all*, and the harness immediately recorded two
  rows it could not parse — from outside, indistinguishable from a crash.

  Measured: fallback byte-identity **502/504 → 504/504**, 2 corpus rows changed, 0 unparsable
  traces.

- **The multi-item render is latent, and now checked rather than assumed (DECISIONS §35)**: the
  success branch joins item contents with `\n`, which CLAUDE.md described as the live half of
  1b. It has **no live consumer** — CLI, MCP and bench all build single-item bundles through
  `createContextBundle`, and the only multi-item producer (the Gateway) bypasses
  `emittedOutput` per invariant 9. Pinned by `test/unit/fallback-render.test.ts`, which asserts
  the flattening and that the render is not injective (two different bundles produce identical
  output), so making any consumer multi-item changes a test rather than a payload.

- **Markdown needs a marker that is not a `#` line — Phase A part 2 (DECISIONS §34, closes
  §32)**: `looksLikeMarkdown` accepted a single `#` heading, and `#` is the comment leader in
  shell, Perl, Tcl, Ruby, R, YAML and Python — so one `# Copyright …` line made a whole shell
  script a document, its comments were harvested as structural markers, and drift reported
  `structMeasured: true` on content nothing had examined.

  §32 deferred this seam as "requiring more than one `#` line… a classifier change with blast
  radius over every prose item". That is a **count** threshold, and counts point the wrong way —
  `tclConfig.sh` carries 79 markers to `CODE_OF_CONDUCT.md`'s 12. The discriminator that works
  is **shape**: code misclassified as markdown falls from **114 of 264 files to 12**, and **all
  25** real documents are retained. Blast radius over prose: zero files.

  The markdown list regex is repaired in the same change, and that is what makes the first half
  safe: `/(^|\n)(- |\* |\d+\.)\s+\S/` consumed the space after the bullet and then demanded
  another, so `- item` and `* item` never matched. 21 of 25 corpus documents tripped the old
  rule against 25 of 25 repaired — the difference between losing `CODE_OF_CONDUCT.md` and not.

  **Neither half of Phase A closes the defect alone.** The measurement gate left shell over
  stdin untouched at 17.28%, because the fabricated headings *were* the witness it checks;
  seam 2 alone would have moved those files from the forged failure to the honest one. Together:
  every uncovered-language bucket goes to **0.00%**, while **258 of 258** rows in the AST-covered
  buckets and the prose bucket stay **byte-identical**. The combined result was predicted by an
  A/B patch before implementation and matched on all 578 rows.

  `test/unit/markdown-marker-allowlist.test.ts` is no longer a defect pinned by inversion. The
  `it.fails` contract went red with "Expected test to fail" the moment the remedy landed —
  exactly as §32 designed it — and now states the closure positively.

- **The measurement gate is no longer scoped to validator-covered items — Phase A part 1
  (DECISIONS §33)**: an item that changed, was not pruned away, and yields neither symbols nor
  content-derived markers is now refused whatever language it is in. §28 scoped this rule to
  covered items to protect prose; measured over the Phase 0 corpus, the scope protected the
  wrong population. All 25 real markdown files carry content markers and were never in reach
  of the rule, while what the scope excluded was uncovered **code** —
  `Unicode_Collate_Locale_ja.pl` at **57,037 → 19 tokens (100%)** on the *file-argument* route,
  `S_k = 0`, `measured: false`, `fallbackUsed: false`, because nothing covers `.pl`.

  **The Gateway keeps within-payload deduplication.** `resolveRecoverableElisions` substitutes
  original content for `recoverable` elisions before the gate runs, so they are structurally
  invisible to it — measured, within-payload dedup saves 44 of 129 tokens with and without the
  change. This is what separates it from lever 1, which keyed on `astCoverage.checked == 0`, a
  condition every dedup elision meets, and would have made the proxy a pass-through. What the
  Gateway does lose is cross-turn dedup of a **sole copy** — the population
  `docs/phase-1-stabilization-summary.md` §9 already described as sending the model a marker it
  cannot resolve.

  Measured cost: **62 of 578 corpus runs change** (perl 81.91% → 5.61% on both routes, css and
  c over stdin to 0.00%). Every AST-covered bucket, all 25 prose files, shell and tcl are
  **byte-identical**.

- **`DriftReport` carries `measurementGate` and `retentionGate` as separate verdicts
  (DECISIONS §33)**: `S_k` answered two questions with one scalar — *did anything witness this?*
  and *did enough survive?* — and `0.400` is reachable from two opposite configurations
  (`R_AST = 1` empty-set default with `R_struct = 0`, and `R_AST = 1/3` with `R_struct = 1`), so
  `>` versus `>=` arbitrated both together. `validate()` now reads `measurementGate` rather than
  re-deriving the distinction, so `SEMANTIC_DRIFT_UNMEASURABLE` and `SEMANTIC_DRIFT_EXCEEDED`
  are driven by the gate that fired. `calculateDrift`'s `symbolBearingItemIds` option is
  **removed** rather than left inert (§30).

  **This does not close the forged half.** Shell and Tcl are untouched: they classify `markdown`
  on one `#` comment, so their comment leaders are harvested as headings and they report
  `structMeasured: true` — fabricating exactly the evidence this gate checks. That is the
  classifier seam, and it is why Phase A is two changes.

- **Three tests were passing on the empty-set default and are corrected**: `engine.test.ts`'s
  emit-path fixture elided a witness-free `text` item and asserted `fallbackUsed: false`, which
  held only because drift measured nothing; two Gateway tests deduplicated a sole cross-turn
  copy. `declared-language.test.ts` asserted the pathless hole was still open on the undeclared
  route — it is now closed, and the test asserts that instead.

### Added
- **A frozen-corpus measurement harness — Phase 0 (`tools/corpus-harness/`)**: `collect.js`
  freezes a corpus by `sha256` manifest and pins the engine (commit, a hash over all
  `dist/**/*.js`, and a `dirty` flag); `measure.js` re-verifies every hash, spawns the shipped
  CLI on both routes, and dumps per-item traces to JSONL; `seam2.js` scores candidate
  classifier rules against the frozen set. Bucket counts and row counts are **asserted** — the
  4b.3 A/B loop measured 132 of 144 files because a glob covered one directory level, and the
  first run of this harness caught three count mismatches immediately.

  No engine change. Findings in `docs/phase-0-measurement-baseline.md`; 289 files, 578 runs.

- **Seam 2 measured, and DECISIONS §32's deferral reasoning corrected**: §32 deferred the
  `looksLikeMarkdown` seam on the grounds that it "could require more than one `#` line, but
  that is a classifier change with blast radius over every prose item". That is a *count*
  threshold, which `docs/phase-4b-lever-disposition.md` had already shown points the wrong way.
  A **shape** discriminator — require a non-`#` markdown marker, or any two distinct signals —
  takes code misclassified as markdown from **114 of 264 files to 12 (or 7 for the stricter
  variant), retaining all 25 prose files**. Zero prose casualties.

  It is a mitigation, not the fix: it converts §32-shaped items (fabricated markers,
  `measured: true`) into §28-shaped ones (nothing measured, `measured: false`, still reduces).
  Seam 3 stays load-bearing.

- **§32 is not a pathless-route defect — it reaches the file argument**: `.pl` and `.tcl` are
  not in `isCodeExtension`'s 19-entry list, so Perl and Tcl classify `markdown` when passed
  **by name**. Measured worst case: `Unicode_Collate_Locale_ja.pl` at **57,037 → 19 tokens
  (100% deleted)**, file route, `fallbackUsed: false`, `astCoverage.checked: 0`,
  `driftCoverage.measured: false` — two orders of magnitude larger than §32's `tclConfig.sh`.
  Corrections applied to `CLAUDE.md`, `DECISIONS.md` §32 and
  `docs/phase-4b-pathless-code-scope.md` §1, all of which framed the file route as the safe one.

- **The shipped markdown list regex does not match markdown lists**: `RE_LIST` is
  `/(^|\n)(- |\* |\d+\.)\s+\S/` — the alternation consumes the space after `-`, and `\s+` then
  demands another, so `- item` and `* item` do not match while `-  item` and `1. item` do.
  21 of 25 prose files trip the shipped rule against 25 of 25 under the repair. Recorded, **not
  fixed** — it belongs to whoever implements the seam, measured under the harness.

- **The §32 defect is pinned by inversion, not by assertion (DECISIONS §32)**: the
  `KNOWN DEFECT` block in `test/unit/markdown-marker-allowlist.test.ts` asserted the wrong
  behaviour and **passed**, which made the defect the suite's de facto specification — the
  only thing marking it as wrong was a docblock, and a docblock enforces nothing. The suite
  was asserting `structMeasured: true` on a 99%-deleted shell script as correct.

  It now states the **contract** and carries `it.fails`: green while the contract is violated,
  red with `Expect test to fail` the moment any remedy makes it hold. Verified in both
  directions — green today, red under a temporarily simulated remedy, then reverted.

  Three guards keep the inversion from going vacuous, since `it.fails` is satisfied by *any*
  throw: the pipeline result is computed at describe scope so a crash is a collection error
  rather than a swallowed pass; the preconditions live in a separate ordinary passing test
  that goes red if the fixture drifts; and the `it.fails` body holds exactly one assertion.
  The contract is remedy-agnostic and stated over the input rather than over trace fields,
  because `tclConfig.sh` and `CODE_OF_CONDUCT.md` are identical on every field the trace
  carries (`docs/phase-4b-lever-disposition.md` §1).

- **`MARKDOWN_MARKER_TYPES` says what its docblock says — Phase 4b.3 (DECISIONS §32)**: the
  allowlist is now `markdown` alone. It held `text`, `html`, `logs` and `unknown` while its own
  docblock said a new `ContentType` "should default to *not* harvesting these". `text` and
  `unknown` are the two **we could not tell** buckets, and a bucket meaning *we do not know
  what this is* cannot also mean *its `#` lines are headings*.

  **Measured inert, and that is the honest headline.** The four removed members yielded **zero**
  gated markers across five frozen corpora, and 132 files over stdin, 40 over the file route
  and both Gateway turns are byte-identical before and after. Worth having because the trap is
  latent — anything that starts classifying code as `text` gets the fabrication back for free —
  not because it moves a number.

  **It uncovered a larger defect that is deliberately not fixed here.** The fabrication 4b.3
  was scoped to remove is not in those buckets at all: `looksLikeMarkdown` fires on a single
  `#` heading, so every hash-commented shell script is classified `markdown` — 591 fabricated
  headings across 9 frozen scripts, 45 more across the 4 `pip` files 4b.2's probe declines,
  against 0 from the 62 `text`-classified files. Measured end to end on `tclConfig.sh`:

  ```
  1,877 -> 19 tokens (99.0% deleted)   fallbackUsed false   driftScore 0.4
  astCoverage    {checked: 0, unchecked: 1, uncheckedContentTypes: ["markdown"]}
  driftCoverage  {structMeasured: true, measured: true, contentMarkersBefore: 79, …}
  ```

  Deleted whole, nothing validated it, and drift reports `measured: true` on 79 markers that
  are every one of them a comment line. The fabricated markers do not merely inflate a score —
  **they forge the evidence that the score measured anything**, defeating the `DriftCoverage`
  reporting §28 added so this class would be visible. Pinned as a `KNOWN DEFECT`
  characterization test. §32 explains why none of the three available seams belongs to 4b.3,
  and how the finding reframes §28's deferred question: the population is not prose, it is
  everything no validator covers — including real code in every language the AST-lite suite
  does not implement.

- **A Python content probe — Phase 4b.2 (DECISIONS §31)**: pathless content that is
  structurally Python is now classified `code` with `language: 'python'`, without a
  declaration. `classifyContent` wraps a new `classifyContentShape`, which answers with both
  fields; the Gateway builds its items from that shape.

  4b.1 let the caller say what pathless content is, and on the MCP path the caller always
  knows. The **Gateway** is the case that cannot be closed that way — a provider payload has no
  language field anywhere in its schema — which is why §29 declined a Gateway declaration. For
  the traffic the proxy carries, a probe is the only route there is.

  **The probe proposes; the parser confirms.** The structural half is the scope document's
  measured rule (`strong >= 2`, density `>= 0.15`, disqualifiers `< 0.10`, comment lines
  neutral). The half that is not in that document is the answer to its own §6 risk 2: a probe
  may only claim content the validator for that language **already accepts**. A declaration is
  the caller's assertion and failing on it is right; a detection is our guess, and content that
  does not parse means the guess was wrong. So detection can never make an item less valid than
  leaving it alone would — a bad indent level, an unterminated string and a call truncated
  mid-argument are each rejected and land exactly where they landed before.

  | | detected | false positives |
  |---|---|---|
  | 45 `pip` Python (positive) | **39 (86.7%)** | — |
  | 64 repo TypeScript / 25 markdown / YAML / logs | — | **0** |

  Over **stdin with no declaration**, the `pip` corpus goes **0.02% → 12.27%** (1 → 19 files
  reducing, 0/45 → 39/45 items AST-checked) against the file-argument route's 12.34% — **99.4%
  of the achievable yield**. Collateral on the file route: **zero**. TypeScript over stdin is
  **unchanged**, deliberately: §4 measured TS positives at 0.283–1.000 against prose negatives
  reaching 0.333, so no threshold orders them, and no TS probe is proposed now or later.
  `--language` remains the route for it.

  Gateway measured as §6 requires — turn 1, where `session-dedup` cannot elide and any fallback
  would be a false positive by construction: no fallback, output byte-identical. Turn 2
  byte-identical before and after. **Zero new fallbacks on live traffic.** Deterministic 6/6.

  **Still open, and the yield table hides it:** an *undetected* pathless Python file is not just
  unoptimized but unprotected. `pip`'s `status_codes.py` is symbol-free, the probe declines it,
  nothing covers it, §28's refusal cannot fire, and it is elided whole and unwitnessed over
  stdin (44 → 27 tokens) while the file route correctly refuses it.

- **The caller can declare what the content is — Phase 4b.1 (DECISIONS §29)**: new CLI
  `--language` and `--input-name` flags, and new `language` and `path` properties on the MCP
  `optimize_context` tool schema. `item.language` already existed, was already **first** in
  `selectValidator`'s precedence, and was populated by **no adapter at all**.

  Two of the three entry modes are pathless by construction — `optimize -` has no filename
  and an MCP call is a string in a JSON-RPC frame — so classification fell to the content
  probe, which §17 deliberately left unable to detect code. The consequence was not a
  degraded result but no result: no validator covered the item, `selectElisionRegions` found
  no language, whole-item hashing pinned `S_k` at the formula constant `0.60`, and the
  pipeline fell back. **The one route that works is the one a coding assistant does not
  use.**

  Measured over two corpora frozen in a scratch directory (`sha256` manifests; engine A/B'd
  as `dist-before` at `5b19394` vs `dist-after`), tokens counted with real `cl100k_base`, at
  `--target-reduction-ratio 0.3`:

  | corpus | bare stdin | `--language` | file argument |
  |---|---|---|---|
  | 64 repo TypeScript sources | 0.07% (2 files reduce, 57 fallbacks) | **19.27%** (25 files) | 19.27% |
  | 45 `pip` Python sources | 0.02% (1 file) | **12.34%** (19 files) | 12.34% |

  The declared route's output is **byte-identical to the file-argument route on all 109
  files**, and AST coverage goes from 0/109 items checked to 109/109. `--input-name` matches
  byte-for-byte too. Determinism holds across 6 fresh processes on both languages.
  **Collateral: zero** — every undeclared run, file or stdin, is byte-identical before and
  after the change, which is the property the spread-guarded item hash is there to protect.

  Two design points that are load-bearing rather than incidental:
  - **A declaration sets `language` and `contentType` together, never one alone.** Language
    alone leaves the tag at whatever the probe guessed, and `text`/`markdown` are in
    `DriftTracker`'s `MARKDOWN_MARKER_TYPES` — so a declared Python file would still have its
    `#` comments harvested as markdown headings and then "destroyed" by the elision that
    follows. Two comment lines are enough for the probe to call a Python file a markdown
    document. Content type alone fails the other way: `CONTENT_TYPE_VALIDATORS.code` is `null`
    (Phase C, above), so declared Python would be checked by **nothing** and report
    `validated: false`. When this entry was written that mapping was the *TypeScript* validator,
    so the same mistake produced a wrong verdict rather than a missing one — the coupling
    argument this bullet makes is unchanged either way.
  - **An unrecognized language is rejected at the adapters, not dropped in the model.** A
    `--language pyton` that quietly does nothing produces a run that looks declared, validates
    nothing, and reports a clean trace — invariant 10's shape.

  The **benchmark loader** is the third `createOptimizationRequest` call site and was the last
  one guessing with the answer in hand: `BenchmarkFixture.language` is a *required* field that
  `fixtureToOptimizationRequest` dropped. Harmless where a fixture's path agrees with its
  language; for a CodeXGLUE item with **no** path — `codexglue.ts` synthesizes
  `src/item_<id>.txt`, which classifies `text` — it was 4b.1's defect inside the harness that
  publishes this project's numbers (`checked: 0`, fallback, 133 → 133 tokens; declared, 133 →
  59). All ten bundled fixtures are byte-identical before and after.

- **A false declaration fails closed.** Found by the loader change breaking a bench test whose
  fixtures were English prose carrying `language: 'python'` — it had passed only because the
  loader ignored the field. Prose is exempt from §28's refusal *because no validator covers
  it*; declaring a language drags it under one, no symbols are found in English, and drift
  refuses. **The cost of a wrong declaration is the optimization, never the content** — the
  input comes back verbatim. Pinned as a test, since someone will eventually run
  `--language python` over a README. The bench fixtures are now Python, which is what they
  always claimed to be, and still clear their 40% threshold at 58.8% with zero fallbacks.

- **The pathless route inherits §28's protection.** Unplanned, and the strongest single
  result of 4b.1: §28 refuses to certify an unwitnessed elision only for items an AST
  validator covers, and nothing covers a pathless item — so over stdin a symbol-free barrel
  file was **still** being elided whole at `S_k = 0.0000` with no fallback, the exact defect
  `5b19394` is recorded as closing. Declaring the language brings the item under a validator
  and the refusal fires. Six files across the two corpora reduce under bare stdin and fall
  back once declared (`index.ts` 135 → 18 tokens unwitnessed; five other barrels and
  `pip`'s `status_codes.py`); every one is that class, and losing those "savings" is the
  point of them.
- **Sub-item hashing granularity (DECISIONS §20)**: `compression:token-hashing` now elides
  **function bodies** within an item and keeps the declarations around them, falling back to
  whole-item hashing only where no region can be selected (prose, logs, JSON, truncated code).
  New: `core/elision.elideRegions` (chokepoint) and `core/elision/regions.selectElisionRegions`
  (selection + the docstring guard).

  Whole-item hashing could never succeed on a single-item code bundle — it replaces every
  byte, so `R_AST` was a boolean and `S_k` pinned at the formula constant `0.60`, over the
  `0.40` gate every time. For code the gate reduces exactly to **`R_AST ≥ 1/3`**.

  Measured over 52 real source files through the CLI: **22 reduce with no fallback, mean
  52.99%**, byte-identical output across fresh processes (6/6). `codebase.py`:
  16,937 → 11,360 bytes, 5,029 → 3,281 tokens, **34.76%**, no fallback.

  ~~every elision reversible through the existing recovery valve~~ — **withdrawn.** That
  sentence read as a property of the CLI run it was attached to, and it is not one. The
  reversibility measurement injected a `TokenHasher`; the CLI injects none, so the recovery
  valve returns at its first line (`if (!hasher && !ledger) return undefined`) and the
  emitted markers resolve to nothing. Measured on `codebase.py` through the real binary: 19
  placeholders emitted, **0** resolvable. See the `reversible` entry under Fixed.

  Remaining fallbacks are the safety net working, not failures: 17 on constraint-directive
  retention (an imperative comment inside an elided body), 11 on drift over `0.40`, 2 on the
  regex-literal validator defect noted below.

  **The bundled bench corpus stays at 0.00%, deliberately.** Five HumanEval fixtures are
  docstring-only prompts refused by the guard; four CodeXGLUE fixtures are truncated stubs
  with no complete body. It is a completion benchmark, not a compression corpus.

  The **docstring guard** is the Phase 1d precondition: `HumanEval/0` otherwise elides to
  55.66% at `S_k = 0.0000`, AST-valid and reversible, with the function's entire
  specification removed — drift cannot see it, because docstrings carry no symbols and
  `R_struct` is inert for code. The guard defends that case, **not the class**.

### Changed
- **Elision markers say what they replaced (DECISIONS §24)**: `compression:token-hashing`
  emitted `<BLOCK_HASH:` + a 64-character digest + `>`, which on the CLI resolved to nothing
  and therefore told its reader that *something* had been removed and nothing else. Both the
  sub-item and whole-item paths now emit
  `[TokenDamper: <N> <kind> lines elided, <B> bytes, sha256:<12 hex>]` through one shared
  renderer. In place of a function body a reader now gets:

  ```
      def __init__(self, failure_threshold: int = 5, recovery_timeout: float = 30.0):
          [TokenDamper: 5 function-body lines elided, 202 bytes, sha256:4af59ca48228]
  ```

  **It costs nothing in bytes** — `codebase.py` through the real CLI goes 16,937 → **11,328**
  where it went → 11,360 before, because a 12-character digest buys back more than the words
  cost. In tokens the two estimators disagree in *sign* on one real marker
  (`EnhancedHeuristicTokenizer` +1, `ceil(len / 4)` −1); a controlled A/B on a frozen 80-file
  corpus keeps the same 22 files with the same fallback causes and moves the mean over kept
  55.50% → 55.09%. That −0.41pp is the less accurate estimator's opinion (§19).

  `<BLOCK_HASH:…>` is still *read*, so text captured earlier still round-trips. `TokenHasher`
  resolves the truncated digest through a prefix index and refuses an ambiguous prefix rather
  than substituting the wrong content.

  Whole-item elision on prose and logs was proposed for removal as "compute that can only
  produce fallbacks". Measured, it is not: prose alone passes at `S_k = 0.00` saving 78.4%
  and a log tail 97.5%. The 16/16 prose failures in this repository are engineering documents
  dense with imperative directives, which is a property of the corpus. See §24.

### Fixed
- **A flag the command does not read is now an error (DECISIONS §30)**: `parseArguments` ran
  one flag loop for every subcommand and each subcommand's return object picked out the fields
  it cared about, dropping the rest **in silence**. `tokendamper bench --diff --language python`
  and `tokendamper optimize x --report-json r.json` both parsed, discarded and exited 0.

  Worst of the three: `tokendamper mcp --config custom.json` was never parsed at all. The MCP
  branch of `runCli` **reads** `parsed.configPath`, but the parser returned for `mcp` before the
  loop that sets it, so it was permanently `undefined` — and `loadConfig` ignores a config file
  that does not exist rather than failing, so the server started on defaults with no signal in
  the exit code, on stderr, or in the config it reported. `mcp` now takes `--config` and every
  config/budget override, as its own branch always assumed.

  One `SUPPORTED_FLAGS` table keyed by what `runCli` actually consumes. An unsupported flag is
  a parse error naming every offender **and where each one applies**
  (``Unsupported for `tokendamper bench`: --diff (applies to: optimize).``), checked after the
  loop because `--mode bench` can change the command from inside it. `exec` stays outside the
  table — its arguments belong to the child process.

  This generalizes §29, which made the same argument for `--language` and then left the shape
  in place for eight other flags. **Breaking:** invocations relying on a silently ignored flag
  now exit 1.

- **An empty before-set is "nothing to measure", not "perfectly retained" (DECISIONS §28)**:
  `R_AST` and `R_struct` each default to `1.0` when their pre-optimization set is empty, so an
  item the extractors found nothing in scored as perfectly retained. That is invariant 10's
  ninth instance, and it was an approval to delete content outright — `src/index.ts` is
  fourteen `export * from './x';` lines, yields no symbols, and went **420 bytes → a 67-byte
  marker (86.15% of its tokens)** at `S_k = 0.0000`, no fallback, no complaint.

  Drift now refuses to certify an item that **changed**, that an **AST validator covers** (so
  symbols were the expected witness), and that produced **neither symbols nor content-derived
  markers**. New `SEMANTIC_DRIFT_UNMEASURABLE` issue code, distinct from
  `SEMANTIC_DRIFT_EXCEEDED` — one means the metric ran and the answer was too high, the other
  means it never ran on anything, and collapsing them would report a threshold breach for a
  score of 0.00.

  **`filepath:` is excluded from the evidence.** It is derived from `item.path`, not content,
  so no elision can destroy it; counting it would make every pathed item look witnessed. It
  still counts in `R_struct` — that is §18's separate argument and is untouched here.

  The check is **per item**, not per bundle. A bundle holding one richly-symbolled file next
  to a symbol-free barrel measures `astMeasured: true` while the barrel is deleted unwitnessed;
  the transform is per item, so the evidence check has to be too.

  Reported as well as enforced: `DriftCoverage` on `ValidationReport` and on the trace
  (`astMeasured`, `structMeasured`, `measured`, `contentChanged`, `symbolsBefore`,
  `contentMarkersBefore`, `symbolBearingItems`, `unwitnessedItems`), the same shape §23 gave
  syntax. `driftScore: 0` alone cannot distinguish "retained everything" from "found nothing".

  **Measured over 68 frozen repo sources (64 TS + 4 py), engine A/B'd by patching only this
  clause in `dist/`: 5 files change outcome, 0 collateral.** All five are pure barrel files
  (`src/index.ts`, `src/bench/index.ts`, `src/bench/fixtures/index.ts`, `src/config/index.ts`,
  `src/core/ledger/index.ts`), each previously reducing 13.33%–84.05% at `S_k = 0`. The 28
  files reducing under both variants hold an **identical** 48.52% aggregate — the rule costs
  nothing where drift could already measure.

  **Three things it deliberately does not do.**
  - **Prose is untouched.** No validator covers it, so `R_AST = 1.0` there is an inapplicable
    measurement rather than a failed one. Enforcing on it would make every prose bundle
    incompressible and end `cleanup:session-dedup` on the conversational traffic the Gateway
    exists to carry. That gap is real and now *visible* on `DriftCoverage` — closing it is a
    product decision about whether TokenDamper may compress prose at all, not a bug fix.
  - **Pruned-away items are untouched.** Dropping an item is a selection decision the planner
    exists to make under a caller's budget, and `R_AST` already scores it wherever the item
    carried symbols. The symbol-free-file-pruned case stays open as the planner's half.
  - **`R_struct`'s constants are untouched.** §18 stands.

  Turn-1 Gateway measured as required (`docs/phase-1-stabilization-summary.md` §8 method):
  `fallbackUsed: false`, no false positives; turn 2 falls back identically with the rule on
  and off, so the existing cross-turn behaviour is unchanged. Output byte-identical across
  6/6 fresh processes; fail-open holds — a refusal still returns the caller's input.
- **The benchmark harness measured a route nobody uses (4b.0)**: `run_benchmark.py` piped its
  fixtures to `tokendamper optimize -`. With no path the engine resolves no language, selects
  no elision regions, falls to whole-item hashing, and `S_k` pins at the formula constant
  `0.60` — so it fell back on **all four** fixtures and reported 0%. It now passes a **file
  argument**, the route a developer actually uses.

  Harness only; no engine code changed. Engine frozen at `95056df` across both runs (all 64
  `dist/**/*.js` hashes identical), fixtures frozen by `sha256` manifest.

  | fixture | before (stdin) | after (path) |
  |---|---|---|
  | `codebase.py` | 0.00%, fallback `S_k 0.60` | **27.61%**, no fallback |
  | `sample_logs.txt` | 0.00%, fallback (constraint directive) | 0.00%, unchanged |
  | `tool_output.json` | 0.00%, fallback `S_k 0.60` | 0.00%, unchanged |
  | `session.json` | −1.39%, fallback `S_k 0.60` | −1.39%, unchanged |

  **One fixture of four moves**, and that is the honest headline — this corpus is one Python
  file, one log and two JSON payloads, and only the Python file is reachable by the path route.
  Output byte-identical across 6/6 fresh processes.

  Percentages are `cl100k_base` via the harness's own `tiktoken`. The engine's trace calls the
  same `codebase.py` output **34.18%**; that is `EnhancedHeuristicTokenizer` self-reporting at
  its documented 24% mean absolute error. **Publish the `cl100k` figure.**

  Two things this does **not** fix. The −1.39% on `session.json` is the harness's *other*
  defect — `orig_tokens` comes from `count_tokens(json.dumps(messages))`, which discards the
  file's pretty-printing while the engine is handed and echoes the raw file. Separate concern.
  And the pathless route remains broken **in the engine** for stdin, MCP and Gateway callers;
  4b.0 stops the harness from misreporting it, and closes nothing else
  (`docs/phase-4b-pathless-code-scope.md`).

  Corrected as a consequence: Issue 3 is **closed for `codebase.py`** in
  `tokendamper-headroom-known-issues.md` — the drift abort there was the harness, and the
  question of whether it was "correct conservative behavior" was moot because the engine had
  never looked at the file. Issue 3 stays open for the two JSON payloads.
- **`looksLikeYaml` asks whether the input is predominantly YAML (DECISIONS §27)**: the probe
  was `/^(---\s*$)?([\w.-]+:\s+.+)$/m`, whose optional leading group cannot span a line, so it
  actually tested "some line looks like `word: text`". Measured **pathless** — the Gateway and
  MCP shape — it claimed `yaml` for **12 of this repository's 22 markdown documents**, on
  lines like `Responsibilities:` and `Note: the AST validators run in CLI mode`.

  §22 judged that harmless because `yaml` selects no validator. It was not:
  `DriftTracker.extractMarkers` gates markdown structural markers on an allowlist that
  excludes `yaml`, so the same pathless prose item yields **0 markers as `yaml` and 19 as
  `markdown`**. The mistag silently zeroed `R_struct`'s input on the one content type where it
  does real work.

  Now a per-line predicate with a majority requirement, like `looksLikeLogs`. Lines that are
  legal YAML *and* ordinary markdown (`#`, bare `- `) count on neither side, and block-scalar
  bodies are skipped. Measured, the populations do not overlap: real YAML samples score
  **1.000**, the highest-scoring prose document **0.455**; the threshold is 0.75. Pathless
  prose: 12 `yaml` → **0**. No change on the CLI code corpus — a file argument carries a path,
  and the extension already outranked the probe.
- **`TypeScriptValidator` reads regex literals (DECISIONS §26)**: it had no regex mode, so it
  counted the brackets and quotes inside one. `const re = /([^)]+/;` was reported
  `AST_UNBALANCED_BRACKET`, and **7 of this repository's own 64 TypeScript sources were
  rejected by their own project's validator** — three of them the classifier's regexes from
  §22. A `/` now opens a literal where a value may begin (the punctuation set
  `scanBraceSpans` already uses, plus reserved words that cannot end an expression), and an
  unterminated literal is dropped at the newline rather than run to EOF.

  Now 0 of 64 `src/` and 0 of 46 `test/` sources are rejected, pinned by a corpus test.
  End-to-end on a frozen 68-file corpus with the input held constant: fallbacks **37 → 36**,
  files reducing **29 → 30**, total emitted tokens **102,800 → 100,715**;
  `src/core/elision/regions.ts` reduces 52.56% where it used to fall back on a syntax error it
  did not have. `elideRegions`'s relative post-condition is unchanged — its other reason
  (truncated completion prompts, invalid on input) still holds.
- **`compression:token-hashing` no longer fabricates the store that makes it "reversible" (DECISIONS §25)**:
  line 23 was `options?.tokenHasher ?? new TokenHasher()`. That default registered every
  elided block into a store that was garbage-collected when the stage returned, so on the
  CLI — which supplies no hasher — the emitted `<BLOCK_HASH:…>` markers referred to content
  held by nothing. Measured on `codebase.py` through the real binary: 19 placeholders, **0**
  resolvable by any store in the process or out of it. The engine's own
  `detectCorruptedPlaceholders` reported clean, because it reads
  `if (hash && hasher && !hasher.hasHash(hash))` and there is no hasher.

  The hasher is now used only if the caller supplies one. Reversibility is recorded on the
  item (`metadata.reversible`) and in the stage metrics (`irreversibleElisions`), and stated
  in the stage notes. Emitted bytes are unchanged and do not depend on whether a hasher was
  passed. Reversibility on the CLI is not unimplemented but unachievable — a one-shot pipe
  has nowhere for a store to live — so the marker itself has to carry the information.

- **An unvalidated item no longer reads as a passing item (DECISIONS §23)**: `valid: true`
  meant both "a validator examined this and found no syntax errors" and "no validator covers
  this content type, so nothing was examined". `AstValidatorResult.validated` now separates
  them, `BundleAstValidationResult.unvalidatedItemIds` lists the uncovered items, and
  `ValidationReport`/`OptimizationTrace` carry `astCoverage` — which is what makes this
  visible on the CLI, whose only validation output is the stderr trace.

  **This partially reopens Phase 1a.** Replacing the Gateway's hardcoded `contentType: 'text'`
  with `classifyContent` (`ac16cec`) closed the JSON half of "no validator runs at all on
  Gateway items" and is recorded as closing the whole thing. It did not: `classifyContent`
  answered `html` for TypeScript, `selectValidator` has no `html` branch, and a pathless item
  carrying a file with an unterminated string literal returned `valid: true, issues: 0`.
  `selectValidator`'s content-type dispatch is now a total `Record<ContentType, …>`, so a tag
  dispatch has never heard of is a compile error. Pathless code stays unchecked by design
  (§17) — it is now reported as unchecked. `passed` is scoped to `severity: 'error'` so a
  coverage report cannot force a fallback.

- **Content classification no longer answers `html` for TypeScript (DECISIONS §22)**:
  `classifyContent` ran its content probes *before* its extension checks, and two of those
  probes were wrong. Measured on this repository: **46 of 57 TypeScript sources classified as
  `html`**, every markdown document as `html` or `yaml`, and a 75-line file of pure log
  output as `text`.

  Three causes: `looksLikeHtml`'s `/<\/?[a-z][\s\S]*>/i` matched from the first `<letter` to
  the **last** `>` in the input, so any generic parameter sufficed; `isCodeExtension` was
  consulted fifth, after four probes that could pre-empt it; and `looksLikeLogs` missed
  ISO-8601 both ways — it required the level before the date, and `\b\d{2}:\d{2}:\d{2}\b`
  cannot match `T19:00:01` because `T` and `1` are both word characters.

  Now: every recognized extension resolves first; `looksLikeHtml` requires a matched
  open/close tag pair; `looksLikeLogs` requires a majority of lines to carry a clock time
  plus either a severity token or a leading timestamp. Regression fixtures are the
  repository's own files (`test/unit/content-classification.test.ts`).

- **Latency budget no longer decides a syntax verdict (DECISIONS §21)**: `validateItemAst`
  returned `valid: false` with `AST_SLA_EXCEEDED` when validation exceeded 5ms. Identical
  bytes therefore produced different verdicts depending on machine load — measured on a 16 KB
  Python file across six fresh processes: `valid(4.06ms) INVALID(5.28ms) INVALID(6.86ms)
  INVALID(8.04ms) INVALID(14.70ms) INVALID(17.58ms)`. It also fell the engine back on large
  valid files, reporting a syntax error that did not exist. The breach is now reported on
  `AstValidatorResult.slaExceeded` and does not touch `valid` or `issues`.

- **One Token Estimator (DECISIONS §19)**: every reduction figure the CLI, MCP and bench
  paths report was computed across a seam between two independent token estimators —
  `EnhancedHeuristicTokenizer` on a bundle's input side, inline `Math.ceil(len / 4)` on
  every output side. The heuristic runs 11–22% above `len / 4` on this corpus, so
  **byte-identical output registered as an 11–22% saving**. All measurement now routes
  through `estimateTokens` / `estimateBundleTokens` in `src/core/hashing/tokenizer.ts`;
  `countTokens` is called from exactly one place.

  Eleven sites changed: `core/model/constructors.ts` (×2 bundle constructors),
  `core/trace/index.ts`, `core/engine/index.ts` (`attemptAutomatedRehydration`),
  `core/planner/cache-aware.ts`, `gateway/proxy.ts` (×2), and the four stages that build a
  bundle. `session-dedup` and `delta-compression` also reported `tokenEstimateSaved` as
  `ceil(bytesSaved / 4)` — a third unit — now derived from the two bundle estimates.

  **The bundled bench corpus reduces by 0.00%, not 7.82%.** All ten fixtures emit
  byte-identical output; the 7.82% was the estimator gap. Measured before → after, at
  `targetReductionRatio: 0.30`:

  | Fixture | In bytes | Out bytes | Identical | Reported before | Reported after |
  |---|---|---|---|---|---|
  | `HumanEval/0` | 348 | 348 | yes | 17.92% | **0.00%** |
  | `HumanEval/1` | 504 | 504 | yes | 13.70% | **0.00%** |
  | `HumanEval/2` | 328 | 328 | yes | 9.89% | **0.00%** |
  | `HumanEval/3` | 446 | 446 | yes | 11.11% | **0.00%** |
  | `HumanEval/4` | 386 | 386 | yes | 11.01% | **0.00%** |
  | `CodeXGLUE/py/101` | 192 | 192 | yes | 0.00% | **0.00%** |
  | `CodeXGLUE/py/102` | 164 | 164 | yes | 14.58% | **0.00%** |
  | `CodeXGLUE/ts/201` | 130 | 130 | yes | 0.00% | **0.00%** |
  | `CodeXGLUE/ts/202` | 49 | 49 | yes | 0.00% | **0.00%** |
  | `CodeXGLUE/js/301` | 112 | 112 | yes | 0.00% | **0.00%** |

  `avgReduction` 7.8210% → **0.0000%**. `fallbackRate` (0.40) and `totalValidationIssues`
  (4) are unchanged — neither was computed across the seam. The four rows already reading
  0.00% are the fallbacks, where the *bench* ratio compared two tokenizer-derived numbers;
  their `trace.tokenAfter` was still inflated, so MCP reported a saving on them too
  (`CodeXGLUE/py/101`: 53 → 48, a phantom 9.4% on a pure fallback). That is now 53 → 53.

  **Gateway results in this repo are unaffected and should not be re-corrected.** The
  figures recorded in `docs/phase-1-stabilization-summary.md` §9 and `NOTES-FOR-DOCS.md`
  (66%, 98.59%, 0%) were derived from HTTP body byte lengths, not from these counters. The
  Gateway's internal `rawTokens`/`optimizedTokens` do change unit — measured 8,470 → 10,059
  on a 36 KB payload — but its `dedupRatio` moves only 49.79% → 49.82%, because both of its
  sides already used the same estimator.

- **Regression guard**: `test/unit/token-estimator-unity.test.ts` pins byte-identical
  input and output to exactly 0% reduction on the engine path, on the fallback path, and
  for every stage in the catalog. Verified to fail against the pre-fix source (`expected 87
  to be 106` on `HumanEval/0`), not merely to pass against the fixed one.

### Changed
- **Bench Evaluator Classifies Instead of Hardcoding (Issue 2, follow-up)**:
  `src/bench/evaluator.ts` hardcoded `contentType: 'code'` on the two items it builds for
  AST quality checks. Both now call `classifyContent`, completing the removal of hardcoded
  content-type literals begun in the Gateway relabel.

  **This moves no benchmark number.** `selectValidator` dispatches
  `language` → `path` → `contentType`, and `BenchmarkFixture.language` is a required field
  always set to `python`, `typescript` or `javascript` — all matched by the first arm — so
  `contentType` is never consulted for these items. Measured across all ten bundled
  fixtures at `targetReductionRatio: 0.30`, before and after are byte-identical:

  | Fixture | Lang | In | Out | Reduction | Fallback | rawSyntaxValid | optSyntaxValid | Symbol | Similarity | Passed |
  |---|---|---|---|---|---|---|---|---|---|---|
  | `HumanEval/0` | python | 106 | 106 | 0.00% | yes | true | true | 1.0000 | 1.0000 | true |
  | `HumanEval/1` | python | 146 | 146 | 0.00% | yes | true | true | 1.0000 | 1.0000 | true |
  | `HumanEval/2` | python | 91 | 91 | 0.00% | yes | true | true | 1.0000 | 1.0000 | true |
  | `HumanEval/3` | python | 126 | 126 | 0.00% | yes | true | true | 1.0000 | 1.0000 | true |
  | `HumanEval/4` | python | 109 | 109 | 0.00% | yes | true | true | 1.0000 | 1.0000 | true |
  | `CodeXGLUE/py/101` | python | 53 | 53 | 0.00% | yes | true | true | 1.0000 | 1.0000 | true |
  | `CodeXGLUE/py/102` | python | 48 | 48 | 0.00% | yes | true | true | 1.0000 | 1.0000 | true |
  | `CodeXGLUE/ts/201` | typescript | 35 | 35 | 0.00% | yes | true | true | 1.0000 | 1.0000 | true |
  | `CodeXGLUE/ts/202` | typescript | 14 | 14 | 0.00% | yes | true | true | 1.0000 | 1.0000 | true |
  | `CodeXGLUE/js/301` | javascript | 33 | 33 | 0.00% | yes | true | true | 1.0000 | 1.0000 | true |

  Aggregates, also identical: `fallbackRate = 1`, `avgReduction = 0.0000%`,
  `syntaxPassRate = 1`, `passAt1Rate = 1`, `totalValidationIssues = 11`, and
  `evaluateDataset` → `rawPassRate = 1`, `optimizedPassRate = 1`, `passRateDelta = 0`,
  `avgKeySymbolPreservation = 1.000000`, `avgTokenSimilarity = 1.000000`.

  The 100% fallback rate is pre-existing and unrelated: nine fixtures exceed the drift
  threshold (`0.60 > 0.40`) and `CodeXGLUE/ts/202` fails AST validation with an unclosed
  bracket. Reduction figures come from the optimization pipeline via
  `fixtureToOptimizationRequest`, which already classified correctly through
  `createContextBundle` — the evaluator only computes post-hoc quality metrics and cannot
  affect them.

  **C1 interaction, checked explicitly:** all ten fixtures carry a `.py`/`.ts`/`.js` path,
  so extension-only code detection (`642abcb`) still classifies every one as `code`. The
  computed tag differs from the old literal on exactly one constructible input — a CodeXGLUE
  item with no `path`, which the loader synthesizes as `src/item_<id>.txt` and which
  classifies `text`. That is not a C1 regression: pre-C1 the only content signal for `code`
  was a fence, and plain source has none.

  **Not fixed, and verified rather than assumed:** with `language` absent, both the old
  literal and the computed tag yield `code` for a `.py` path, and `contentType: 'code'`
  selects the **TypeScript** validator — so a Python fixture would be parsed as TypeScript
  either way. `language` being required is the only thing preventing it, and these items
  pass the path as `origin` rather than `path`, leaving the extension arm unreachable.

### Fixed
- **Gateway Hardcoded `contentType: 'text'` (Issue 2, Commit C)**: `src/gateway/proxy.ts`
  built its context items by hand and hardcoded the content-type tag instead of calling
  `classifyContent`, the classifier every other construction site reaches through
  `createContextBundle`. That literal silently disarmed both safety nets on exactly the
  traffic a Gateway carries: `selectValidator` dispatches on `language` → `path` →
  `contentType`, and Gateway items have neither of the first two, so a `text` tag meant no
  AST validator ran at all; `DriftTracker.extractSymbols` harvests `jsonkey:` symbols only
  when `contentType === 'json'`, so a JSON payload tagged `text` yielded zero symbols and
  drift was vacuously `0.00`. Both checks reported passes they had never performed. Message
  content is now classified, and `statistics.contentTypeCounts` is derived from the items
  rather than asserted as all-`text`.

  Measured consequence, as predicted in `docs/phase-1-stabilization-summary.md` §9:
  cross-turn deduplication of a **sole copy** of `tool_output.json` moves from
  `13,785 / 13,982 = 98.59%` saved with no fallback to **0.00% and a fallback**. That is the
  drift gate working for the first time on JSON, not a regression — the prior figure
  depended on sending the model a marker it had no way to resolve. Within-payload
  duplication, where a referent survives in the same request, still deduplicates at
  **~66%** with no fallback.
- **Fenced Blocks Classified As Code**: `classifyContent` treated a triple-backtick fence as
  evidence of `code`, and `selectValidator` maps `code` to the **TypeScript** validator — so
  an ordinary message quoting a snippet was parsed as TypeScript, prose and all. Whether it
  passed was decided by apostrophe parity in the surrounding text: `Here's ... it's ...
  that's` leaves a quote open and the message is rejected with `AST_UNTERMINATED_STRING`,
  while the same message with one fewer contraction passes. Code is now detected by file
  extension only, and a fence counts toward `markdown`. Real code detection is unaffected —
  every path carrying source files supplies an extension. See `DECISIONS.md` §17.
- **Gateway Ran Without Any Safety Net (Phase 1.0b)**: `src/gateway/proxy.ts` called
  `runSessionDedupStage()` directly, so the proxy path executed no validators, no
  `DriftTracker`/`ConfidenceLedger`/`DebtTracker`, and no fallback resolver — invariants 3
  (fail-open fallback) and 5 (drift threshold) simply did not exist for live provider
  traffic. The proxy now routes through `core/engine.optimize()` and records a genuinely
  computed `fallbackUsed`. A rejected transform returns the caller's original payload
  byte-for-byte.
- **Planner Budget Trigger**: `isKnapsackMode` now also triggers on
  `budget.targetReductionRatio`, not just `maxInputTokens` — previously a budget supplying
  only `--target-reduction-ratio` silently resolved to `pass_through` mode with zero stages
  executed.
- **ESLint CI Failures**: Resolved lint issues breaking CI (`src/config/load.ts`,
  `src/core/hashing/tokenizer.ts`, related tests).
- **Design Gaps — Git Caching, Tokenizer, Versioning, Config Schema**: Follow-up fixes
  across `src/config/load.ts`, `src/config/schema.ts`, `src/core/hashing/tokenizer.ts`,
  `src/core/topology/git-inspector.ts`, and adapter entry points.

### Added
- **`session_dedup` Planner Mode**: New `OptimizationMode` planning exactly
  `['cleanup:session-dedup']`. Selected via `config.planner.defaultMode` (previously dead
  config) and takes precedence over budget-derived knapsack mode. The Gateway pins it so
  `compression:token-hashing` — which corrupts JSON-shaped message content (Issue 2) —
  cannot reach live provider payloads.

### Changed
- **Drift Exempts Recoverable Elisions**: `cleanup:session-dedup` now tags its elisions
  `recoverable: true`, and `DriftTracker` substitutes the pre-optimization content for
  those items before scoring. A dedup marker is a reference to text still held in the
  session store, not semantic loss; scoring it as drift made `S_k` fire hardest exactly
  when deduplication worked best (measured 0.60 for a code payload that now scores 0.00).
  Lossy elisions (`token-hashing`, `delta-compression`) set no such flag and are still
  scored in full.
- **Documentation**: Updated `ARCHITECTURE.md`, `DECISIONS.md`, and `ROADMAP.md` for v2.0
  planning.

## [v1.1.0] - 2026-07-29

### Added
- **Config Schema Versioning**: Added `configSchemaVersion: "1.1"` support with automatic legacy migration.
- **Git Workspace Caching**: Added in-memory TTL caching for `git status` commands, greatly speeding up Git inspections during proxy sessions.
- **Heuristic Tokenizer**: Replaced the naive character count estimator with an optimized, zero-dependency `EnhancedHeuristicTokenizer`.

### Performance
- **Tokenizer Speedup**: Optimized the heuristic tokenizer using `charCodeAt` to achieve a 3.5x performance boost.

## [v1.0.3] - 2026-07-27

### Fixed
- **CLI Executable Resolution**: Fixed "command not found" error following global installation (`npm install -g tokendamper`) by updating `"bin"` configuration in `package.json` to explicitly map `"./dist/src/cli/main.js"`.
- **Shebang & Environment Integrity**: Validated CLI entrypoint shebang (`#!/usr/bin/env node`) to ensure seamless execution on Windows, macOS, and Linux.

### Changed
- **Version Alignment**: Synced package version, `CLI_ADAPTER_VERSION`, and MCP `SERVER_VERSION` to `1.0.3`.

## [v1.0.2] - 2026-07-27

### Fixed
- **Engine Fallback Data Integrity**: Fixed a critical bug where the engine returned the corrupted intermediate bundle in `finalBundle` instead of the original request bundle when fallback was triggered. Consumers inspecting `result.finalBundle` after a fallback now correctly receive the original unmodified bundle.
- **Topology Scoring Performance**: Replaced per-item multi-source BFS (O(N × V²)) with a single batch `computeAllDistances()` call using an O(1) head-index dequeue, reducing topology scoring to O(V + E + N). Eliminates event loop freezes on repositories with 500+ files.
- **hashContent Crash on Undefined**: Guarded `stableSerialize()` against `undefined` return from `JSON.stringify()` (triggered by `undefined`, `Symbol`, or `Function` inputs) which previously crashed `createHash().update()` with a fatal `TypeError`.
- **Benchmark Runner Flaky Test**: Increased timeout for the `should execute offline deterministic benchmark sweeps` test from 5s to 15s to prevent false failures on slower CI runners.

### Changed
- **Version Alignment**: Synced `CLI_ADAPTER_VERSION` and MCP `SERVER_VERSION` from `0.1.0` to `1.0.2` to match the published package version. All traces, MCP `initialize` responses, and diagnostic outputs now report the correct version.

## [v1.0.0] - 2026-07-27

### Added
- **MCP Adapter**: Implemented a Model Context Protocol (MCP) stdio JSON-RPC 2.0 server for Claude Desktop and Cursor integration.
- **Gateway HTTP Proxy**: Built a local proxy server to transparently intercept and optimize Anthropic/OpenAI API requests from CLI tools (`tokendamper exec`).
- **0/1 Knapsack Planner**: Introduced an optimal value-density knapsack solver for packing context nodes under strict token constraints.
- **Reversible Token Hashing**: Added `TokenHasher` for eliding repetitive context with `<BLOCK_HASH:sha256>` placeholders.
- **Delta Compression**: Implemented line-based Myers diff algorithm to transmit only changed lines across conversation turns.
- **Visual Diff Reporters**: Added visual terminal ANSI diff (`--diff`) and beautiful HTML report exporter (`--diff-html <path>`).
- **Explainability Ledgers**: Introduced Optimization Debt ($D_k$) & Semantic Drift ($S_k$) tracking to enforce long-term session safety limits.

### Changed
- **Engine Emission Contract**: The core linear engine now fully emits optimized bundle text back to callers when validation successfully passes, seamlessly integrating with execution workflows.

### Security
- **Gateway Token Auth**: Implemented `x-tokendamper-token` authentication to secure the local Gateway proxy.
- **Payload Size Limits**: Enforced strict 10MB input limits on MCP stdio and Gateway streams.
- **Upstream Abort Timeouts**: Configured request timeouts to protect against upstream LLM hangs.
- **Bounded LRU Session Stores**: Capped active `GatewaySessionStore` metrics and MCP `traceStore` entries with eviction strategies to guarantee stable memory footprints over unbounded sessions.

## [v0.1.0] - 2026-07-24

### Added
- Initial repository governance documents
- Frozen architecture and implementation contract documentation
- Core data model and immutable schema definitions

### Changed
- N/A

### Deprecated
- N/A

### Removed
- N/A

### Fixed
- N/A

### Security
- N/A
