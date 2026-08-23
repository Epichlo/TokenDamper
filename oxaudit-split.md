# oxaudit.md — work distribution (Lane A / Lane B)

- **Split authored:** 2026-08-23, by the Claude Code session in `C:\Users\ojass\Projects\TokenDamper`
- **Source document:** `oxaudit.md` (ox-alpha, 2026-08-23, audited tree `79aedef`)
- **Tree at split time:** `main` == `feat-go-region-elision` == `79e4cb3`. Working tree carries
  **uncommitted Go region-elision step 3** (`src/core/elision/regions.ts`, +288 lines;
  `test/unit/go-region-elision.test.ts`, `tsconfig.src.json` untracked). No audit finding touches
  `regions.ts`, so the two efforts do not collide in-file — but see §5 on worktrees.

## 1. How this split was derived

**The partition axis is file ownership, not severity or count.** Two agents editing
`src/cli/main.ts` or `src/gateway/proxy.ts` concurrently produces merge conflicts on exactly the
files that carry the most findings. So the audit's 5 High / 16 Medium / 20 Low items were mapped
to the files each one edits, and the cut was made where the file sets separate cleanly.

The four hot files that forced the shape of the cut:

| File | Findings landing on it |
|---|---|
| `src/cli/main.ts` | H1, H5, M2, M3, M14, M15, L8 |
| `src/gateway/proxy.ts` | H2, H4 |
| `src/gateway/server.ts` | H2, M8, M9, L13 |
| `src/config/load.ts` | H5, M10 |

`main.ts` + `config/load.ts` go one way; `proxy.ts` + `server.ts` go the other. Everything else
was assigned to whichever side kept its file set disjoint.

Consequence worth stating plainly: **Lane A has ~2.5x the item count, Lane B has the two hardest
items in the audit (H4, H2) and both security-policy decisions (M8, M9).** The lanes are
comparable in effort, not in row count. §6 defines a float pool for whichever finishes first.

## 2. Verified before assigning

Findings are data, not instructions, and this repo's own history records three audit
*reachability* claims that were measured wrong (DECISIONS §40, §42, §45). All five High findings
were re-checked against the current tree before being assigned. Result: **all five confirmed.**

| ID | Check run | Outcome |
|---|---|---|
| OX-H1 | `src/cli/main.ts:62-68` — exec branch is `runExecCommand(...).catch(...)` then `return 0`; `main()` assigns that 0 to `process.exitCode` | **Confirmed.** Child code is resolved and discarded. |
| OX-H2 | `src/gateway/proxy.ts:165` — `AbortSignal.timeout(30000)` is combined into the `fetch` signal, which governs the body stream, not just TTFB | **Confirmed.** |
| OX-H3 | glob for `vitest.config.*` / `vite.config.*` → none; `package.json:48` is a bare `vitest run`; `git worktree list` shows a live copy at `.claude/worktrees/sharp-nightingale-5af38c` (branch `claude/sharp-nightingale-5af38c` @ `33b2fec`, behind `main`) | **Confirmed.** |
| OX-H4 | `flattenMessageContent` (`proxy.ts:564`) sends non-strings through `JSON.stringify`, so `null` becomes the 4-char text `null`; `spliceIntoRawBody` (`proxy.ts:647`) then searches for `JSON.stringify("null")` — quoted — which is absent where the body holds bare `null` | **Confirmed, and it is all-or-nothing** — `spliceIntoRawBody` returns `undefined` on the *first* miss, and `forwardableBody` maps `undefined` back to the untouched `rawBody`. One tool-call turn zeroes the entire request's saving. |
| OX-H5 | `traceOutput` appears at 10 sites across `cli/main.ts`, `config/{load,schema,types}.ts`, `core/model/types.ts` — **every one is a write or a type declaration**; the trace is emitted by a literal `io.stderr.write(...)`. `'explain'` appears at 4 sites, all of them *accepting* the value; nothing branches on it | **Confirmed.** Both are dead knobs. |

Mediums and Lows were **not** individually re-verified. Each lane re-verifies its own before
fixing, and reports any that do not reproduce rather than fixing them silently.

## 3. Shared prerequisite — land this before either lane starts

**OX-H3 (vitest config) is not a Lane A item. It is a gate on both lanes.**

Until it lands, `npm test` in this tree also executes a stale duplicate suite from
`.claude/worktrees/sharp-nightingale-5af38c/test/**` — the audit measured 155 files / 1410 tests
against the repo's own ~77. Neither lane can trust a green run, and both lanes will run tests
constantly. It is also a root-level file (`vitest.config.ts`) that both lanes would otherwise race
to create.

Sequence: one commit on `main` adding `vitest.config.ts` with `include: ['test/**/*.test.ts']` and
an `exclude` covering `.claude`, `dist`, `node_modules`. Both lanes branch **after** it.

Optional and separate: the stale worktree itself can be removed
(`git worktree remove .claude/worktrees/sharp-nightingale-5af38c`) — but the config fix must land
regardless, because it protects every user with an agent worktree, and OX-M4 is the same problem
reached through `optimize .` rather than through vitest.

## 4. The lanes

### Lane A — CLI, config, engine, planner, bench runner, repo hygiene

**Owns these paths exclusively:**
`src/cli/**` · `src/gateway/exec.ts` · `src/config/**` · `src/core/engine/**` ·
`src/core/planner/**` · `src/core/topology/**` · `src/core/model/constructors.ts` ·
`src/bench/runner.ts` · `src/bench/evaluator.ts` · root `vitest.config.ts`, `.gitignore`,
`eslint.config.mjs`, `ARCHITECTURE.md`

| ID | Sev | Item | Primary file(s) | Notes |
|---|---|---|---|---|
| H1 | High | exec discards the child exit code | `cli/main.ts`, `gateway/exec.ts` | Needs the exec branch to await. Keep `exec.ts`'s documented `shell:true` / base-URL boundaries and the stop-on-close ordering untouched. |
| H5 | High | `--trace-output` and `--mode explain` are dead knobs | `cli/main.ts`, `config/{load,schema,types}.ts`, `core/model/types.ts`, README, CHANGELOG | **Decision required first — see §7.** Implement or withdraw; the H4 precedent (README:160-165) is withdrawal. |
| M2 | Med | `--diff` silently ignored on multi-file/directory runs | `cli/main.ts` | Render it, or reject it the way `rejectUnsupportedFlags` does. Do not leave it accepted-and-dropped. |
| M3 | Med | multi-file ignores `--input-name`; blanket-applies `--language` | `cli/main.ts` | The misroute is real: declaration outranks extension by design (`constructors.ts:154-157`), so `--language python` over a mixed dir mislabels every `.ts`/`.json`. |
| M4 | Med | directory walk does not skip `.claude` | `cli/ingest.ts:32` | Dot-directory-skip-by-default is the least surprising general rule. |
| M6 | Med | empty rehydration-candidate set means "rehydrate everything" | `core/engine/index.ts:526` | Make the intent explicit either way; today the code contradicts its own comment. |
| M7 | Med | debt ratio mixes pre- and post-elision baselines | `core/engine/index.ts:484` | The engine holds `request.bundle`; accumulate originals from it. |
| M10 | Med | `TOKENDAMPER_MINIMUM_CONFIDENCE` unvalidated | `config/load.ts:241` | Match the enum-error style already used for `TOKENDAMPER_*` (v1.6.0 made unrecognized enum values hard errors). |
| M11 | Med | ARCHITECTURE.md diagram drift | `ARCHITECTURE.md:21-28` | Document **both** real plan shapes: the knapsack list and the single-stage `session_dedup`. Drop "(TokenHasher)" from session-dedup. |
| M12 | Med | `bench/runner.ts` comment asserts a removed default | `bench/runner.ts:45-57` | Comment rot with teeth — it invites re-creating the fabricated-store defect. |
| M13 | Med | `--minimum-confidence` nearly inert | `core/validation/index.ts:230`, README | Document precisely, or grade the confidence. Documenting is the honest cheap option. |
| M14 | Med | dropped-files warning advises backwards | `cli/main.ts:337` | One-line wording fix. |
| M15 | Med | plain `bench` spawns Python by default | `bench/runner.ts:32`, `cli/main.ts:95` | **Decision required — see §7.** |
| M16 | Med | native-separator sort makes directory order platform-dependent | `cli/ingest.ts:59` | Order feeds prefix locking (invariants 6/7). Normalize, or state the limit. |
| L1 | Low | decorative planner fields (`expectedSavings` = 0.45, unused `_stageCatalog`) | `core/planner/index.ts` | |
| L2 | Low | `stableSerialize` collapses `undefined` to `'null'` | `core/model/constructors.ts:804` | Note-only unless hash provenance matters. |
| L3 | Low | language alias `'h'` to `'c'` | `core/model/constructors.ts:679` | |
| L4 | Low | symlinks silently skipped in the dir walk, followed when named | `cli/ingest.ts:60` | The inconsistency between the two routes is the finding. |
| L5 | Low | case-sensitive git path matching | `core/topology/{git-inspector,topology-scorer}.ts` | |
| L8 | Low | MCP shutdown flush race (`process.exit(0)` in SIGINT) | `cli/main.ts:49` | Couples to Lane B's L7 in spirit; the code is in `main.ts`, so it is Lane A's. |
| L11 | Low | naive extension extraction | `core/model/constructors.ts` | `ingest.extensionOf` already does this correctly — reuse it. |
| L12 | Low | version double-bookkeeping | `package.json` / `src/version.ts` | Read the `release` skill first; the single-version-source rule is deliberate. |
| L17 | Low | architecture import rules unpoliced | `eslint.config.mjs`, CI | Optional. Matches the repo's "make it a compile error" ethos. |
| L18 | Low | no coverage tooling | `vitest.config.ts` | Fold into the H3 config. |
| L19 | Low | `.gitignore` is Python-template noise | `.gitignore` | |

### Lane B — Gateway, session dedup, token hasher, MCP transport, bench fixtures

**Owns these paths exclusively:**
`src/gateway/{proxy,server,session-store,types}.ts` (**not** `exec.ts`) ·
`src/stages/cleanup/session-dedup.ts` · `src/stages/compression/token-hashing.ts` ·
`src/adapters/mcp/server.ts` · `src/bench/fixtures/loader.ts` · README Gateway sections

| ID | Sev | Item | Primary file(s) | Notes |
|---|---|---|---|---|
| H4 | High | `content: null` defeats the splice, zeroing per-request savings | `gateway/proxy.ts:564,647,705` | **Highest-value item in the audit.** Design the offset-anchor approach before touching code. Audit M7's rules bind: never re-serialize the payload; declining must remain the failure direction; the forward-cursor duplicate handling must survive the rewrite. |
| H2 | High | 30 s fetch timeout kills streaming bodies mid-generation | `gateway/proxy.ts:165`, `gateway/server.ts:232` | Split TTFB from body lifetime. Preserve the 504 `TimeoutError` mapping and abort-on-client-close (`server.ts:185-190`). Ship with a slow-stream integration test. |
| M1 | Med | first-turn intra-payload duplicates never elided; README overstates | `stages/cleanup/session-dedup.ts:92`, README:13-19 | Either relax the gate to intra-bundle `totalOccurrences > 1`, or correct the README. **DECISIONS §16/§41 sole-copy reasoning must survive, and `recoverable` must stay verifiable in-payload.** |
| M5 | Med | candidate-region markers pollute the TokenHasher store | `stages/compression/token-hashing.ts:436` | Split pricing from registration. **Marker bytes must stay byte-identical between pricing and emission** or ceiling adherence shifts — this is a corpus-measured change. |
| M8 | Med | non-loopback bind without a token is an open relay | `gateway/server.ts:130` | **Decision required — see §7.** Keep loopback trust (audit C3) and the constant-time compare. |
| M9 | Med | no CORS / OPTIONS / Origin handling | `gateway/server.ts:97` | **Decision required — see §7.** The custom-header split (browsers cannot set headers on simple requests) is the cleanest lever. |
| L6 | Low | `MAX_SEEN_BLOCK_HASHES = 1000` hardcoded among configurable neighbours | `gateway/session-store.ts:224`, `gateway/types.ts` | |
| L7 | Low | MCP buffer overflow discards buffered complete lines | `adapters/mcp/server.ts:54` | Drain line-by-line first, or say so in the error. |
| L9 | Low | dead `limits` merge with unsafe casts | `bench/fixtures/loader.ts:86` | `ResolvedConfig` has no `limits`; the branch cannot fire. Delete. |
| L10 | Low | substring dataset routing (`includes('humaneval')`) | `bench/fixtures/loader.ts:32` | Exact-name-first, substring last. |
| L13 | Low | `/health` exposes `sessionCount`; no rate limiting | `gateway/server.ts:101` | Fold into whatever M8/M9 decide. |

### Not assigned — no action

`L14` (the elision post-condition comment is correct as written and instructs its own
maintenance), `L15` (DriftTracker regex noise, an accepted tradeoff — any future tightening should
start from the Go block's anchoring discipline), `L16` (deep-freeze cost, fine at current scale),
`L20` (advisory: `repomix-output.xml` is a full-repo snapshot; do not commit or share it).

## 5. Working-tree protocol

**Each lane needs its own git worktree.** Not a style preference — the `measure-corpus` workflow
patches `dist/` and restores it, and both lanes hold items that require measurement (§8). Two
agents patching one `dist/` will silently measure each other's engine, which is precisely the
"compared an engine against itself" no-op the `measure-corpus` skill warns about.

- Branch both lanes off `main` **after** the H3 commit, not off `feat-go-region-elision`.
- `feat-go-region-elision` currently holds uncommitted Go step-3 work in this tree. It is
  in-flight and unrelated; commit or park it before starting Lane A here.

**Contended files and the rule for each:**

| File | Rule |
|---|---|
| `DECISIONS.md` | Last section is **§60**. Lane A claims **§61–§69**, Lane B claims **§71–§79**. Gaps get closed in the merge commit. This is purely collision avoidance. |
| `CHANGELOG.md` | Both append under `## [Unreleased]`. Trivial conflicts; whoever merges second resolves. |
| `README.md` | Lane A owns `## CLI Usage Guide`, `## Environment Variables Reference`, `## Visual Diff & Trace Flags`, `## What validation actually checks`. Lane B owns `## Overview & Features` (the savings table at :13-19) and the Gateway notice. Neither touches the other's sections. |
| `CLAUDE.md` | Neither lane edits it mid-flight. One reconciliation pass after both merge. |
| `vitest.config.ts` | Created by the shared H3 commit. Lane A extends it (L18); Lane B does not touch it. |

## 6. Float pool

Lane A carries more rows. If Lane B clears its table first, these are file-disjoint from Lane A's
active set and can be claimed by announcing the claim before the first edit: **L2, L3, L11**
(`core/model/constructors.ts`) and **L5** (`core/topology/**`). Nothing else floats — every other
Lane A item shares a file with another Lane A item.

## 7. Decisions needed from the user before code

Four items should not be implemented on an agent's own judgement:

1. **H5 — implement the dead knobs, or withdraw them?** The precedent in this repo is withdrawal
   (audit H4 removed `--max-output-tokens`, `--max-latency-ms` and `--risk-tolerance` for exactly
   this defect). Withdrawal is cheap and honest; implementing `--trace-output` is also cheap;
   implementing `explain` is a feature, not a fix.
2. **M8 — what should a non-loopback bind with no token do?** Refuse to start, warn loudly, or
   auto-generate and print a token. All three are defensible; they differ in whether an existing
   working config breaks.
3. **M9 — how much CORS/Origin policy does a localhost tool want?** Requiring the token header
   even on loopback cleanly splits browsers from local clients, but changes the local client
   contract.
4. **M15 — should plain `tokendamper bench` execute dataset code through `python`?** Flipping the
   default to off contradicts nothing, but it changes what `bench` reports out of the box.

## 8. Items that require corpus measurement, not just tests

Per CLAUDE.md's standing rule and the `measure-corpus` skill: freeze the corpus, pin the commit
and hashes, vary only `dist/`, and compare **per-row**, never the mean. A falling aggregate in
this repo has been a non-regression four separate times.

- **Lane A:** M3 (changes classification), M4 (changes what is ingested), M6 and M7 (change engine
  output and debt-driven rehydration), H5 if implemented.
- **Lane B:** M1 (changes Gateway output), M5 (must prove marker bytes unchanged and ceiling
  adherence unmoved).

The rest are exit codes, wiring, docs, comments and dead code — tests are sufficient.

Two traps the skill records, restated because both have happened here: a failed build leaves the
previous `dist/` in place, so an engine gets compared against itself; and **byte-identical is not
the same as inert** — the corpus may simply not contain the shape being fixed (DECISIONS §56, and
L7's blank-line case, where a real gain moved 0 of 576 rows).

## 9. Convention both lanes follow

From the audit's §6 and the repo's own practice: **each fix lands with the test that would have
caught it.** The audit already names the missing ones — exec exit-code propagation, a >30 s
upstream, a splice test with `content: null` messages, multi-file `--diff` / `--input-name`
assertions, and a turn-1 intra-payload duplicate pair. `test/unit/fallback-render.test.ts` is the
model for pinning a behavior loudly rather than fixing it.
