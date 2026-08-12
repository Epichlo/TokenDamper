# Audit remediation — status and next steps

Working state for the `max_audit.md` remediation. **Read this before picking up audit work**;
it records what is done, what is measured, and what the next batch actually requires.

Last updated 2026-08-12, after **v1.4.0** — §50 (sub-region elision; the target adheres), on top
of v1.3.0’s §48 and §49. Suite: **628 passing**, typecheck and lint clean. `npm run format` no
longer exists; `lint` is the enforced style gate.

---

## 1. Where things stand

| Wave | Items | Status |
|---|---|---|
| **0** | H3, M3, M4a | ✅ merged |
| **1** | C1a, C1b, C2, M6 | ✅ merged |
| **2** | M5a, M5b, H4, M8, M9, M10 + M5 minor | ✅ **done — DECISIONS §44** |
| **3** | C3/H1 ✅, H6 ✅, H5 ✅, C4 ✅ | ✅ **done — C4 in DECISIONS §45** |
| Decisions | H2, M1, M11 | ✅ **decided and done — DECISIONS §46** |
| **Unscheduled** | **M7** | ⬜ **open — never entered a wave. See §6.** |

**Phase 1c is closed** (DECISIONS §47), which was the binding constraint on multi-file value,
and §48 closed H4's deferred half. §5 records what is left on the architectural axis.

**This document claimed "every audit item is now closed" and that was wrong: M7 was never
scheduled.** It appears in no wave table above, and the last document to mention it is
`DECISIONS` §41 — "M7 … remains open", written before Wave 2. Re-verified against source
2026-08-12: still open, in full. §6 records it. The failure mode is worth naming, because it is
this project's own §4 rule turned on its documentation: **an item that is in no table reads as
done, exactly like a check that never ran reads as a pass.**

The three decisions were taken as: **H2 — report why** (keep accepting every language, but say
when elision cannot reduce it, rather than narrowing the accepted set); **M1 — correct the
docs** (say "bracket/quote integrity", do not wire the compiler API); **M11 — retire the
narratives and the root planning artifacts**. Each is argued in §46.

### Corresponding DECISIONS entries

§36 license · §37 C1a · §38 C2 · §39 M6 · §40 C1b · §41 C3/H1 · §42 H6 · §43 H5 · §44 Wave 2 ·
§45 C4 · §46 H2/M1/M11 · §47 Phase 1c

---

## 2. Measured baseline

Recorded **2026-08-12** after §50, over a corpus frozen at `23c6368` (clean tree),
via `tools/corpus-harness`, **288 files / 576 rows**, both routes, target ratio 0.3.
**These are the numbers to compare against; do not re-derive them from memory.**

| bucket | route | n | reduced | fallback | saved |
|---|---|---|---|---|---|
| python | file | 45 | 31 | 13 | **17.95%** |
| python | stdin | 45 | 29 | 12 | **17.54%** |
| typescript | file | 62 | 39 | 16 | **18.52%** |
| typescript | stdin | 62 | 0 | 0 | 0.00% |
| prose | file/stdin | 18 | 0 | 6 | 0.00% |
| shell, perl, tcl, c, rust, css | both | — | 0 | — | 0.00% |

**§50 moved these again, and the per-row A/B is what says nothing regressed:** against the same
frozen corpus the TypeScript file bucket went 35 reduced / 20 fallbacks to **39 / 16**, rows above
50% achieved went **34 → 18**, and **no** row gained a fallback or stopped reducing. The aggregate
saved% is not the measure — 522 of 576 rows are byte-identical.

**The aggregates also fell against the Wave 2 table and nothing regressed there either.** That table read python
file **23.14%** and typescript file **23.26%**; §48 made `--target-reduction-ratio` bind, so runs
that used to overshoot to 44–69% now stop near the requested 30%. In the same measurement
**fallbacks fell** (python file 14 → 13, stdin 13 → 12) and **reduced counts rose** (python file
30 → 31, typescript file 33 → 35), because less aggressive elision survives validation more
often. Compare per-file adherence, not the mean — DECISIONS §48.

**Two denominators also moved, so the two tables are not the same measurement anyway.**
TypeScript went 60 → 62 files (`src/core/budget/index.ts` from §48, and
`src/core/validation/language-support.ts` from H2) and prose went 29 → 18, because M11 retired
twelve narrative documents. 297 files / 594 rows became 288 / 576.

**No number here is comparable across waves, and the TypeScript row is the standing example.** It
read 23.26% over 60 files where the `dd540fe` table read 25.35% over 59, and 29.55% in
`DECISIONS` §43 over fewer still — same engine every time; the corpus grew. It now reads 17.57%
over 62 for a different reason again. **Only a per-row A/B over one frozen corpus means
anything**, which is what the harness is for.

Wave 2 is the case where this was actually pinned down rather than assumed. A per-row A/B —
both engines against the **same frozen corpus**, varying only `dist/` — found **594 of 594 rows
identical** across `outputSha`, `byteIdentical`, `tokenBefore`, `tokenAfter`, `reduction`,
`fallbackUsed`, `driftScore`, `debtScore`, `planMode`, `stageCount`, `contentType`,
`astChecked`, `astUnchecked`, `driftMeasured` and `unwitnessedItems`. `reduced` stayed at 33;
the added file (`src/bench/fixtures/bundled-path.ts`, from M10) falls back and contributes zero,
which is the whole of the 2.09pp move.

**Do the per-row comparison, not the aggregate one.** Two cautions from doing it:

- Build the comparison engine with an `src`-only tsconfig. A plain `npm run build` typechecks
  `test/` too, so with the new tests present it fails, emits nothing, and leaves the *previous*
  `dist/` in place — the measurement then silently compares an engine against itself. It
  reported a perfect match, which is exactly what a real match looks like.
- **The corpus is `src/`, so a change to `src/` changes the corpus.** Phase 1c measured the
  TypeScript bucket at 19.76% against a previous 23.03% and it looked like a regression. The
  *pre-change* engine reads 19.76% on the same frozen corpus too. Comparing two runs over two
  corpora is not a comparison, however carefully each was made.
- Key the rows on `corpusPath`, and assert the row count. Keying on a field the harness does not
  emit collapses all 594 rows onto one undefined key and reports `compared 2 rows, differing: 0`.

### Re-measuring

```bash
node tools/corpus-harness/collect.js <scratch-dir>          # freeze + hash + pin engine
node tools/corpus-harness/measure.js <scratch-dir> --variant <label>
```

Two rules that have both been broken before: **freeze the corpus first** (never point the CLI at
the live repo), and for an A/B, **compare over the rows that reduce under every arm** — a variant
that converts fallbacks into reductions changes the denominator and can make a strictly worse
rule look better on the mean.

---

## 3. Wave 2 — done

All six items plus the M5 minor list, 2026-08-10. Full reasoning in **DECISIONS §44**; this is
the index and the residue.

| item | what it was | where it landed |
|---|---|---|
| **M5a** | `optimize_context` had no budget parameter → guaranteed 0% no-op | `adapters/mcp/tools.ts` |
| **M5b** | `rehydrate_context` matched a marker the product never emits | `core/elision/marker.ts`, `stages/cleanup/session-dedup.ts`, `adapters/mcp/tools.ts` |
| **H4** | three knobs parsed, validated, read by nothing | `cli/main.ts`, `config/load.ts`, `adapters/mcp/tools.ts`, `core/model/types.ts` |
| **M8** | `TOKENDAMPER_MOCK_UPSTREAM` / `NODE_ENV=test` in the request path | `gateway/{proxy,server,exec,types}.ts` |
| **M9** | request headers returned as response headers | `gateway/proxy.ts` |
| **M10** | `bench` threw for every installed user | `bench/fixtures/*`, `cli/main.ts`, `package.json` |
| **M5 minor** | shared `traceStore`; reads that create sessions; no version negotiation | `adapters/mcp/{index,tools}.ts`, `gateway/session-store.ts` |

Tests added: `test/unit/mcp-budget.test.ts`, `test/unit/mcp-session-rehydration.test.ts`,
`test/unit/gateway-response-headers.test.ts`,
`test/unit/bench/bundled-fixture-resolution.test.ts`. Each was run against the unfixed code
first — M5b's two round-trip cases and all five M10 cases fail there, and M5a's reduction case
fails there.

### What Wave 2 deliberately did **not** do

- ~~**`--target-reduction-ratio` stays**~~ **— now a real target, DECISIONS §48.** It reached
  nothing (`pruning:topology-pruner` bypassed itself when only a ratio was set) and stopped at
  nothing (compression ran to exhaustion, producing 44–69% for any target). It now resolves to a
  token ceiling and compression halts there. Adherence is **partial**: at target 30%, 21 of 66
  reducing files land in 25–35% and 23 still exceed 50%, because elision's smallest unit is one
  region and files typically have one dominant region. Corpus aggregates fell as a result
  (python file 23.14% → 20.26%) while fallbacks fell and reduced counts rose — the target being
  honoured, not a regression.
- **`OptimizationBudget` keeps `maxOutputTokens`, `maxLatencyMs` and `riskTolerance`.** H4
  withdrew the CLI flags, the environment variables and the MCP schema property — the *surface* —
  but `ARCHITECTURE.md` pins the model as frozen, and a field awaiting an implementation is not
  the same defect as a dial that reports success. Each field now carries a doc comment naming its
  consumer or stating it has none.
- **`bench-table-renderer.ts:97` still prints a `risk` column** sourced from that field. It is now
  the only reader of `riskTolerance` in the codebase, and a benchmark column implies the row's
  numbers depend on it — they do not. Small, real, and out of H4's scope; worth folding into the
  H2/M1 documentation-honesty decisions.
- **`--max-debt` was left alone.** The audit's item 8 lists it, but unlike the other three it does
  reach `DebtTracker`; it is merely *arithmetically* inert on the CLI (no ledger →
  `overallConfidence = 1.0` → `confidencePenalty = 0`; turn 1 → `turnAgePenalty = 0`;
  `elisionRatioPenalty` caps at 35 against a default threshold of 75). Removing a flag that is
  wired but ineffective is a different argument from removing one that is not wired at all.

### Residue worth knowing

- `handleToolCall` still accepts a call with no `traceStore` and falls back to a module-level
  default. `createMcpServer` always supplies one, so the shared-state defect is closed on every
  shipping path; the default exists for direct callers, chiefly tests.
- `SUPPORTED_PROTOCOL_VERSIONS` lists exactly one revision, `2024-11-05`. That is the honest
  list — negotiation advertising more than the code implements would be M5's own defect again.
- `getSession` was added to `GatewaySessionStoreInterface`, so any third-party implementation of
  that interface must now provide it.

---

## 4. Traps specific to this codebase

Learned the hard way during Waves 0–3.

- **`baseline.json` assertions are equality, not floors.** They fire on *improvement* as loudly
  as on regression, by design — a `>=` against a measured floor of 0.0 can never fail. If a
  change moves the shipped-fixture numbers, record the new ones deliberately.
- **Hazard-pinning tests exist and will fail on purpose.** Several tests assert current behaviour
  *because it is wrong*, with a comment saying so. Four were updated across Waves 1–3. Read the
  comment before "fixing" the test — it usually names the finding and why it was pinned.
- **Verify a new test fails against the unfixed code.** Every fix in Waves 0–3 did this, and it
  caught a test that would have passed either way.
- **Item `id` is content-derived at construction and preserved by the transforms.** Drift's
  retained-item scoping depends on that correspondence and guards against its absence (§43); do
  not introduce a stage that rebuilds items with fresh ids.
- **The MCP transport is safe from the chunk-splitting defect** because `setEncoding('utf8')`
  installs a `StringDecoder`. Do not "optimise" it into manual concatenation (§38).
- **Some tests pass because of the environment, not the code.** Removing M8's
  `NODE_ENV === 'test'` branch failed ten tests in `test/unit/gateway.test.ts` that had been
  relying on vitest setting that variable — none of them mentioned it. Before concluding a
  behaviour is covered, ask what would happen to the test outside its runner.
- **A format restated in two places will drift, and both copies will look right.** M5b's emitter
  and matcher were each self-consistent and had never agreed. When a test must construct a
  marker, placeholder or wire format, build it by **calling the producing code**; a literal in
  the test is a third copy of the same guess.
- **When measuring, check that the measurement ran.** Two near-misses in one Wave 2 A/B: a build
  that failed left the previous `dist/` in place so an engine was compared against itself, and a
  diff keyed on a non-existent field collapsed 594 rows to 2 and reported no differences. Both
  produced a green result. Assert the row count and the artefact you think you built.
- **Build the comparison engine with an `src`-only tsconfig.** `npm run build` typechecks `test/`
  too, so a branch whose new tests reference new APIs fails to build and silently leaves the
  previous `dist/` in place. `{"extends":"./tsconfig.json","include":["src"]}` is the whole file.
- **Aggregate reduction figures are not comparable across a commit, let alone across waves.**
  C4 measured TypeScript file at 23.16% against Wave 2's 23.26%, same recipe, same counts — and
  the *pre-C4* engine also read 23.16%. The cause was **line endings**: Wave 2's corpus was frozen
  from working-tree files written with LF, and committing normalized them to CRLF, adding a byte
  per line to the repo's own sources, which are the corpus. Only the per-row A/B over one frozen
  corpus means anything.
- **The audit's findings hold; its reachability assessments have not.** Three now: §40's proposed
  `filepath:` fix was measured inert, §42's imperative scoping was wrong, and §45 found C4 live
  on the one path the Gateway saves anything on, against an audit that called it masked and "that
  is luck". Reachability here depends on interactions between the drift exemption, the planner
  mode and the stage list that are not local to the code being read. **Measure before believing
  a defect is latent** — that belief is what defers it.

---

## 5. Beyond Wave 2

- ~~**§3.1 / Phase 1c — per-item fallback.**~~ **Done, DECISIONS §47.** A failure that names its
  item now reverts only that item; the repaired bundle is re-validated through the same
  `validate` and emitted only if it passes. Measured: 45-file Python **0.00% → 22.73%** (14
  reverted), 61-file TypeScript **0.00% → 19.47%** (21 reverted), **574/574** single-file corpus
  rows unchanged, 14/14 single-file fallbacks still byte-identical.

  Two things to know before touching it. **The refusal gate was tried too strict and corrected by
  measurement** — "refuse if any error is unattributable" let `SEMANTIC_DRIFT_EXCEEDED`, which
  names nothing, discard the constraint attribution that named 21 items; the gate is now "is
  there a principled subset to revert?", safe because the candidate is re-validated regardless.
  And **repair declines when every changed item would be reverted**, routing to the real fallback
  instead, because fallback echoes `request.rawInput` while repair renders from items — §35
  exists because those differ for non-UTF-8 input.

  Still open on this axis: drift remains a bundle-scoped score. It is *repairable in practice*
  (reverting items lowers it — 0.4122 → 0.0056 on TypeScript) but it never names an item itself,
  so a bundle failing on drift alone still falls back whole.
- ~~**C4 — structured message content flattened to a string.**~~ **Done, DECISIONS §45** — and
  the premise recorded here was wrong. It was *not* "still masked by the drift gate": that holds
  for a cross-turn sole copy, but content duplicated **within one payload** is elided
  `recoverable: true`, which drift exempts, so it shipped. Measured on the pre-fix engine,
  `messages[2].content` came back as the string `"{\"__td_block__\":\"[TokenDamper Elided: …]\"}"`
  with `fallbackUsed: false` and `tokensSaved: 42`. That is the one case the Gateway saves
  anything on at all, so C4 was live on precisely the path the mode exists for.
- ~~**H2 — language coverage.**~~ **Decided: report why. DECISIONS §46.** Every language is
  still accepted — pass-through is byte-identical and refusing it would remove a working
  behaviour to make a point. What changed is that the run now says when elision cannot reduce
  the input: `trace.languageSupport` carries `supported`/`unsupported`/`noneSupported` and a
  `reason` string, and `validate()` raises an **info** issue, `LANGUAGE_NOT_ELIDIBLE`.

  Measured, elision reduces **3 of 17** probed languages — TypeScript, JavaScript, Python —
  which matches both the audit headline and the corpus. The predicate is `supportsRegionElision`
  and nothing looser: a first attempt asked "does the item yield symbols?" and called Go
  supported, because a trivial Go file yields exactly one — `import:fmt`, an incidental match by
  the TypeScript import regex.

- ~~**M1 — "AST-lite validator".**~~ **Decided: correct the docs, do not wire the compiler
  API. DECISIONS §46.** `README.md` and `CLAUDE.md` now say **bracket/quote integrity** and
  carry a per-language table of what each validator does and does not catch.
  `test/unit/validator-guarantee.test.ts` pins all of it as characterization tests, verified
  against the shipped validator rather than copied from the audit.

  Wiring `ts.createSourceFile` was rejected on cost, not principle: `typescript` is a *dev*
  dependency today, and promoting it to runtime costs install size and parse latency against a
  lexer that runs in single-digit milliseconds. Revisit if the guarantee needs to be stronger.

- ~~**M11 — documentation volume.**~~ **Decided: retire the narratives and the root planning
  artifacts. DECISIONS §46.** Twelve files, **226 KB**, 31 markdown files down to 19.
  `docs/retired-documents.md` maps each to where its conclusion lives and how to read the
  original out of git.

  **The 4.1:1 premise was stale.** Measured before the cleanup it was **1.40:1**, and not
  because the docs had shrunk — they had grown to 726 KB — but because `src/` grew faster.
  Counting the **32.8%** of `src/` that is comment prose, prose:code ran ~2.6:1. After the
  retirement, markdown:src is **0.95:1**.

  The in-source commentary was deliberately left alone. It is the part that sits next to the
  code it explains and is maintained with it; the retired files were the part that had to be
  kept in sync by hand, which is the failure mode M11 actually names.

  **Twenty-five source and test comments cite a retired document.** They are marked
  `[retired]` rather than rewritten: the citation names a document and section that existed and
  git still has, whereas re-pointing 25 citations at DECISIONS sections by hand would risk
  mapping some of them to the wrong place. `CHANGELOG.md` and `DECISIONS.md` keep their older
  citations untouched for the same reason — they are append-only records of what was true when
  written, and each now carries a note saying so.

---

## 6. M7 — the one audit item still open

**Gateway savings are measured against an abstraction, not against the bytes sent.**
`max_audit.md` §M7. Re-verified against source **2026-08-12** — open in full, nothing partial.

| M7's three consequences | state at `5c7919b` |
|---|---|
| metrics measure the bundle render, not the wire | **open.** `proxy.ts:468-469` reads `initialBundle.summary.tokenEstimate` / `result.finalBundle.summary.tokenEstimate` |
| re-serialization mutates the client's request | **open.** `proxy.ts:698` and `:838` rebuild the body with `JSON.stringify({...parsedPayload, …})` whenever an item changed |
| nothing asserts `finalBody.length <= rawBody.length` | **open.** No such comparison exists in `src/gateway/` |

**Why it was dropped, and why that matters more than the item.** M7 was gated in `ROADMAP.md`
behind *"Only if B keeps the Gateway"*. Question B was answered — §41 kept the Gateway and
labelled it experimental — but nothing carried M7 forward across the answer, and it entered no
wave table. A conditional that has since been resolved reads exactly like a closed item.

**One consequence is partly bounded by work done since.** C4 (§45) fixed the *mapping* half:
the Anthropic `system` item is now mapped back, so the specific case where `tokensSaved` counted
a saving that never reached the wire is closed. What remains is that the number is computed
over the wrong artefact in the first place, which is the finding itself.

**Scope caution before scheduling it.** Re-serialization is not a metrics bug and should not be
fixed as one — it mutates a *client's* request (pretty-printing, numeric literal normalization,
>2⁵³ integer precision, duplicate keys), which is the same mechanism the project already
identified as the phantom −1.39% in the Python harness, reproduced in production code. Measuring
`finalBody` against `rawBody` is small; not rewriting the payload when nothing was elided is the
part with user-visible consequences.

---

## 7. What is next

Ordered by measured value ÷ risk. Preconditions verified as holding — as distinct from
`ROADMAP.md`'s v1.3.0 headline features, whose preconditions were measured and **do not** hold
(no query source for BM25; 0 of 1,486 real pairs above MMR's threshold).

1. ~~**Release §48.**~~ **Done — v1.3.0, 2026-08-12.** The version collision it named was settled
   by releasing the reservation rather than renumbering the chain a second time: a release whose
   preconditions are measured false now holds no number (DECISIONS §49).
2. ~~**Sub-region elision.**~~ **Done — v1.4.0, DECISIONS §50.** Rows above 50% achieved went
   **34 → 18** over 576 corpus rows with zero regressions; 18 remain because a single *statement*
   is dominant, which needs elision inside a control-flow block. The original entry read: the
   flag now binds but
   adheres partially — at target 30%, 21 of 66 reducing files land in 25–35% and **23 exceed
   50%**, because elision's smallest unit is one region and files have one dominant region
   (58%, 61%, 83% measured). Narrowest blast radius; `test/unit/target-reduction-ratio.test.ts`
   already pins the limit and is where the tightening would be asserted.
3. **Widen elision beyond TypeScript/JavaScript/Python.** Largest raw gain — every other bucket
   in §2 is 0.00%. **It is not one gate, despite `supportsRegionElision` being one function.**
   `regionElisionLanguage` derives its answer from `selectValidator().language`, so a new
   language needs a validator *and* `extractSymbols` coverage as well as a region scanner; add
   the scanner alone and §33's measurement gate refuses the item, converting a 0% into a
   fallback.
4. **Per-item drift.** Finishes Phase 1c. `SEMANTIC_DRIFT_EXCEEDED` names no items
   (`validation/index.ts:186-187` — `S_k` is a whole-bundle set comparison), so a bundle failing
   on drift alone still reverts whole, while AST and constraint failures now repair per item.
5. **M7**, per §6 — small, and the only thing between the audit and an empty list.
