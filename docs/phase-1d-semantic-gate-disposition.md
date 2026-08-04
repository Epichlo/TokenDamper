# Phase 1d — The Semantic Gate: Disposition of Precondition (a)

> **Status:** investigation complete, **nothing implemented**. This document disposes of
> `docs/phase-1d-granularity-design.md` §8 precondition **(a)** — "make `R_struct` do work for
> code" — and of the same open item recorded as `DECISIONS.md` §18.
>
> **Recommendation in one line:** (a) as written is the wrong shape and the measurement says
> so; ship two narrow changes (a coverage fix and a *trim*, not a refusal), close Phase 1 with
> the hole documented, and take the real semantic term as its own phase — knowing that no
> zero-dependency term measures meaning.
>
> Measured 2026-08-04 against `dist/` at `a12e411`.

---

## 1. Method, and why it is stated first

This repository is its own corpus, and a previous session read its own edits as behavioural
movement. So:

- **Corpus A (this repo), frozen.** 68 files — 64 `src/**/*.ts` plus the 4 tracked `*.py` —
  copied to a scratch directory at commit `a12e411`, with a `sha256sum` manifest
  (`e1d1b4e80b0bee23…`). Every run below reads the copy, never the working tree.
- **Corpus B (external), frozen.** 39 Python files from `pip` 25.0.1 in `.venv`
  (`pip/_internal` and `pip/_vendor`, 2–40 KB, sorted, every 7th). Corpus A is ~94%
  TypeScript, which is not a neutral sample for anything that depends on where a language puts
  its documentation. Corpus B is real, heavily documented Python written by people who never
  heard of this project.
- **Only the engine varies.** Counterfactuals are applied by patching the **compiled**
  `dist/src/core/elision/regions.js` and restored afterwards by checksum
  (`7c792196462ed86d…` before and after). The input bytes are identical across all runs.
- **Every figure is from the real CLI**, `optimize <file> --target-reduction-ratio 0.3`, one
  process per file.
- **Regions are recovered from the emitted output, not from an instrumented build.** The
  marker carries its own byte count and hash, so the reconstruction is verified: for every one
  of the 105 (A) and 124 (B) markers, the recovered span re-hashes to the digest in the marker
  and the surrounding text matches the original byte-for-byte. **229/229 verified.** A silent
  mis-alignment cannot pass.
- **Determinism re-checked.** The Corpus A sweep, re-run in fresh processes, produces a
  byte-identical result file.

Cross-check on the harness itself: an in-process run through `core/engine.optimize()`
reproduces the CLI's fallback set exactly (37/68 on A), which is how the fallback *reasons*
below were obtained — the CLI trace does not carry them.

## 2. How widespread the docstring case is

**Baseline, Corpus A:** 29 files reduce with no fallback, mean token reduction **48.62%**
(mean byte reduction 45.79%). 105 markers: **100 function-body regions + 5 whole-item
elisions**. 37 files fall back.

**Baseline, Corpus B:** 20 files reduce, mean **39.69%**, 124 markers (123 regions + 1
whole-item). 19 fall back.

Regions whose removed span **begins with** a docstring or comment block:

| | Corpus A (repo, 94% TS) | Corpus B (pip, Python) |
|---|---|---|
| regions leading with a doc block | **14 / 105 (13%)** | **75 / 124 (60.5%)** |
| — Python docstrings | 13 | 75 |
| — TS leading comments | 1 | 0 |
| reducing files affected | **2 / 29 (7%)** | **19 / 20 (95%)** |
| doc-block bytes / elided bytes | 1,466 / 80,715 (1.8%) | 10,324 / 73,487 (14.0%) |

The asymmetry is structural, not a sampling accident. TypeScript puts its JSDoc **above** the
function header, which is outside the brace span `scanBraceSpans` selects, so the doc survives
by construction. Python's docstring is the **first statement inside the body**, which is
exactly where `scanPythonDefBodies` starts the region. Corpus A understates the problem by
roughly an order of magnitude because of what language it is written in.

### What it costs to exclude them

Two rules were implemented in the compiled engine and measured, both paired against the same
frozen bytes:

- **trim** — advance the region start past a leading comment/docstring run to the first
  executable character, then re-apply the size and substantiveness filters. The doc stays in
  the output; the body below it is still elided.
- **refuse** — drop any region that begins with a doc block, as `selectElisionRegions`
  currently drops a doc-*only* region.

| | baseline | trim | refuse |
|---|---|---|---|
| **A** mean over the 29 files that reduce in all three | 48.62% | **48.17%** (−0.45pp) | 46.92% (−1.70pp) |
| **A** total tokens emitted over all 68 files | 102,800 | 103,244 (+0.43%) | 104,693 (+1.84%) |
| **A** `codebase.py` | 34.18% | 28.30% | **4.63%** |
| **A** `token-hasher.ts` | 45.87% | 38.68% | 26.09% |
| **B** mean over the 17 files that reduce in all three | 45.51% | **38.73%** (−6.78pp) | 23.76% (−21.75pp) |
| **B** total tokens emitted over all 39 files | 120,291 | **115,093 (−4.32%)** | 125,705 (+4.50%) |
| **B** files falling back | 19 | 12 | 11 |

Read the two "total tokens emitted" rows before the means. **On real Python, trimming
docstrings out of the elided region makes the pipeline emit 4.3% fewer tokens overall than
eliding them.** Per surviving file it saves less, but it converts **7 fallbacks into
reductions**, and a fallback emits the entire input.

The mechanism is measurable, not inferred. Fallback causes on Corpus B: **17 of 19 are
`Imperative constraint directive dropped`**, 1 drift, 1 AST — and the dropped directives are
docstring and comment sentences: `"If in a virtualenv…"`, `"Always return False…"`,
`"The digests must be…"`, `"# Do not trust on…"`. On Corpus A: 20 constraint-directive, 14
drift, 3 AST. **On Python it is `cleanup:constraint-preservation`, not `DriftTracker`, that is
currently doing the work of noticing that documentation was destroyed** — and it notices only
when the prose happens to be phrased as an imperative. "Returns the number of open files"
passes; "Return the number of open files" does not.

This also means the naive comparison is a trap: `refuse` shows 28 reducing files against the
baseline's 20 and a mean of 19.33% against 39.69%, which is three different denominators. Only
the paired rows and the totals are comparable.

## 3. Whether the cheap fix suffices

**No. It closes one instance of three, and the two it does not close are the larger ones.**

First, a correction to the premise this task was scoped from. `HumanEval/0` **is already
caught** — the guard shipped with the granularity change:

```
$ node dist/src/cli/main.js optimize humaneval0.py --target-reduction-ratio 0.3
from typing import List


def has_close_elements(numbers: List[float], threshold: float) -> bool:
    """ Check if in given list of numbers, any two numbers are closer to each other than
    …
    """
--- tokenBefore=106 tokenAfter=106 fallbackUsed=true driftScore=0.6

regions selected: []
isSubstantiveRegion(docstring-only body): false
```

`isSubstantiveRegion` refuses the region, the item falls through to the whole-item path, `S_k`
pins at 0.60, and the input is echoed. The 55.66%-at-`S_k`-0.0000 measurement describes the
pre-`e25b457` engine. **The specific case is closed; the class is open, and its live instances
have nothing to do with docstrings.**

### (i) Comments that are not leading — 14 of 29 files (A), 9 of 20 (B)

19 regions on A and 15 on B remove comment bytes while *not* beginning with a comment. A
leading-block rule protects none of them. On Corpus A these are precisely the load-bearing
ones — the fallback reasons name them: `"// Rule 1: Never hash…"`, `"// DO NOT widen th…"`,
`"* A validator neve…"`. They are caught today only when they read as imperatives, by the
constraint checker, and a fallback is all-or-nothing.

### (ii) Whole-item elision of a file the metric cannot see — 5 of 29 reducers (A)

```
$ node dist/src/cli/main.js optimize corpus/src/index.ts --target-reduction-ratio 0.3
[TokenDamper: 14 code lines elided, 420 bytes, sha256:10a4b0eb949b]
--- tokenBefore=130 tokenAfter=18 fallbackUsed=false driftScore=0 astCoverage={"checked":1,"unchecked":0}
```

The package's entire public API surface, deleted, **86.15% reduction at `S_k = 0.0000`**, AST
coverage reporting a clean check. This is not a docstring and no region rule touches it.

The cause is a **defaulted metric**, and it is the ninth instance of the invariant-10 pattern
(`src/core/ledger/drift-tracker.ts`):

```ts
let astSymbolRetentionRatio = 1.0;
if (symbolsBefore.size > 0) { … }        // otherwise the 1.0 stands
```

`extractSymbols` matches `import … from '…'` but not `export * from '…'`, so a barrel file
yields the empty set — and an empty *before* set is scored as **perfect retention** rather
than as *nothing measured*. Five files on Corpus A (`src/index.ts`, `src/bench/index.ts`,
`src/bench/fixtures/index.ts`, `src/core/ledger/index.ts`, `src/config/index.ts`) are elided
whole at `S_k = 0.0000` for this reason. `R_struct` cannot object: its marker set on all 29
reducing files is exactly `{filepath:…}` — §18 confirmed on this corpus.

The same default governs non-code. `README.md` → 0 symbols, `SECURITY.md` → 0,
`sample_logs.txt` → 0 symbols **and** 1 marker (`filepath:`). So the `logs:WHOLE passed=true
S_k=0.00 saved=97.5%` result in `DECISIONS.md` §24 is a **doubly-vacuous pass** — neither term
examined anything. That does not make §24's conclusion wrong (its rejection of a static
content-type gate stands, and the bytes saved are real), but "passed at `S_k = 0.00`" carries
no safety information there and should stop being cited as if it did. Markdown is the
exception: it has real markers (README: 20 headings/fences), so `R_struct` genuinely does work
on it.

### (iii) Function bodies whose loss is free by construction

For every recovered region, run the real `extractSymbols` over the removed span alone:

| | Corpus A | Corpus B (Python) |
|---|---|---|
| function-body regions | 100 | 123 |
| contributing **zero** symbols | **42 (42.0%)** | **106 (86.2%)** |
| bytes removed by those regions | 15,562 / 79,901 (19.5%) | 39,673 / 63,278 (**62.7%**) |
| median symbols per region | 1 | **0** |

On real Python, five sixths of the regions this engine removes are **invisible to `R_AST`
before the metric is even computed**, and they account for nearly two thirds of the deleted
bytes. The median region moves the metric by nothing at all.

The exemplar is this project's own safety guarantee:

```
export function resolveFallback(request, validation, currentBundle): FallbackOutcome {[TokenDamper: 14 function-body lines elided, 263 bytes, sha256:98777770f6bd]}
--- tokenBefore=211 tokenAfter=150 fallbackUsed=false driftScore=0
```

The body deleted is the `shouldFallback` branch — the implementation of invariant 3. No
docstring, no comment, `S_k = 0.0000`. `R_AST` scores it perfect because the function *name*
survived, which is precisely what the region selector was designed to guarantee.

**That is the structural statement of the problem.** The selector keeps signatures *so that
the gate will pass*. The gate scores signatures. A rule engineered to preserve exactly what
the check measures cannot be checked by it. Excluding docstrings narrows the selector; it does
not restore the check.

## 4. Whether a real semantic term is warranted — and what it could measure

### §18's proposed markers are, measured, the wrong shape

§18 names the remedy as teaching `extractMarkers` "nesting depth, function and class
boundaries, import blocks, brace balance". Each was computed on the original and on the **real
CLI output** of every reducing file:

| proposed marker | differs before/after (A) | differs before/after (B) |
|---|---|---|
| brace balance | 1 / 29 | 0 / 20 |
| paren balance | 0 / 29 | 1 / 20 |
| function headers | 0 / 29 | 2 / 20 |
| class headers | 0 / 29 | 0 / 20 |
| import lines | 0 / 29 | 2 / 20 |
| max nesting depth | 20 / 29 | 13 / 20 |
| comment starts | **14 / 29** | **14 / 20** |
| docstring delimiters | 1 / 29 | **17 / 20** |

Four of §18's five candidates are **near-constants under the shipped selector, for the same
reason `R_struct` already is**: the selector preserves balance and signatures by construction.
Adding them would replace one decorative constant with four. Nesting depth does vary — but it
varies on *every* successful body elision, which makes it a compression detector wearing a
loss detector's name; as a retention term it would penalise the transform for having worked.

The only markers that actually move are **comments and docstrings**. So §18's own remedy,
followed honestly to its measurement, arrives at the same content class as the "cheap fix".
(a) and (b) are not "the real fix" versus "the stopgap" — **(a), done zero-dependency, is the
scored version of (b)**: it grades partial documentation loss and it also covers the
whole-item path, where a region rule does nothing.

**Disposition of (a): reject as worded, retain the intent.** A term named "structural
integrity" that is computed from comment density would be a lie in the metric's own
vocabulary; if this is built, it belongs beside `R_AST` as an explicit information-class
retention term, not smuggled into `R_struct`.

### Be skeptical of the term itself

I am not proposing an embedding or a model call, and not because of cost. `DECISIONS.md` §9
already settled it, and it is the product's whole differentiator: an embedding makes the gate
non-deterministic across versions, unauditable in the trace, and dependent on a network or a
several-hundred-megabyte artifact in a tool whose pitch is a deterministic local proxy. A
gate that cannot explain in one line why it refused is worse than no gate. **If the honest
conclusion is that meaning is not measurable here, the honest output is a refusal to certify,
not a heuristic that scores something adjacent and calls it semantics.**

And that is the conclusion. Every zero-dependency candidate measures a **proxy for
information class** — is this a symbol, a comment, a literal, a heading — never information
*content*. Such a metric can say "you deleted 40% of the documentation and 3 of 11 symbols".
It cannot say whether the 263 bytes removed from `resolveFallback` mattered more than the 263
bytes of a getter. Anyone who reads the next iteration of this metric as measuring semantic
value will be making the same mistake this phase has now catalogued nine times.

## 5. What to do, and where it belongs

**Close Phase 1 with the hole documented and two narrow changes. Take the term itself as its
own phase, if at all.**

Recommended, in this order, each its own commit and each reproducible from the frozen corpora:

1. **Stop defaulting `R_AST` and `R_struct` to 1.0 when the *before* side is empty.** This is
   the invariant-10 instance, it is cheap, and it is the only one of these changes that is
   about correctness rather than policy. Follow §23's precedent exactly: report that nothing
   was measured (`measured: false` on `DriftReport`, surfaced on the trace) rather than
   silently reporting perfect retention. Whether an unmeasurable drift on a *changed* item
   should refuse is a policy decision that should be made explicitly and separately —
   inverting it without deciding would fall the engine back on all prose.
2. **Trim leading doc blocks out of the region; do not refuse the region.** Measured cost
   −0.45pp on A and −6.78pp per surviving file on B, against **−4.3% total emitted tokens on
   B** because it converts 7 fallbacks. `refuse` costs 4× more and is strictly worse on both
   corpora — it takes `codebase.py` from 34.18% to 4.63%.
3. **Record the residue as a known limitation, in `DECISIONS.md`, with the §3 numbers.** After
   1 and 2, an elided function body with no local declarations still scores `S_k = 0.0000`;
   86% of Python regions are in that class. Phase 1 should close saying so.

Not in Phase 1, and not obviously worth doing at all: a comment/docstring **retention term**
beside `R_AST`. It is the only candidate the measurement supports, it would grade what items 2
and 3 currently veto or ignore, and it needs its own weights derived from measurement rather
than inherited — which is a phase, not a change.

One thing that should **not** happen under any of this: tuning the `0.40` threshold. Nothing
in this investigation moves the argument in §18 that a threshold cannot recover discriminating
power from terms that do not vary.

## 6. Reproduction

Five scratchpad probes against `dist/` at `a12e411`; none are repo code. The frozen corpora,
the manifest, the patcher and the probes are in the session scratchpad.

1. `sweep.js` — CLI sweep + region recovery, verified against the marker's own hash.
2. `analyze.js` — leading-doc and comment/string byte attribution per region; cross-checked
   against the shipped `isSubstantiveRegion` on every region (229/229 agree).
3. `patch.js trim|refuse|restore` — the counterfactual engines, applied to compiled output and
   restored by checksum.
4. `symbols.js` / inline probe — `extractSymbols` and `extractMarkers` per file and per region.
5. `structprobe.js` — §18's proposed markers computed on original vs. real CLI output.

Corrections this investigation made to its own first answers, recorded because each was
wrong before it was right: the first region reconstruction verified against a plain
`sha256(text)` and failed all 29 files, because `hashContent` serializes before hashing; and
the first in-process reason capture passed `cliOverrides: { targetReductionRatio }` instead of
`{ budget: { targetReductionRatio } }`, silently planned `pass_through`, and reported 7
fallbacks where the CLI sees 37 — the documented no-budget trap, arrived at from inside.
