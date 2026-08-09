# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

Commits on `main` beyond the `v1.1.0` tag (`807f6f0`). Not yet tagged or released; run
`git log v1.1.0..HEAD` to confirm current scope before relying on this list.

### Fixed
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
