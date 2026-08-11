# Audit remediation — status and next steps

Working state for the `max_audit.md` remediation. **Read this before picking up audit work**;
it records what is done, what is measured, and what the next batch actually requires.

Last updated 2026-08-10, at `main` = `0cf63dd` + Wave 2 working tree. Suite: **557 passing**,
typecheck and lint clean.

---

## 1. Where things stand

| Wave | Items | Status |
|---|---|---|
| **0** | H3, M3, M4a | ✅ merged |
| **1** | C1a, C1b, C2, M6 | ✅ merged |
| **2** | M5a, M5b, H4, M8, M9, M10 + M5 minor | ✅ **done — DECISIONS §44** |
| **3** | C3/H1 ✅, H6 ✅, H5 ✅, C4 ✅ | ✅ **done — C4 in DECISIONS §45** |
| Decisions | H2, M1, M11 | ✅ **decided and done — DECISIONS §46** |

**Every audit item is now closed.** What remains is the architectural work in §5 — chiefly
Phase 1c, which is the binding constraint on multi-file value.

The three decisions were taken as: **H2 — report why** (keep accepting every language, but say
when elision cannot reduce it, rather than narrowing the accepted set); **M1 — correct the
docs** (say "bracket/quote integrity", do not wire the compiler API); **M11 — retire the
narratives and the root planning artifacts**. Each is argued in §46.

### Corresponding DECISIONS entries

§36 license · §37 C1a · §38 C2 · §39 M6 · §40 C1b · §41 C3/H1 · §42 H6 · §43 H5 · §44 Wave 2 ·
§45 C4 · §46 H2/M1/M11

---

## 2. Measured baseline

Recorded 2026-08-10 after Wave 2, via `tools/corpus-harness`, 297 files / 594 rows, both routes.
**These are the numbers to compare against; do not re-derive them from memory.**

| bucket | route | n | reduced | fallback | saved |
|---|---|---|---|---|---|
| python | file | 45 | 30 | 14 | **23.14%** |
| python | stdin | 45 | 28 | 13 | **22.66%** |
| typescript | file | 60 | 33 | 20 | **23.26%** |
| typescript | stdin | 60 | 0 | 0 | 0.00% |
| prose | file/stdin | 29 | 0 | 8 | 0.00% |
| shell, perl, tcl, c, rust, css | both | — | 0 | — | 0.00% |

**No number here is comparable across waves, and the TypeScript row is the live example.** It
reads 23.26% over 60 files where the `dd540fe` table read 25.35% over 59, and 29.55% in
`DECISIONS` §43 over fewer still. Same engine every time; the corpus grew.

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

- **`--target-reduction-ratio` stays**, even though the planner reads it only as `> 0` and it is
  therefore an on/off switch named like a dial. It is the only budget flag every doc and example
  uses, and making it a real proportional target is a planner change, not a flag change. This is
  still its own open decision.
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

- **§3.1 / Phase 1c — per-item fallback.** Now the binding constraint on multi-file value: on the
  45-file Python corpus, drift is 0.0359 and AST is clean, yet **26 constraint failures across 14
  items revert all 45**. Phase 1c's stated prerequisite was attribution, and that now exists —
  constraint failures name their item (§42), unwitnessed items name theirs (§37), AST issues carry
  `itemId`. Drift remains bundle-scoped and would need its own rule.
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
