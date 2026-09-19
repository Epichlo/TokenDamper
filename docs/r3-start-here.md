# R3 — start here

**A pointer document, deliberately short.** The design is already written and this does not repeat
it. What this adds is the state R3 begins from, the things that do **not** survive a session, and
the traps that are specific to measuring a second parser backend.

**Delete this file when R3 lands.** Audit M11 retired twelve narrative documents whose conclusions
already lived in `DECISIONS.md`; this one is written to be absorbed the same way rather than to
accumulate.

---

## Read first, in this order

1. **`docs/superpowers/specs/2026-09-09-tokendamper-v2-roadmap-design.md` §3.4 and §3.5** — the
   seam and the staged negative control. §3.5's table is the spec for what each step must assert.
2. **DECISIONS §75** — why Deep is a *coverage* feature and not a precision one, and the two
   payoffs already rejected on measurement. Do not re-derive these; they were rejected with figures.
3. **DECISIONS §76** — the latency baseline R3 reports against, and why it is three numbers.
4. **`.claude/skills/measure-corpus`** and **`.claude/skills/widen-language`** — the loops. R3 is
   measurement work, so the first one is not optional.

## State as of 2026-09-19

| | |
|---|---|
| `main` | `22f6db9` |
| npm `latest` | **1.7.4** (1.7.3 is published-but-deprecated; see CLAUDE.md) |
| R1 | done — the backlog reached the registry |
| R2 | done — §76 harness, §77 Axis A, §78 Axis B closed on measurement |
| R3 | **step 1 of three done** (DECISIONS §79). Seam + `packages/deep` `symbols()`. Steps 2 and 3 open |
| suite | 986 passing / 2 skipped across 102 files |

## What does **not** survive, and must be rebuilt first

All three lived in session-scoped temp directories and are gone:

- **The frozen corpus.** Re-run `collect.js`. *(Rebuilt 2026-09-19 at `849f8c7`, 293 files, dist `dc4465c6ec49`; `recipe.json` prose `expect` went 21 -> 22 for `docs/r3-start-here.md` itself, and goes back to 21 when this file is deleted.)* Expect the recipe to refuse if this repository has
  gained a `src/*.ts` or a root/`docs` `*.md` since 2026-09-19 — that refusal is the harness
  working, and the convention is to update `expect` *and* name the file that moved it in
  `recipe.json`'s `$comment`.
- **The timing baseline.** Re-run `timing-run.js`. *(Re-baselined 2026-09-19 on this machine: cold p50 **114.0ms**, warm p50 **3.3ms**, ratio **34.49x**, parity 293/293. §76’s 159.1/3.8/41.48x did not reproduce and was not expected to.)* **§76's numbers are machine-specific** —
  win32-x64, Node v26.4.0, one run, no repeated trials. Re-baseline on the machine before comparing
  anything to them.
- **The Go corpus. Checked 2026-09-19 and it is still there** — 80 files, `gosrc` + `gostdlib`,
  at the path the `go-corpus-location` memory records. Step 1 used it. Its filenames are already
  flattened, so **do not re-freeze it with `collect.js`**; generate a manifest in place instead
  (walk for `*.go`, hash, bucket by whether the path contains `gostdlib`). The main
  `recipe.json` still has **no Go bucket and no JS bucket**, so JavaScript remains unmeasured.

## Where step 1 left off (2026-09-19)

Read **DECISIONS §79** first; this is the two-line version.

- **Done:** `src/core/parser/{types,registry}.ts`; `selectValidator(item, mode)` with `fast`
  never reading the registry; `packages/deep/` (`tokendamper-deep`, private, its own tsconfig,
  owns the tree-sitter dependency); `symbols()` for ts/js/python/go; `ARCHITECTURE.md`’s
  per-configuration determinism sentence. 586/586 corpus rows byte-identical.
- **`check()` and `regions()` throw.** That is deliberate — `valid: true` and `[]` are both
  indistinguishable from a backend that examined nothing. Step 2 replaces the first, step 3
  the second.
- **Step 1’s assertion was rewritten against evidence.** "`S_k` must not fall" fails on 9 of
  75 files; every one is Deep declining to harvest a phantom the shipped regexes took from
  English in a comment. The criterion that holds is *a symbol Deep **has**, that Fast saw
  destroyed and Deep retained* — measured 0. `tools/corpus-harness/deep-drift-control.js`.
- **Open, in order:** step 1 on JavaScript (no corpus exists); step 2
  (`check()`, >=5,000 files per language, every disagreement read, plus §60’s inverse
  control per language); step 3 (`regions()` behind `--mode deep`, which does not exist yet).
- **One question step 1 opened and did not answer:** part of the shipped drift signal on code
  is phantom symbols from comment prose. If Deep’s symbols ever feed the live gate, drift on
  code falls toward zero and the gate stops discriminating. Decide that before wiring it.

## Traps specific to R3

- **Step 3's assertion is not byte-identity, and steps 1–2 are.** A parser legitimately finds
  better regions than a lexer, so demanding identity at step 3 forbids the feature. §3.5 says what
  step 3 asserts instead. Getting this backwards either blocks the work or launders a regression.
- **`topology-pruner` is 97% of cold engine time** (§76), all of it `git status`. A parser's cost is
  invisible against it at the CLI. Compare **warm** engine time or per-stage figures, or a real
  15ms parse will look like noise.
- **cold models the CLI, warm models the Gateway and MCP**, and the gap is **41x**. Say which one
  any Deep latency claim means. §76 exists because the roadmap's old `<1ms` target never did.
- **`web-tree-sitter` init is per-process and unmeasured.** It lands in `fixed` (151.4ms at the CLI
  today). §75 flags this as a plausible reason Deep is unusable at the CLI while fine at the
  Gateway — measure it in R3, before R4 commits to packaging.
- **A validator that examines nothing also reports 0 findings.** §60 ran an inverse control for
  exactly this — delete the last column-0 `}` and confirm the validator *catches* it. Repeat it per
  language; a clean disagreement rate is not evidence on its own.
- **`extractSymbols` first, then the validator, then regions.** §56 measured that scanner-first
  produces *silent unmeasured elision* rather than a visible zero, because a struct or import
  manufactures a symbol that body elision cannot destroy. The `widen-language` skill encodes this.

## What R3 is not

No new language, no new grammar, **no reduction change**. The deliverable is a measurement
showing a second backend reproduces the shipped one on languages that can still be hand-checked
— which is the whole reason R3 precedes R4.

**Two clauses of the original wording were resolved rather than kept, and DECISIONS §79 records
both.** *"No new dependency"* now means no new dependency **in core**: `web-tree-sitter` and the
four grammars belong to `packages/deep/`, core’s `devDependencies` are unchanged, and the
tarball is verified clean. Taken literally it could not be satisfied at all — the only second
backend needing no new dependency is one wrapping the shipped lexers, which agrees with itself
by construction and is the vacuous control §60 warns about. And *"the companion package does not
exist yet"* is now false by one directory: `packages/deep/` exists, unpublished, so R4
*publishes* it rather than inventing it.
