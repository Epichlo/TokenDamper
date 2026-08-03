# Phase 1d — Sub-Item Hashing Granularity (Design Proposal)

> ## ⚠️ Status
>
> **Proposed. Not approved, not implemented.** Written 2026-08-03 at `7dfc4f1`.
>
> Every number below is measured, against `dist/` at that commit, with the probes described
> in §10. Where a claim could not be measured it is labelled as an assumption.
>
> The recommendation is **proceed, with one precondition** (§8). The precondition is not a
> rewrite; it is a guard that must exist before this stage is allowed to succeed.

---

## 1. The question

Phase 1d established that `compression:token-hashing` can never succeed on a single-item
code bundle: it replaces an item's entire content, so every symbol dies at once, `R_AST` is
a boolean, and `S_k` is pinned at the formula constant `0.60`
(`docs/phase-1d-drift-investigation.md` §4, §6).

The proposed remedy is **sub-item granularity**: elide *regions* within an item instead of
the whole item, so surviving regions keep their symbols and `R_AST` becomes fractional.

The alternative — marking a hashed placeholder `recoverable: true` so `DriftTracker` exempts
it — is rejected up front and is not evaluated here. `DECISIONS.md` §16 and the
corresponding `NOTES-FOR-DOCS.md` entry established that `recoverable` is a claim about
**this** payload, verifiable only when an intact copy survives in it. Token-hashing has no
such copy. Asserting recoverability because rehydration machinery exists somewhere is the
error that produced the inflated 98.59% figure earlier in this phase.

## 2. Answer

**Sub-item granularity works, and the measurements are stronger than expected.** It also
changes the stage's failure mode from safe to unsafe, which is why §8 attaches a
precondition rather than a green light.

Three properties hold simultaneously, measured, not argued:

| Property | Result |
|---|---|
| Byte-identical round trip through the **existing** recovery valve | **12 / 12** |
| AST-valid after elision (of items that had an eligible region) | **8 / 8** |
| Drift gate discriminates instead of saturating | see §4 — it grades cleanly across depths |

And the failure mode it introduces:

> `HumanEval/0`: **55.66% reduction, `S_k = 0.0000`, AST-valid, round-trips exactly.**
> The elided region is the function's docstring — the entire specification of what the
> model is being asked to write. Every gate is green. The output is worthless.

## 3. The gate, stated exactly

For code, `R_struct` is pinned at `1.0` (`DECISIONS.md` §18 — the only marker is
`filepath:`, derived from `item.path`, which elision never touches). Substituting into

```
S_k = 1 − (0.60 · R_AST + 0.40 · R_struct)
```

gives, for code specifically:

```
S_k ≤ 0.40   ⟺   R_AST ≥ 1/3
```

**A sub-item elision passes iff it retains more than a third of the bundle's symbols.**
That is the design's quantitative target, and it is the first time this stage has had one.

## 4. Measured: the metric grades correctly once it has granularity

Real 5,025-byte TypeScript file (`src/core/hashing/token-hasher.ts`), varying only which
nesting depth of brace-interior is elided:

| Strategy | regions | bytes | reduction | AST valid | `R_AST` | `S_k` | drift gate |
|---|---|---|---|---|---|---|---|
| depth-1 — class bodies | 2 | 5025 → 673 | 87.79% | true | 0.2632 | 0.4421 | **falls back** |
| **depth-2 — method bodies** | 6 | 5025 → 2994 | **43.52%** | true | 0.7895 | 0.1263 | **passes** |
| depth-3 — inner blocks | 4 | 5025 → 4350 | 15.45% | true | 1.0000 | 0.0000 | passes |

This is the result §6 of the investigation predicted. The metric is not broken; it was being
handed a boolean. Given fractional input it moves smoothly and the `0.40` threshold
discriminates sensibly — depth-1 destroys the method signatures along with the bodies and is
correctly refused; depth-2 keeps them and is correctly allowed.

**Depth-2 — signature-preserving body elision — is the proposed operating point.**

Across the full corpus at that granularity (Python by indented block, TS/JS by brace
interior):

| Fixture | regions | bytes | reduction | AST valid | `R_AST` | `S_k` | drift FB | round trip |
|---|---|---|---|---|---|---|---|---|
| `HumanEval/0` | 1 | 348 → 179 | 55.66% | true | 1.0000 | 0.0000 | no | **yes** |
| `HumanEval/1` | 1 | 504 → 166 | 69.86% | true | 0.6667 | 0.2000 | no | **yes** |
| `HumanEval/2` | 1 | 328 → 126 | 63.74% | true | 1.0000 | 0.0000 | no | **yes** |
| `HumanEval/3` | 1 | 446 → 154 | 67.46% | true | 0.6667 | 0.2000 | no | **yes** |
| `HumanEval/4` | 1 | 386 → 167 | 59.63% | true | 1.0000 | 0.0000 | no | **yes** |
| `CodeXGLUE/py/101` | 1 | 192 → 154 | 28.30% | true | 0.7500 | 0.1500 | no | **yes** |
| `CodeXGLUE/py/102` | 0 | — | 0.00% | true | 1.0000 | 0.0000 | no | yes |
| `CodeXGLUE/ts/201` | 0 | — | 0.00% | **false¹** | 1.0000 | 0.0000 | no | yes |
| `CodeXGLUE/ts/202` | 0 | — | 0.00% | **false¹** | 1.0000 | 0.0000 | no | yes |
| `CodeXGLUE/js/301` | 0 | — | 0.00% | **false¹** | 1.0000 | 0.0000 | no | yes |
| `test_data/codebase.py` | 7 | 16937 → 1341 | 93.26% | true | 0.6667 | 0.2000 | no | **yes** |

¹ **Invalid on input, before any transform.** These three are truncated CodeXGLUE
completion prompts — they end at an open brace by design. See §7.

Read this table with §2's warning in force. The reduction figures are real bytes, and
several of them are deleting the wrong bytes.

## 5. The design

### 5.1 A new chokepoint, beside the existing one

`core/elision.elideItem` replaces an item's **entire** content and cannot express a partial
elision. Sub-item elision needs a sibling in the same module — nothing may bypass the
chokepoint, which is the lesson Issue 2 paid for:

```ts
export interface ElisionRegion {
  readonly start: number;   // inclusive index into item.content
  readonly end: number;     // exclusive
}

export function elideRegions(params: {
  readonly item: ContextItem;
  readonly regions: ReadonlyArray<ElisionRegion>;   // disjoint, ascending
  readonly markerFor: (regionText: string) => string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}): ElisionOutcome;
```

It keeps `elideItem`'s contract: render, check savings, validate the candidate with the very
validator `selectValidator` picks, and on refusal **skip and let the stage continue**.

### 5.2 Two hard rules, both discovered by measurement

**Rule A — the hashed region must be exactly the bytes replaced.**
`TokenHasher.rehydrateText` substitutes the placeholder in place. Any whitespace the encoder
adds around it survives rehydration and the round trip is no longer byte-identical. A first
prototype emitted `indent + placeholder` and scored **0 / 7** on round-trip; removing the
added indent scored **7 / 7**.

**Rule B — the placeholder must occupy a syntactically valid position.**
Rule A alone puts a Python placeholder at column 0, which the `PythonValidator` rejects
(`AST_INDENTATION_ERROR`). Applying Rule A without Rule B took AST validity from 8/8 to
**0/8**.

A and B conflict unless the region boundary is chosen to satisfy both: **exclude the leading
indentation from the region.** The indent stays in the surrounding text, the placeholder
inherits its column, and the hashed bytes are exactly what was removed. With that boundary
both hold at once — 12/12 round trip and 8/8 AST valid. This is the single most important
implementation constraint in the design and it is invisible from the type signatures.

### 5.3 Region selection

Deterministic, derived from a single left-to-right scan of `item.content`. No parser is
introduced; the scanners already exist.

- **TypeScript / JavaScript** — reuse the `TypeScriptValidator` bracket/quote/comment state
  machine to find brace spans, and take **interiors at nesting depth 2**. Braces stay
  outside the region, so balance is preserved by construction.
- **Python** — reuse the `PythonValidator` indent stack to find the block under a
  `def`/`class` header, and take that block **minus the first line's indentation**.
- **Everything else** — no regions. Prose, logs, markdown and JSON are out of scope (§9).

Both scanners are already written and already trusted for validation; this reads their
spans instead of only their verdicts.

### 5.4 Eligibility

The placeholder is exactly **77 bytes** (`<BLOCK_HASH:` + 64 hex + `>`). A region must
exceed that to save anything at all, and comfortably exceed it to be worth the risk.
Proposed floor: **101 bytes** (77 + 24), used for every measurement above. The existing
whole-item `minContentLength` of 40 stays for the whole-item path.

`elideItem`'s savings check applies per region: if the rendered replacement is not smaller
than the region, skip that region — not the item.

### 5.5 Determinism

Region boundaries are a pure function of `item.content` and the language. Same input, same
regions, same bytes out. Invariant 1 holds. Verified across repeated runs of every probe.

## 6. Interaction with the recovery valve — required accounting

**The valve already handles this and needs no change.** `TokenHasher.rehydrateText` uses a
global regex replace, so N placeholders inside one item all resolve; measured byte-identical
on 12/12 samples including a 7-region file. `attemptAutomatedRehydration` triggers on
`content.includes('<BLOCK_HASH:')`, which is true of partially hashed content.
`detectCorruptedPlaceholders` likewise regexes over content and is unaffected.

Two consequences worth stating:

**The valve becomes strictly better under this design.** Today it is all-or-nothing per
item: hitting the drift gate un-hashes everything and returns 0% saved. With regions, the
engine can un-hash the *fewest regions needed* to lift `R_AST` above `1/3` and keep the
rest — a genuine partial recovery rather than a full undo. That is not required for a first
cut and should not be built into it, but the design must not foreclose it, and Rule A is
what makes it possible.

**Implication for Phase 1c.** The valve is already an accidental partial rollback: it undoes
`token-hashing` specifically and preserves earlier stages' work. Checkpointing should
generalise *that*, not stand a second mechanism beside it. What the valve demonstrates is
that rollback needs an **inverse**, not a snapshot — and Rule A (exact-substring
replacement) is precisely the property that makes the inverse exist. Any stage that wants to
participate in checkpointing needs an equivalent. `pruning:topology-pruner`, which drops
whole items, has no inverse today and would need one.

## 7. Interaction with bundle-wide validation — required accounting

`validate()` runs `validateBundleAst` over **every** item in the final bundle, so a failure
is not always attributable to a stage (`NOTES-FOR-DOCS.md`). Sub-item granularity changes
this picture in one direction and leaves it unchanged in another.

**It improves attribution.** A failure inside a transformed item is now attributable to a
*region*, not merely to a stage that touched the item. That is a finer unit than Phase 1c
currently assumes exists, and it is what would make "roll back the failing part" tractable.

**It does not solve the residual problem, and the corpus proves it.** Three of the ten
bundled fixtures are **AST-invalid on input**:

```
CodeXGLUE/ts/201  AST_UNBALANCED_BRACKET @6   "…export function escapeRegExpCharacters(value: string): string {\n"
CodeXGLUE/ts/202  AST_UNBALANCED_BRACKET @1   "export function isArray(obj: unknown): boolean {\n"
CodeXGLUE/js/301  AST_UNBALANCED_BRACKET @1   "function etag(body, encoding) {\n"
```

`CodeXGLUE/ts/202`'s current fallback is caused by this, not by any stage:

```
CodeXGLUE/ts/202  drift=0    reason=AST Error in item [...] at line 1
CodeXGLUE/py/101  drift=0.6  reason=Semantic drift metric (0.60) exceeds maximum threshold (0.40).
CodeXGLUE/ts/201  drift=0.6  reason=Semantic drift metric (0.60) exceeds maximum threshold (0.40).
CodeXGLUE/js/301  drift=0.6  reason=Semantic drift metric (0.60) exceeds maximum threshold (0.40).
```

There is no stage and no region to roll back. **The AST gate cannot be the discriminator on
content that does not parse to begin with**, and completion prompts — a first-class input
for this product — routinely do not. Any checkpointing design must decide explicitly what
happens to a failure that predates every stage; "roll back the failing stage" has no answer
here.

*Not a defect found:* the bench's `syntaxPassRate: 100%` is honest despite the above.
`BenchmarkEvaluator` validates `prompt + referenceCompletion`, which closes the braces. This
was checked rather than assumed.

## 8. The blocking objection, and the precondition

Sub-item granularity does not merely make the stage effective. It **changes the failure mode
from safe to unsafe.**

Today `token-hashing` is useless but honest: it destroys everything, drift pins at `0.60`,
the pipeline falls back, and the user gets their input. Under this design it becomes capable
of deleting exactly the content the metric cannot see, and reporting a clean pass.

`HumanEval/0` is the proof, and it is not a corner case — it is the modal shape of a coding
prompt:

```
[HumanEval/0] elided region:
  "\"\"\" Check if in given list of numbers, any two numbers are closer to each other than
   given threshold.\n    >>> has_close_elements([1.0, 2.0, 3.0], 0.5)\n    False\n …"
```

55.66% reduction. `R_AST = 1.0000`. `S_k = 0.0000`. AST-valid. Round-trips exactly. **The
docstring is the task.** Drift scores it perfect because docstrings contain no symbols, and
`R_struct` — the half of the metric that is supposed to notice structural loss — is a
constant for code and notices nothing.

This is the same shape as every finding in this phase: a check that passes because it never
looked. The difference is that here it would be *shipped as a feature*.

**Precondition for approval.** One of these must land with the granularity change, not
after it:

- **(a) Make `R_struct` do work for code.** The real fix, and already an open item in
  `DECISIONS.md` §18: teach `extractMarkers` content-derived structural markers — comment and
  docstring blocks, nesting depth, function and class boundaries. Then deleting a docstring
  costs retention instead of being invisible.
- **(b) Refuse comment-and-docstring-only regions in the selector.** Cheap, targeted, and
  ships in a day. It defends against the case measured here, **not against the class** — any
  other high-information symbol-free content (a SQL literal, a config block, a worked
  example) remains invisible to the metric.

Recommendation: **(b) to unblock, (a) to actually close it**, with (a) tracked rather than
assumed. Shipping (b) alone and calling the problem solved would repeat the pattern this
phase exists to break.

## 9. Explicitly out of scope

- **JSON.** Sub-item JSON elision is **broken on the reverse path** and must not be
  attempted in a first cut. `rehydrateText` checks `unwrapElisionContent` first, which only
  fires when the *whole* item is a wrapped marker. A wrapper nested inside a larger document
  falls through to the regex path and the raw content is substituted *inside* the wrapper:

  ```
  input : {"id":1,"payload":{"rows":[1,2,3],"note":"xxx…"},"tail":true}
  output: {"id":1,"payload":{"__td_block__":"{"rows":[1,2,3],"note":"xxx…
  ```

  Not byte-identical, and not valid JSON. The format and its inverse are one contract; the
  wrapper form is not composable at sub-item granularity. Whole-item JSON elision is
  unaffected and keeps working.
- **The Gateway.** Invariant 8 stands. `token-hashing` still does not run there.
- **Prose, logs, markdown.** No region selector, no change.
- **Prompt-cache alignment.** Flagged, not fixed: `runTokenHashingStage` **never consults
  cache pinning** — its only nod to invariant 6 is a comment about `role === 'system'`.
  Sub-item elision mutates bytes in the *middle* of an item, which is worse for a cached
  prefix than dropping a whole late item. This is a pre-existing gap that this change makes
  material. It needs a decision before the stage is enabled anywhere prefix caching matters.

## 10. Reproduction

Four scratchpad probes against `dist/` at `7dfc4f1`; none are repo code.

1. **Validator behaviour under sub-item placeholders** — TS/Python/JSON validators against
   placeholders in balanced, unbalanced, in-string and mis-indented positions.
2. **Round-trip** — `TokenHasher.rehydrateText` over content with 1, 2 and 7 placeholders.
3. **Yield** — signature-preserving elision over the ten bench fixtures plus
   `test_data/codebase.py` and a real 5 KB TS source file, scored with the real
   `DriftTracker`, the real validators and the unified `estimateTokens`.
4. **Depth sweep** — the §4 table.

Notable results the probes corrected mid-flight, recorded because the first answer was
wrong in each case: a "region straddling braces" test that removed one `{` and one `}` and
so proved nothing; a round-trip that failed 7/7 on added indentation; and an AST collapse
from fixing that round trip naively.

## 11. Open questions for approval

1. **Precondition (a) or (b)?** §8. Recommendation: (b) now, (a) tracked as the real fix.
2. **Depth-2 as the fixed operating point, or budget-driven?** The depth sweep suggests the
   planner could choose depth from `targetReductionRatio` and back off on a drift failure.
   That is more capable and less predictable. Recommendation: fix it at depth-2 for the
   first cut; determinism is the product.
3. **Does the recovery valve get region-level partial un-hashing now, or later?** §6.
   Recommendation: later — it is the Phase 1c bridge, not part of this change.
4. **What is the answer for AST-invalid input?** §7. Three of ten bundled fixtures, and the
   product's own input shape. This blocks Phase 1c more than it blocks 1d, but it should be
   decided rather than inherited.
5. **Cache pinning.** §9. Who owns the decision, and does it gate enabling the stage?
