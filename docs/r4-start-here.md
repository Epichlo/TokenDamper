# R4 — start here

**A pointer document, deliberately short.** The design is already written and this does not repeat
it. What this adds is the state R4 begins from, the things that do **not** survive a session, and
the traps specific to widening the language list through the seam R3 built.

**Delete this file when R4 lands**, and set the prose bucket's `expect` back to 21 in the same
commit — this file counts itself, exactly as `docs/r3-start-here.md` did.

---

## Read first, in this order

1. **`docs/superpowers/specs/2026-09-09-tokendamper-v2-roadmap-design.md` §3.6, §3.7 and §3.8** —
   packaging, how languages are chosen, and the two extension lists. §3.7 is the binding one and
   it is not advisory.
2. **DECISIONS §81** — what R3 measured, and the two findings that change what R4 can assume.
   Read the "What this does not establish" list before planning anything.
3. **DECISIONS §75** — why Deep is a *coverage* feature and not a precision one. Do not re-derive;
   the two obvious alternatives were rejected with figures.
4. **`.claude/skills/widen-language`** and **`.claude/skills/measure-corpus`**. The first encodes
   the per-language order, which §56 measured as a safety property rather than a preference. The
   second is not optional — R4's deliverable is numbers.

## State as of 2026-09-24

| | |
|---|---|
| `main` | the v1.8.0 release merge, tagged `v1.8.0` (R3 step 3 was `e23c997`, PR #73) |
| npm `latest` | **1.8.0** once the user publishes it (2FA), **1.7.4** until then — check `npm view tokendamper version`. 1.7.3 is published-but-deprecated; see CLAUDE.md |
| R1 / R2 / R3 | all closed — §73–§74, §76–§78, §79–§81; R2 and R3 cut together as **v1.8.0** |
| suite | 1044 passing / 2 skipped |
| languages that reduce | **three** — TypeScript, Python, Go |
| `--engine-mode` | `fast\|deep`, on `optimize` only |

## The two R3 findings that constrain R4

**1. Deep's validator cannot be combined with elision.** The elision marker
(`[TokenDamper: N … lines elided, N bytes, sha256:…]`) spliced into a function body is not valid
syntax in any language tree-sitter parses, so `validationMode` defaults to `fast` and deep
validation is reachable only through the API. Adding a language does **not** change this. If R4
wants deep validation live, the marker has to be rendered validly per language first — which
moves emitted bytes on the *fast* path too, so every reduction figure in the project moves and it
needs its own release with its own measurement. §81 has the numbers.

**2. A grammar is not enough to reach a language.** This is the trap most likely to cost a day.
`selectValidator` resolves a language through the **Fast** chain and then looks a backend up by
*that* name. JavaScript has a tree-sitter grammar in `packages/deep`, it is built, and it is
**unreachable** — because no Fast validator ever returns the language `javascript` (a `.js` file
resolves to the TypeScript validator, whose `language` is `typescript`). So for every new
language, the Fast chain must resolve its name before a backend can ever be found. Registering a
backend under an unreachable key puts an entry in `registeredParserLanguages()` that nothing can
use, which reads as coverage.

## What does **not** survive a session, and must be rebuilt first

- **The frozen corpus.** Re-run `collect.js`. *(Frozen 2026-09-23 at `268898d`: 297 files. The
  recipe now excludes `.superpowers` — agent scratch had taken 19 of 40 prose slots, the `.agents`
  lesson repeating — and the typescript bucket is `expect 67, limit 80`, because for the first time
  the limit **bound** and was silently dropping files instead of refusing.)* Expect a refusal if
  `src/` has gained a file since; that refusal is the harness working, and the convention is to
  update `expect` **and** name the file that moved it in `recipe.json`'s `$comment`.
- **The timing baseline.** Re-run `timing-run.js`. *(Re-baselined 2026-09-23 on this machine, fast
  arm: cold engine p50 **137.8ms**, warm **2.2ms**, ratio **63.24x**, CLI wall p50 248.0ms, fixed
  per-process 109.8ms.)* §76's published 159.1/3.8/41.48x are machine-specific and did not
  reproduce; neither will these. Re-baseline before comparing anything.
- **The 80-file Go corpus.** Still at the path the `go-corpus-location` memory records, verified
  2026-09-23. **Do not re-freeze it with `collect.js`** — its filenames are already flattened and
  re-flattening blows past the Windows path limit, failing with an `ENOENT` that does not look
  like a path-length error. Generate a manifest in place instead: walk for `*.go`, hash, bucket by
  whether the path contains `gostdlib`, and write `{corpusPath, bucket, bytes, sha256}` plus an
  `engine` block. Say when quoting it that this is weaker provenance than a `collect.js` pin.
- **The 8,251-file Go tree** at `…/Temp/tdc/go` was present on 2026-09-23. It is volume, not a
  pinned corpus.

## How R4 picks languages — the part that is not negotiable

§3.7 is the template and §56 is the precedent. Per candidate, before committing to a grammar:

1. Measure the **elidable ceiling** — share of bytes inside body nodes clearing
   `MIN_REGION_BYTES` (104) and `isSubstantiveRegion`.
2. **On at least two independent corpora.** Go read 65.36% on application code and 54.78% on the
   stdlib, and averaging them would have overstated it by ten points: 21.7% of stdlib bytes sit in
   files with no elidable region, mostly generated tables.
3. Ship only what clears a floor, **with its own measured fallback rate** — never one borrowed
   from another language. §56 projected Go by borrowing TypeScript's conversion factor; it
   happened to land, and the status doc records it as not established anyway.

Reference points: TypeScript 57.78% ceiling → **24.56%** achieved at 0.3; Go app 65.36% →
**27.46%**; Go stdlib 54.78% → **19.42%**; Python (pip) 46.88% → **22.73%**.

Candidates, unranked until measured: Rust, Java, C#, C++, Ruby, PHP, Kotlin, Swift, C.

**Measure test files separately, for every candidate.** Nothing in this project has ever counted
them and they look like the larger prize: `_test.go` is 53 MB against 36 MB of source in the Go app
corpus, at **92.22%** elidable, measuring **26.88%** against source's 14.42%.

## Traps specific to R4

- **Two extension lists, deliberately separate** (§3.8). `isCodeExtension` in
  `src/core/model/constructors.ts` is a *classification* rule; `REGION_ELISION_LANGUAGES` in
  `src/core/elision/regions.ts` is an *elision* gate. A language needs the right entry in each,
  and they answer different questions — do not collapse them.
- **`extractSymbols` first, then the validator, then regions.** §56 measured that scanner-first
  produces *silent unmeasured elision* rather than the visible zero the docs promise, because a
  struct or import manufactures a symbol that body elision cannot destroy. The `widen-language`
  skill encodes the order.
- **Deep still subdivides with the Fast statement splitter.** `splitRegionIntoStatements` accepts
  `SelectRegionsOptions` (which carries `mode`) and ignores it, so the ceiling path is Fast-driven
  even under `--engine-mode deep`. There is a note at the site. If R4 wires subdivision to the
  backend, change that line and §81's "does not establish" together.
- **`--mode deep` is not the flag.** It is `--engine-mode deep`, on `optimize` only. `--mode`
  still carries `optimize|bench` until 2.0 withdraws those values. `bench` deliberately does not
  accept `--engine-mode`, because its runner does not read the mode — add it back to the `bench`
  set in the same change that threads `engineMode` into `BenchmarkRunnerConfig`, not before.
- **Discovery must fail loudly.** `--engine-mode deep` with no loadable backend is a hard error
  naming the build/install command, never a silent downgrade to Fast. R4 publishes the package, so
  the bare `require('tokendamper-deep')` path starts mattering; the repo-relative fallback exists
  because the package is unpublished today.
- **Core's tarball must not grow.** It went 508 → 223 entries in v1.7.2 and a companion package is
  what protects that. `published-package-scope.test.ts` extends to both tarballs; check
  `npm pack --dry-run` and confirm `packages/` never appears in core's.
- **Do not compare aggregates across the denominator change.** The typescript bucket went 63 → 67
  files in R3. Per-row over one frozen corpus is still comparable; means are not.
- **A fallback that rose is not automatically a regression, and the reverse is also true.** R3's
  five new fallbacks were the constraint gate refusing regions Deep found and Fast missed. Attribute
  before concluding — `deep-regions.js` splits region- from validator-attributable rows, and §81
  records why both gate at zero under the current configuration.

## Small things R3's reviews deferred, if you are in the area

- `regionsFromTree`'s language switch has a silent `default: return []` with no exhaustiveness
  guard. Unreachable today because `WASM_SPECIFIERS` is a `Record<DeepLanguage, string>` and fails
  to compile without a new key — but **R4 is exactly the release that adds a fifth language**, and
  the failure mode if it is missed is `backendAnswered > 0` with zero regions. Three lines.
- `ParserCoverage`'s doc comment and `LanguageSupportReport`'s both call themselves "the third"
  member of the coverage family.
- Trace sites A and B recompute `parserCoverage(currentBundle, …)` while site C carries forward
  `validation.parserCoverage`. Their equivalence rests on `currentBundle` only ever being
  reassigned in lockstep with `validation` — true by inspection, untested.

## What R4 is not

Not a precision feature. Not a reason to revisit §46's refusal to wire `ts.createSourceFile` — the
Fast path's advertised claim stays bracket/quote integrity, and
`test/unit/validator-guarantee.test.ts`, which asserts that English prose *passes* the TypeScript
validator, stays exactly as written. If Deep's guarantee is ever advertised, that test, the README
table and CLAUDE.md's opening paragraph change in one commit.
