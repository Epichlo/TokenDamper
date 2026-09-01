# Audit remediation — status and next steps

Working state for the `max_audit.md` remediation. **Read this before picking up audit work**;
it records what is done, what is measured, and what the next batch actually requires.

Last updated 2026-09-01. **Shipped as v1.7.0** (with a test fix in v1.7.1)**:** the last four `oxaudit.md` findings — M15, M8,
M9 (with L13) and M13 — DECISIONS §70, §1 below, which **closes `oxaudit.md` in full**. Note
v1.7.0 is the first npm release since 1.6.0: **1.6.1 was tagged and released on GitHub but never
published**, so its contents ship here. **Shipped as v1.6.1 (tag only):** a pruned-file warning (§7.8),
`--keep-docstrings` (DECISIONS §58, §7.9) — both found by dogfooding, not the audit — **widening
elision to Go, all three steps** (DECISIONS §59, §60 and §61, §7.3, §9), and the `oxaudit.md`
remediation itself: §62 (two withdrawn dials), §63 and §69 (the float pool and the OX LOW table),
§64 (`debtScore` becomes a measurement) and §65–§68 (four Gateway defects that reached provider
traffic). **Go reduces** — application Go 27.46% and stdlib 19.42% at target 0.3, against this
repo's TypeScript at 21.22%. The main 287-file corpus is 574/574 byte-identical, because every Go
path is gated on the language. On top of **v1.6.0** — §54 (M7), §55 (the LOW table), §56 (the
measured precondition for widening elision, §9) and §57 (the block-hash false positive), itself on
**v1.5.0** (§52, the constraint gate stops firing on narrative comments), v1.4.0 (§50) and v1.3.0
(§48, §49). Suite: **826 passing across 91 files**, typecheck, lint and build clean.
`npm run format` no longer exists; `lint` is the enforced style gate.

**v1.6.1 is numbered a patch even though output moved.** Go elision and §64 both change what the
same command emits for the same input, which is normally this project's threshold for a minor
(§53). The number was an explicit call at ship time; the rule is unchanged for the next release.
Do not read the patch digit as evidence that nothing moved.

**`max_audit.md` is closed in full — every severity band, verified against source 2026-08-15.**
§54 and §55 are what closed it, and both were items this document had already declared done. Read
§1 before trusting any "all closed" line here, including this one.

**§2 is the v1.4.0 baseline and does not include §52.** On the same frozen corpus §52 takes the
TypeScript file row to 43 reduced / 12 fallbacks / 24.58%; python is unchanged. Re-freeze and
re-measure before quoting a current figure — §4 explains why a remembered one is worse than none.

---

## 1. Where things stand

| Wave | Items | Status |
|---|---|---|
| **0** | H3, M3, M4a | ✅ merged |
| **1** | C1a, C1b, C2, M6 | ✅ merged |
| **2** | M5a, M5b, H4, M8, M9, M10 + M5 minor | ✅ **done — DECISIONS §44** |
| **3** | C3/H1 ✅, H6 ✅, H5 ✅, C4 ✅ | ✅ **done — C4 in DECISIONS §45** |
| Decisions | H2, M1, M11 | ✅ **decided and done — DECISIONS §46** |
| **Unscheduled** | **M7** | ✅ **closed — DECISIONS §54.** See §6 for how it was lost and found. |
| **Never scheduled** | **L1, L4–L9** | ✅ **closed — DECISIONS §55.** L2/L3 closed incidentally by C2. See §8. |

**Phase 1c is closed** (DECISIONS §47), which was the binding constraint on multi-file value,
and §48 closed H4's deferred half. §5 records what is left on the architectural axis.

### `oxaudit.md` is a second audit, and it is **open** — do not read the table above as covering it

`oxaudit.md` (ox-alpha, 2026-08-23, against `79aedef`) is an independent review, unrelated to
`max_audit.md`'s wave structure. It is committed at the repository root for the same reason
`max_audit.md` is — the changelog cites its `OX-*` IDs — and, like `max_audit.md`, **it records
what was true when it was written and has not been edited since.** A finding described there in the
present tense may already be closed. This section is the disposition; the audit file is not.

The findings were split by **file ownership** rather than severity, so two agents could work without
colliding on `src/cli/main.ts` and `src/gateway/proxy.ts`. `oxaudit-split.md` carries the partition
and the reasoning.

| Lane | Scope | State |
|---|---|---|
| **A** | `src/cli/**`, `src/config/**`, `src/core/engine/`, `planner/`, `topology/`, `src/bench/runner.ts`, `src/gateway/exec.ts`, repo hygiene | ✅ **closed** — the last two, M15 and M13, in §70 |
| **B** | `src/gateway/{proxy,server,session-store,types}.ts`, `stages/cleanup/session-dedup.ts`, `stages/compression/token-hashing.ts`, `adapters/mcp/server.ts`, `bench/fixtures/loader.ts` | ✅ **closed** — H2, H4, M1, M5, lows (§69), and **M8, M9 + L13 decided and implemented (§70)** |

**Closed (Lane A):** H1, H3, **H5**, M2, M3, M4, **M6**, **M7**, M10, M11, M12, **M13**, M14, **M15**, M16.

**H5 was decided as *withdraw*** — DECISIONS §62. `--trace-output`, `TOKENDAMPER_TRACE_OUTPUT` and
the `explain` value of `--mode` / `TOKENDAMPER_APP_MODE` are gone from every input surface; the
`ResolvedConfig` fields remain, documented as unconsumed, on audit H4's terms. `--mode bench` is
untouched — it rewrites the command, which is a live effect. Note the flag's only caller in this
repo, `tools/corpus-harness/measure.js`, was passing `--trace-output stderr` while reading stderr
correctly all along; it was updated in the same change and re-verified.

**M6 and M7 are closed — DECISIONS §64, and the measurement is the point of the entry.** M7 was
larger than the audit stated: `debtScore` read exactly **35.00 on 317 of the 317 rows that carried
any debt**, the clamp ceiling, regardless of whether a file lost 4.7% or 66.8%. It was a constant
wearing the name of a measurement. After the fix, 0 of 317 sit at the ceiling and the implied ratio
tracks the measured byte cut with correlation **1.0000**, with all 578 rows byte-identical. M6 is
reachable only through the exported `optimize` API, not through any of the three bundled entry
points, so its corpus arm differs on **0 of 578 rows** — which is a fact about the instrument, not
evidence of correctness.

**H4 is closed — DECISIONS §65, the first Lane B item taken.** Egress located each message by
searching the raw body for `JSON.stringify(text)`, so a `content: null` tool-call turn — the
standard OpenAI shape — produced the search string `"null"` *with quotes*, missed, and because
`spliceIntoRawBody` declines on the **first** miss, discarded the replacements for every other
message. Measured: **8,685 bytes sent, 8,685 forwarded**, the entire saving gone. Array content
failed identically at 8,530/8,530, which is why the fix is a structural span scan rather than the
`null` special-case the audit suggested. The old value search is kept as a fallback, so a declined
payload behaves exactly as before. Invariant 8 untouched: still only `cleanup:session-dedup`, still
no cross-turn saving.

**H2 is closed — DECISIONS §66.** `AbortSignal.timeout(30000)` was handed to `fetch`, and a fetch
signal keeps governing the **response body stream** after the promise resolves — so streaming
answers were truncated ~30 s in, on the traffic the Gateway intercepts by default. The budget is now
time-to-first-byte, disarmed in a `finally` once `fetch` settles. Client-hangup abort is unchanged
and mutation-checked. `upstreamTtfbTimeoutMs` (default 30000) is configurable, which is also what
made the defect testable: catching a 30-second bug used to need a 30-second upstream, which is why
no test caught it.

**M1 is closed — DECISIONS §67.** Within-payload dedup was gated on the block also having been seen
in a *previous* turn, so a first turn carrying the same block three times went out whole (8,459
sent, 8,459 forwarded) while the README claimed it saved. The gate did no safety work there:
`recoverable: true` means an intact copy survives in the same outbound payload, checkable without
history. §16/§41 untouched — a sole copy across turns is still refused, and the ordinary
conversational shape still saves 0 and still falls back.

**M5 is closed — DECISIONS §68.** `trimRegionsToCeiling` priced every candidate span by rendering
its marker, and the renderer it was handed also registered the block — so discarded candidates were
stored anyway. Measured on a 12-region file: **12 registered against 5 emitted** at target 0.1, 12
against 3 at 0.05. The store grew with candidates rather than elisions. Corpus A/B at `48ac6c8`:
**0 of 578 rows differ**, with 101 genuinely reducing, which verifies the binding constraint that
pricing and emission render identical bytes. The corpus cannot see the leak itself — CLI routes
supply no hasher — so that half is covered by a unit test.

**The LOW table is closed against its own list — DECISIONS §69.** L6, L7, L9, L10, L12 and L19
fixed; **L1, L8, L13, L17 and L18 recorded at their sites with the reason they are acceptable rather
than correct**; L14–L16 were "no action" in the audit itself; L2, L3, L5 and L11 went with the float
pool (§63) and L4 was recorded when the ingestion work landed. Every row is dispositioned, including
the ones not fixed — which is the half that went missing when `max_audit.md`'s LOW table was
declared closed (§55).

**`oxaudit.md` is closed in full — every finding, verified against source 2026-08-30.** The
last four are DECISIONS §70: three were decisions rather than work, and one was a paragraph.

- **M15 (Lane A) — decided *default off*.** Plain `tokendamper bench` no longer executes fixture
  code through `python`; `--evaluate-quality` asks for it, and the two regression suites that
  assert on execution results now request it by name. Verified on the built artifact: plain
  `bench` writes **0** `python-subprocess` evaluations, `--evaluate-quality` writes **5**.
- **M8 (Lane B) — decided *refuse to start*.** A non-loopback bind with no `gatewayToken` is a
  startup error naming the exposure, with `allowUnauthenticatedNonLoopback` as the explicit
  opt-in. Loopback trust (C3) and the constant-time compare are untouched and asserted. `exec` is
  unaffected — it binds loopback *and* generates a token.
- **M9 (Lane B) — decided *Origin/Host validation*.** A foreign `Origin` is refused on every
  bind; a foreign `Host` is refused on a loopback bind, where DNS rebinding is the threat.
  **L13 folded in**: `/health` returns `{"status":"ok"}` and no longer reports `sessionCount`.
  Two corrections went with it — the audit's proposed OPTIONS/CORS handler was measured
  unnecessary (OPTIONS already answers `405` with no CORS headers, and the threat is a *simple*
  request that skips preflight), and the recorded decision's claim that non-browser clients "send
  neither header" is false of `Host`, which every HTTP/1.1 client sends.
- **M13 (Lane A) — documented, not fixed.** `--minimum-confidence` gates ledger confidence only
  (validation confidence is binary 0/1) and `--max-debt` cannot trip on a CLI run either, because
  `attemptAutomatedRehydration` returns immediately without a hasher or ledger and the CLI
  supplies neither. That reason is stronger than §64's — §64 explained the *default* threshold,
  and `--max-debt` is the flag that lowers it. `test/unit/cli/inert-dials.test.ts` pins both as a
  characterization test.

**The corpus was not run for any of the four, deliberately.** Bench, the flag-parse loop and every
Gateway path are off the optimize route, so a byte-identical result would have been vacuous. This
is §56's caution in the other direction: byte-identical is not evidence when the corpus cannot
contain the shape.

**Recorded rather than fixed:** **L4** (a symlink is skipped inside a directory walk but followed
when named directly). The fix is small, but creating a symlink on the machine it was written on
returns `EPERM` without elevation, so it could not be exercised — and an unverified change to the
code that decides which files reach the pipeline is the trade this project keeps declining.
Skipping omits a file; it never corrupts one. The note lives at the site in `src/cli/ingest.ts`.

**Two findings did not survive checking, and both are the reason this section exists:**

- **OX-M3(a) is not a defect.** `--input-name` does not silently no-op on a directory —
  `parseArguments` already throws for any non-`-` input path. Now pinned by a test so it stays true.
  Its sibling M3(b) was real and *worse* than described: a blanket `--language` over a mixed tree
  moved `languageSupport` from "1 unsupported (json)" to "3 supported, 0 unsupported", left
  `astCoverage` reading `unchecked: 0`, and fell the whole run back.
- **OX-M10 was scoped to one door and had three.** The audit named
  `TOKENDAMPER_MINIMUM_CONFIDENCE`; the CLI flag carried the identical `Number.isFinite`-only check
  and the config file was type-checked as bare `number`. All three validate now.

That is the same lesson §1 already carries one level up: enumerate the document's own list, not the
list of things that were worked on.

**The H5 trap, now closed:** `tools/corpus-harness/measure.js` was passing `--trace-output stderr`.
Withdrawing the flag would have made the measurement harness a parse error; it was updated in the
same change (DECISIONS §62) and re-verified end to end.

**This document has claimed "every audit item is now closed" twice, and been wrong twice.**

First M7 (§6). It appears in no wave table above, and the last document to mention it was
`DECISIONS` §41 — "M7 … remains open", written before Wave 2. Re-verified against source
2026-08-12: open in full, and **closed the same day** (§54). The failure mode was named then, as
this project's own §4 rule turned on its documentation: **an item that is in no table reads as
done, exactly like a check that never ran reads as a pass.**

Then the entire **LOW table** (§8). `max_audit.md` §2 ends with nine LOW rows. The wave tables
above account for every CRITICAL, HIGH and MEDIUM finding, and **L1, L4, L5, L6, L7, L8 and L9
appear in no wave, no decision and no row of this document**. Re-verified 2026-08-15: all seven
open. Closed the same day (§55).

**Naming the rule did not stop it recurring three days later, which says the rule was not the
fix.** The fix is procedural and is now the first line of §8: *close a document against its own
list of findings, not against the list of work that was done.* A severity band nobody scheduled
looks exactly like a severity band everybody finished.

The three decisions were taken as: **H2 — report why** (keep accepting every language, but say
when elision cannot reduce it, rather than narrowing the accepted set); **M1 — correct the
docs** (say "bracket/quote integrity", do not wire the compiler API); **M11 — retire the
narratives and the root planning artifacts**. Each is argued in §46.

### Corresponding DECISIONS entries

§36 license · §37 C1a · §38 C2 · §39 M6 · §40 C1b · §41 C3/H1 · §42 H6 · §43 H5 · §44 Wave 2 ·
§45 C4 · §46 H2/M1/M11 · §47 Phase 1c · §48 target binds · §50 sub-region elision ·
§51 per-item drift closed unbuilt · §52 narrative directives · §53 no reserved numbers ·
§54 M7 · §55 the LOW table

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
- **A route the harness does not drive is a route nothing measures.** `tools/corpus-harness`
  runs the CLI. Checks that are inert on the CLI — anything gated on a `TokenHasher`, a session
  context or a multi-turn payload — are invisible to every number this project has ever recorded.
  §57 found a gate that failed *every* MCP run on 22 of this repo's files while the corpus stayed
  576/576 byte-identical, because the CLI supplies no hasher and the check returns early. Before
  reading a byte-identical A/B as "no effect", ask whether the measured route executes the code
  being changed.
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

  Measured, elision reduces **4 of 17** probed languages — TypeScript, JavaScript, Python and,
  since §61, Go —
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

## 6. M7 — closed, and how it went missing

**Gateway savings are measured against an abstraction, not against the bytes sent.**
`max_audit.md` §M7. Re-verified open in full **2026-08-12**, then **closed the same day —
DECISIONS §54**. All three consequences below were live when measured. `max_audit.md` is now
closed in full.

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
3. ~~**Widen elision beyond TypeScript/JavaScript/Python.**~~ **Done — all three steps,
   DECISIONS §59, §60 and §61.** Go reduces: **27.46%** on application Go and **19.42%** on the
   stdlib at target 0.3, against this repo's TypeScript at 21.22% — the newest language is the
   strongest, and §56 projected 23–28%. The main 287-file corpus is 574/574 byte-identical.

   **The ordering paid for itself twice, and §9 carries the measurement.** Re-running step 3
   with §59 neutered reproduces §56's hazard on real input — 32 files elide at `S_k = 0.0000`
   with both gates green, one of them losing 78.4% of its tokens. And §59 turned out to be a
   *precondition for reduction*, not a tax on it: without it fallbacks more than double and
   application Go reads 14.45% instead of 27.46%.

   **What is next on Go is not the scanner.** 18 of its 20 fallbacks are
   `CONSTRAINT_DIRECTIVE_LOST` on descriptive present-tense comments — §5 above, still open. Largest raw
   gain: every other bucket in §2 is 0.00%, and a
   real Go corpus offers **55–65%** of its bytes as elidable function body against TypeScript's
   57.78% — at least as much material as the product's best language.

   **It is not one gate, despite `supportsRegionElision` being one function.**
   `regionElisionLanguage` derives its answer from `selectValidator().language`, so a new
   language needs a validator *and* `extractSymbols` coverage as well as a region scanner.

   ~~Add the scanner alone and §33's measurement gate refuses the item, converting a 0% into a
   fallback.~~ **Measured false, in the dangerous direction — §9.** That happens only for a file
   with no struct, class or import. Real Go/C/Java/Rust carries one, which manufactures a symbol
   body elision cannot destroy, so the gate passes with `astMeasured: true` and `S_k = 0.0000`
   having witnessed nothing. **Scanner-first yields silent unmeasured elision, not a visible
   zero.** Order: `extractSymbols`, then the validator, then the scanner.
4. ~~**Per-item drift.**~~ **Closed without implementing — DECISIONS §51.** The precondition was
   measured and fails: `SEMANTIC_DRIFT_EXCEEDED` — the only drift failure that is not already
   attributable — accounts for **0 of 117** corpus fallbacks, and multi-item bundles measure
   `S_k` at **0.0024–0.0056** against a 0.40 threshold at every ratio from 0.3 to 0.9.

   **This entry was not wrong when written; §48 and §50 closed it and nobody re-measured.** The
   `0.4122` in §47 that motivated it came from an engine that elided everything it could. A
   token ceiling and a statement-sized unit cut symbol loss two orders of magnitude below the
   gate. **An open item is a claim about the current build, and it expires like any other.**
5. ~~**Make the constraint gate finer.**~~ **First pass done — DECISIONS §52.** A narrative use of
   `never`/`always` in a comment is no longer a directive: **4 fallbacks fixed, 0 new, 572 of 576
   rows byte-identical**, TypeScript file route 39 → 43 reducing.

   **Read §52's caveat before quoting the 6pp.** All four recovered files are this repository's
   own source, which M11 measured as 32.8% comment prose written in a what-used-to-be-true style.
   **Python gained zero.** That is the corpus-bias trap of §4 appearing as a *favourable* number,
   which is the harder direction to notice.

   **Still open on this axis**, and deliberately not attempted: descriptive present-tense uses
   (*"is always deterministic"*, *"do not support"*) still raise directives. They are descriptive,
   but the line between describing a constraint and stating one is blurry there, and this gate
   protects content — over-narrowing deletes an instruction, which no reduction figure buys back.
   §50's other open item is the same gate: it is why the better sub-region coverage setting costs
   two working files.
6. ~~**M7.**~~ **Done — DECISIONS §54.** ~~The audit is closed in full.~~ The re-serialization
   half was the one that mattered: a seed past 2^53 reached the provider as a different number.
   The metrics half was mild — 48.5% claimed against 47.1% on the wire, now 46.3% against 46.5%.
   The struck sentence is §8's subject: it was written the day M7 closed and the LOW table was
   still open.
7. ~~**The LOW table.**~~ **Done — DECISIONS §55.** See §8.
8. ~~**Warn when whole files are dropped.**~~ **Done — unreleased on `main`.** `optimize ./dir`
   dropped whole files via the knapsack with no stdout signal, so a caller piping the output to
   a model saw a silently incomplete codebase. The CLI now names dropped files on stderr. Found
   by dogfooding on the expense-analyzer project, not the audit. Measuring the fixture also
   established that **pruning fires at every ratio from 0.05 to 0.5** — it is common, not
   exceptional.
9. ~~**`--keep-docstrings`.**~~ **Done — DECISIONS §58, unreleased on `main`.** The retention
   test found 3 of 4 lost answers lived in docstrings elision had removed. Opt-in, because
   measured it gives back 14.2%–21.1% of the saving; the default stays 576/576 byte-identical.
   Python-only, threaded as a runtime option so it never touches the frozen `OptimizationBudget`.

**With those two merged, item 3 (widen to Go) is the single remaining item on this list.** §9
carries its measured precondition and the sequencing the `widen-language` skill encodes.

**With that, the audit is closed in full and nothing here blocks feature work.** §3 of this
section is the largest measured gain still available: elision reduces **4 of 17** languages, and
every other bucket in §2 is 0.00%.

---

## 8. The LOW table — closed, and the second time this happened

**Seven findings (L1, L4, L5, L6, L7, L8, L9) were in no wave, no decision and no row of this
document.** L2 and L3 were closed incidentally by the C2 `Buffer` work — which is the tell: the
two that got fixed are the two that happened to sit inside someone else's diff. Verified against
source 2026-08-15; all seven open. Closed the same day, **DECISIONS §55**.

**The rule, and it is the whole point of this section: close a document against its own list of
findings, not against the list of work that was done.** §6 named the M7 version of this failure
three days earlier — *an item that is in no table reads as done* — and naming it did not prevent
the recurrence, because the check being run was still "what did we work on?". A severity band
nobody scheduled looks exactly like a severity band everybody finished.

| # | What it was | Disposition |
|---|---|---|
| L1 | `TOKENDAMPER_*` enum values silently dropped where the CLI flag throws | **fixed** — rejected through one helper, all four variables |
| L4 | `constraint-preservation` chains the previous `contentHash` into the new one | **recorded** — unreachable; the audit's premise is also wrong (see below) |
| L5 | `getOverallConfidence` returns the minimum, not an aggregate | **doc corrected** — the minimum is right for a safety gate |
| L6 | a "Branch & Bound" comment on code that does no such search | **comment corrected** |
| L7 | a blank first body line loses the Python region | **fixed**, and it was rated too low |
| L8 | escaped newline not counted, so reported lines drift | **fixed** |
| L9 | 12-hex marker prefix described as "ample" for identity | **doc corrected** — not widened; the failure is already safe |

### Two things worth carrying forward

**L7 was rated "fails safe (skip)" and costs the whole file.** A one-region file has nothing else
to elide, so the skip is a fallback. Measured: 434 → 96 bytes without a blank line after `def`,
436 → 436 with one.

**And the corpus cannot see it.** Per-row over the frozen 288-file corpus, **576 of 576 rows are
byte-identical** across all fifteen fields — because **0 of 45** Python corpus files have a blank
line in that position. pip internals and this repository's own Python are uniformly PEP 8 there.
This is §4's corpus-bias trap with the sign reversed: §52 produced a favourable number from
corpus bias, and here the bias hides a real gain. **Do not read "576 of 576 byte-identical" as
"inert"** — ask first whether the corpus contains the shape.

**L4's premise does not hold, which is why it is recorded rather than fixed.** It says the hash
"is no longer a hash of `item.content`", implying it was one. On the route that reaches this
stage it never was — `createContextBundle` hashes a provenance object and sets `id` to it. The
narrower defect (the value is chained) is real and unreachable: the one consumer treating this
hash as a content identity is `cleanup:session-dedup`, which runs only under `session_dedup`
planner mode, where `constraint-preservation` is not planned. Changing it moves `bundle.contentHash`
and every pinned id in the suite while moving no output byte. The condition that would make it
live is recorded at the site.

---

## 9. Widening elision — the measured precondition

Full reasoning in **DECISIONS §56**. This is the index and the numbers to compare against.

### Material available

Ceiling = share of bytes inside function bodies clearing the shipped filters
(`MIN_REGION_BYTES` 104, `isSubstantiveRegion`), on the `scanBraceSpans` between-brace boundary.
TypeScript and Python measured with the **shipped** `selectElisionRegions`.

| corpus | files | ceiling, non-test | ceiling, all | median/file | no region |
|---|---|---|---|---|---|
| Go — app (`cli/cli`, `cobra`, `gin`) | 1,028 | **65.36%** | 81.44% | 63.3% | 9.5% |
| Go — stdlib (`golang/go` `src/`) | 5,387 | **54.78%** | 59.81% | 39.5% | 28.2% |
| TypeScript — this repo | 62 | 57.78% | — | 58.6% | 11.3% |
| Python — pip | 45 | 46.88% | — | 53.8% | 2.2% |

TypeScript turns 57.78% into **24.56%** achieved at target 0.3. On that conversion Go projects to
**23–28%**. **Go first**, on `func` being an unambiguous header keyword where C's
`int foo(...)` is not, and Go having no preprocessor and no header/impl split.

### Three things to carry into the work

- **Sequence is `extractSymbols` → validator → scanner, and the reason is a safety hole, not
  tidiness.** A Go file with a struct or import yields symbols body elision cannot destroy, so
  scanner-first passes every gate while measuring nothing. §33 closed the empty-before-set case;
  this is the non-empty-but-irrelevant one, and §33 does not cover it. Step 1 alone is a free
  negative control: reduction must stay 0% everywhere while drift on a hand-elided file becomes
  non-zero.
- **Test files are the larger prize.** `_test.go` is 53 MB against 36 MB of source in the app
  corpus, at **92.22%** elidable. Nothing in this project has been counting them.
- **The ceiling is not the constraint; the gates are.** Target 0.9 on the frozen corpus gives
  TypeScript **21.37%** with 25 files unchanged, against **24.56%** with 12 at target 0.3.
  Pushing harder trips the constraint and drift gates. More material does not lift that ceiling.

### Step 1 landed — what it did and did not move (DECISIONS §59)

`extractSymbols` harvests `fn:Name` from `func Name(` (generics included) and
`method:Recv.Name` from `func (r *Recv) Name(`, both anchored to the start of a line. Measured
over one Go file, engine varied and nothing else:

| after-shape | `S_k` before | `S_k` after | gates before | gates after |
|---|---|---|---|---|
| whole item → marker | 1.0000 | 1.0000 | retention refuses | retention refuses |
| bodies elided, signatures kept | 0.0000 | 0.0000 | both pass | both pass |
| one whole declaration removed | 0.0000 | 0.1667 | both pass | both pass |
| **every declaration removed** | **0.0000** | **0.6667** | **both pass** | **retention refuses** |

**Row four is §56 reproduced through the shipped tracker**: every function in the file deleted,
package and import and struct standing, `astMeasured: true`, both gates green, no fallback. Row
two must not move and did not — region elision keeps signatures, so there is nothing to report,
and a gate that refused there would make step 3 a fallback generator. **The claim is therefore
narrower than "drift can now see Go": before, rows two, three and four were the same number.**

Corpus frozen at `7d97049`, 287 files, 574 rows, both arms built with an `src`-only tsconfig:
**574/574 byte-identical**, 0 rows differing across 17 fields including `symbolsBefore`. That is
*because the corpus contains no Go* — 0 of 287 files match either pattern — which is this
section's own caution arriving on the next change. Blast radius outside Go is evidenced by unit
cases (TypeScript using `func` as a loop variable, Python naming a parameter `func`), not by the
corpus. `test/unit/go-symbols.test.ts`: 9 of 14 fail against the unfixed engine, and the 5 that
pass both ways are named in the file header.

**Still unmeasured after step 1:** Go’s fallback rate, which is what the 23–28% projection
borrows from TypeScript. That needs step 2.
### Step 2 landed — coverage moves, output does not (DECISIONS §60)

`GoValidator` is a Go lexer, not a reuse of the TypeScript one, and the difference is the
measurement that justified writing it — 9,181 real Go files, 100.8 MB, the stdlib subset
hash-verified 5,387/5,387 against §56's manifest:

| validator | files flagged | rate |
|---|---|---|
| `TypeScriptValidator` | **73** | 0.80% |
| `GoValidator` | **1** | 0.01% |

The one Go flag is the compiler's own `testdata/issue20789.go`, whose header says *"Make sure
this doesn't crash the compiler"* — a true positive. The 72 disagreements are raw strings:
Go's backtick string spans lines, has **no escapes**, and holds quotes and braces. §17's
finding, measured for Go.

**0 findings is also what a validator that examines nothing reports**, so the control runs the
other way: deleting the last column-0 `}` is caught in **1,159 of 1,163** files (99.66%), and
all four non-catches were inspected and are braces inside a raw string, a `//` comment or a
cgo C preamble — mutations that are not defects.

On a separately frozen 80-file Go corpus, step 1 → step 2: items no validator looked at go
**80 → 0** on the file route, reduction stays **0.00%**, fallbacks stay **0**, and output is
**160/160 byte-identical**. Exactly three fields move, on exactly the 80 file-route rows.
The main 287-file corpus is **574/574 byte-identical**. The stdin route is unchanged at 40 per
bucket, because a piped `.go` has no filename and there is deliberately no Go content probe
(§31); `--language go` reaches the validator.

**It also exposed a reporting defect.** `DriftCoverage.symbolBearingItems` counts
validator-*covered* items rather than items bearing symbols. Go with §59 but without §60 was
the first language ever to have symbols and no validator, and all 80 frozen Go rows reported
`symbolsBefore = 3`+ next to `symbolBearingItems = 0`. Recorded at the site and not fixed here
— it is a parsed trace field, so changing it is its own decision.

### Step 3 landed — Go reduces (DECISIONS §61)

| bucket | files | reduce | fallback | aggregate |
|---|---|---|---|---|
| application Go (`cli/cli`, `gin`, `cobra`) | 40 | 32 | 8 | **27.46%** |
| stdlib (`golang/go` `src/`) | 40 | 25 | 12 | **19.42%** |
| `_test.go` (across both) | 40 | 32 | 7 | **26.88%** |
| source (across both) | 40 | 25 | 13 | **14.42%** |

§56 projected 23–28%; application Go landed at the top of it, above this repo's TypeScript
(21.22%). Adherence over the 57 reducing files: median **35.8%**, 20 in the 25–35% band, 17 in
35–50%, 14 above 50% — the profile TypeScript has after §50. **Main corpus 574/574
byte-identical.**

**§56's hazard, reproduced on real input rather than simulated.** Neutering §59 and re-running
step 3:

| | scanner-first (no §59) | shipped |
|---|---|---|
| file-route fallbacks | 43/80 | **20/80** |
| rows where drift measured anything | 55/80 | **80/80** |
| median `symbolsBefore` | 2 | **8** |
| application Go aggregate | 14.45% | **27.46%** |

**32 files elide at `S_k = 0.0000` with `astMeasured: true`, both gates passing and no
fallback, on 1–5 symbols that are all `type:` and `import:`** — `accessibility.go` loses 78.4%
of its tokens that way. And the safety step turned out to be the reduction step: without §59
many files have *no* symbols, so §33 refuses them outright.

**Go's fallback rate, and an expectation §56 got wrong.** 20 of 80 (25%), of which **18 are
`CONSTRAINT_DIRECTIVE_LOST`** and 2 are drift. §56 expected Go's lower comment density to make
that gate fire *less*; it dominates exactly as it does for TypeScript, at the same rate (24%,
15 of 62). Density was the wrong variable — Go's defensive comment style (`// Should never
happen, but we`) is §5's still-open axis verbatim.

### What is not established

The 23–28% projection borrows TypeScript's conversion factor, which embeds **TypeScript's**
fallback rate. Go's own fallback rate is unmeasurable until the validator and `extractSymbols`
exist. Go's lower comment density should make `CONSTRAINT_DIRECTIVE_LOST` fire less — an
expectation, not a measurement.

**The cross-check is the part worth imitating.** App-only read 65.36% and the stdlib pulled it to
54.78%; the cause was checked rather than averaged — **21.7% of stdlib source bytes are in files
with no elidable region**, mostly generated tables (`opGen.go` alone is 3.99 MB). One corpus would
have overstated this by ten points, which is §4's bias trap arriving on the feature side.
