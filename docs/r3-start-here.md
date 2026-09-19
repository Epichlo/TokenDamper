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
| R3 | **not started.** `src/core/parser/` does not exist |
| suite | 962 passing / 2 skipped across 100 files |

## What does **not** survive, and must be rebuilt first

All three lived in session-scoped temp directories and are gone:

- **The frozen corpus.** Re-run `collect.js`. Expect the recipe to refuse if this repository has
  gained a `src/*.ts` or a root/`docs` `*.md` since 2026-09-19 — that refusal is the harness
  working, and the convention is to update `expect` *and* name the file that moved it in
  `recipe.json`'s `$comment`.
- **The timing baseline.** Re-run `timing-run.js`. **§76's numbers are machine-specific** —
  win32-x64, Node v26.4.0, one run, no repeated trials. Re-baseline on the machine before comparing
  anything to them.
- **The Go corpus.** §60/§61/§77 used an 80-file tree that was already flattened by an earlier
  freeze. If it is gone, re-source it; the main `recipe.json` has **no Go bucket**, which is why
  §77 measured Go separately.

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

No new dependency, no new language, no new grammar, **no reduction change**. The companion package
does not exist yet. The deliverable is a measurement showing a second backend reproduces the
shipped one on languages that can still be hand-checked — which is the whole reason R3 precedes R4.
