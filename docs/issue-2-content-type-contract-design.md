# Issue 2 — Content-Type Contract (Design Proposal)

> **STATUS: APPROVED 2026-08-02**, with the seam changed from `ContextBundle` to
> `ContextItem`. Written against `d51a01b`. Landing as two commits: (1) placeholders and the
> chokepoint, (2) the relabel.
>
> This supersedes `purposed architecture changes.md` Change 1, which specified a
> bundle-level tag. See `NOTES-FOR-DOCS.md`.

---

## The reframing (read this first)

**The tag was never missing.**

`ContentType` has existed on `ContextItem` since the model was frozen
(`src/core/model/types.ts:19`, field at `:53`), and `classifyContent()` has been setting it
at ingestion the whole time. `compression:token-hashing` **already reads it** — at
`token-hashing.ts:75` it copies `item.contentType` onto the very item it produces. It
carries the tag through the transform and never once consults it to decide whether the
transform is safe.

So Issue 2 is not "add content-awareness to the pipeline." It is **"stages ignore the
awareness they already have."** Three concrete defects follow from that framing, and none of
them is a missing field:

1. Four construction sites bypass `classifyContent()` and hardcode a literal
   (three `'text'` in the Gateway, one `'code'` in bench).
2. Eliding stages never consult the tag they already propagate.
3. Nothing binds *how a stage elides* to *which validator will judge the result* — the two
   are written independently, which is why they disagree.

Framing it as "add a tag" would have produced a second tag alongside the working one, at a
coarser granularity than the validator that has to agree with it. That is how this bug is
reproduced, not fixed.

---

## 0. What I found on the proxy side first

You asked me to check whether `61bd685` introduced content-type handling on the Gateway
before designing anything.

**It did not.** None of the 12 files in that commit added, moved, or decided content-type
behavior. There is **no parallel implementation to reconcile** — Issue 2 still has one
contract to design.

There is, however, a **pre-existing wrong default** on that path, older than `61bd685`:

| Site | Value | Set by |
|---|---|---|
| `src/gateway/proxy.ts:441` (OpenAI messages) | `contentType: 'text'` hardcoded | pre-existing |
| `src/gateway/proxy.ts:546` (Anthropic system) | `contentType: 'text'` hardcoded | pre-existing |
| `src/gateway/proxy.ts:568` (Anthropic messages) | `contentType: 'text'` hardcoded | pre-existing |
| `src/bench/evaluator.ts:45,54` | `contentType: 'code'` hardcoded | pre-existing |

`classifyContent()` — the ingestion classifier that already exists — is called from exactly
one place, `createContextBundle()` (`constructors.ts:67`), which is the **single-item CLI
path only**. Every multi-item construction site bypasses it and hardcodes a literal.

One thing `61bd685` *did* decide implicitly, and it should be named: pinning the Gateway to
`session_dedup` mode is a **stand-in for content-type awareness**. It avoids
token-hashing-on-JSON by avoiding token-hashing entirely. That pin is what this work should
make unnecessary — the mode can stay, but its justification disappears.

---

## 1. Where I disagree with the framing

### 1.1 `ContextBundle` is the wrong seam. The tag belongs on `ContextItem` — where it already is.

The brief says content-type "becomes a first-class tag on `ContextBundle`". I think that is
the wrong place, for four reasons drawn from the code:

**(a) It already exists on `ContextItem`, and is already set at ingestion.**
`ContentType` is defined at `src/core/model/types.ts:19` as
`'text' | 'markdown' | 'code' | 'html' | 'json' | 'yaml' | 'logs' | 'unknown'`, and
`ContextItem.contentType` at line 53. `classifyContent()` sets it. The tag is not missing.

**(b) The validator that rejects the placeholder dispatches per item, not per bundle.**
`selectValidator(item)` (`src/core/validation/ast/index.ts`) resolves with precedence
`item.language` → `item.path` extension → `item.contentType`. If the tag governing the
*transform* were bundle-level while the *check* is item-level, the producer and the checker
would be keyed at different granularities. That mismatch is the exact defect class that
produced this bug. Putting the tag on the bundle would preserve the shape of the bug while
appearing to fix it.

**(c) Bundles are heterogeneous by construction.** A Gateway bundle is N messages: message 0
may be a 12 KB JSON tool result, message 1 a one-line prose question. A scalar bundle tag
forces a choice between over-conservatism (skip the stage entirely if *any* item is JSON,
losing reduction on the prose) and corruption (apply a JSON contract to prose, or worse the
reverse). Neither is acceptable, and the choice only exists because the tag is at the wrong
level.

**(d) `ContextBundle` already carries the correct bundle-level summary.**
`statistics.contentTypeCounts` (`types.ts:90`) is a `Record<ContentType, number>` histogram.
A scalar `bundle.contentType` would duplicate and contradict it.

### 1.2 The bug is not a missing tag. It is an unconsulted one.

`compression:token-hashing` **already reads and propagates** `item.contentType` — at
`token-hashing.ts:75` it copies it onto the item it produces. It just never consults it when
deciding eligibility. Its four eligibility rules check `preserveKinds`, `role === 'system'`,
`metadata.elided`, and `content.length`. There is no content-type rule.

So the actual defect is three things, none of which is "the tag does not exist":

1. Four construction sites bypass `classifyContent()` and hardcode a literal.
2. Eliding stages do not consult the tag they already carry.
3. Nothing binds *how a stage elides* to *which validator will judge the result*.

Fixing only (1) makes things **worse** — see §2.

### 1.3 Scope correction: `session-dedup` has the same defect as `token-hashing`

This is the finding that most changes the shape of the task.

The brief scopes Issue 2 to `compression:token-hashing`. But `cleanup:session-dedup` writes
`[TokenDamper Elided: ref=… bytes=… kind=…]` into item content with equally no idea what it
is overwriting. That string is not valid JSON either.

It is invisible today only because the Gateway hardcodes `contentType: 'text'`, which makes
`selectValidator` return `null`, so **no validator runs at all** on Gateway items. The bug
is masked by the mislabel, not absent.

Consequence: **relabelling the Gateway without also fixing the dedup placeholder would break
the Gateway's only working stage.** The contract must cover every eliding stage, not just
token-hashing.

---

## 2. Measurements

Measured against `tokendamper-benchmark/test_data/tool_output.json` (12,036 bytes, parses
clean) in a Gateway-shaped two-item bundle, at `d51a01b`.

### 2.1 Drift and AST delta from correcting the label

| contentType | Validator selected | Stage | AST valid | drift `S_k` | Fallback |
|---|---|---|---|---|---|
| `text` *(today)* | **NONE** | session-dedup | true | 0.0000 | no |
| `text` *(today)* | **NONE** | token-hashing | true | 0.0000 | no |
| `json` *(relabelled)* | `json` | session-dedup | **false** | 0.0000 | no |
| `json` *(relabelled)* | `json` | token-hashing | **false** | **0.6000** | **yes** |

**Drift delta from the relabel:**

- `session-dedup`: **0.0000 → 0.0000** (no change). Symbols before/after `32 / 32` — the
  Phase 1.0b recoverable-elision exemption substitutes the original content back, so
  correcting the label does *not* push dedup over the threshold.
- `token-hashing`: **0.0000 → 0.6000**, over the 0.40 threshold. Symbols `32 / 0`.

Per your instruction: the token-hashing move to 0.60 **is the drift gate, and is expected**.
It is not a failure of this contract and I am not tuning the contract to avoid it. It is the
correct behavior for a lossy stage that destroys 32 JSON key symbols. I am reporting it
rather than designing around it.

The dedup row staying at 0.0000 is worth noting explicitly: **the Phase 1.0b exemption is
precisely what makes the relabel safe for the Gateway's current single stage.** Without it,
the relabel would have pushed dedup drift up as well, and the Gateway would have regressed.

### 2.2 The uncomfortable finding: today's safety net is vacuous on JSON

The `text` rows above show AST `true` and drift `0.0000` for *both* stages — including
token-hashing, which is actively corrupting the payload.

Both checks are passing **vacuously**:

- AST: `contentType: 'text'` with no `language` and no `path` → `selectValidator` returns
  `null` → the item is not validated at all.
- Drift: `DriftTracker.extractSymbols` only harvests `jsonkey:` symbols when
  `item.contentType === 'json'`. A JSON blob labelled `text` yields **zero** symbols (it
  has no `function`/`class`/`const` patterns), so retention is vacuously 1.0 and drift 0.0.

This qualifies the Phase 1.0b claim in `docs/phase-1-stabilization-summary.md`: the Gateway
safety net is real and does fire (proven on the constraint-directive case), but **on
JSON-shaped content specifically it is currently blind**. The mislabel is not a cosmetic
defect; it is silently disarming both validators. That should be recorded regardless of
what happens to the rest of this design.

### 2.3 Placeholder format candidates

| Candidate | Bytes | JSON-valid | Round-trips through existing `rehydrateText` |
|---|---|---|---|
| `<BLOCK_HASH:…>` *(current)* | 77 | **no** | exact |
| `"<BLOCK_HASH:…>"` (quoted) | 79 | yes | **BROKEN** — `Unexpected non-whitespace character after JSON` |
| `{"__td_block__":"…"}` (wrapper) | 83 | yes | returns unchanged — not rehydrated at all |

**This is the constraint that binds the design.** `TokenHasher.rehydrateText` uses
`/<BLOCK_HASH:([a-f0-9]{64}|[a-f0-9]{12,64}|[^>]+)>/g` and substitutes raw content in place.
For the quoted form it matches the *inner* placeholder and produces
`"{…raw JSON object…}"` — a quoted string wrapping a JSON object, which is invalid. For the
wrapper form the regex does not match at all, so nothing is rehydrated.

**Placeholder format and rehydration are one contract, not two.** Any format change must
land with its matching reverse transform in the same change, or round-trip breaks.

Byte-stability was verified: two independent `TokenHasher` instances produce an identical
placeholder for identical content, because it is `sha256(content)` and nothing else. No
position, session, turn, or timestamp enters the string. (`createBlockPlaceholder` does
record `createdAt: Date.now()` in the block *metadata*, but that never reaches the emitted
bytes — this must stay true.)

---

## 3. The proposed contract

### 3.1 The tag

Keep `ContextItem.contentType`. Add nothing to `ContextBundle`.

Change instead: **every construction site must classify rather than hardcode.** Route the
four hardcoded sites through `classifyContent()`, so the Gateway and bench paths get the
same treatment the CLI already gets.

`ContextBundle.statistics.contentTypeCounts` remains the bundle-level view, and becomes
accurate for the first time as a side effect.

### 3.2 Tag as hint, content as ground truth

This is the substantive addition, and it is what makes misdetection safe.

A tag-derived eligibility check inherits the classifier's mistakes: if content is
misclassified as prose, both the transform *and* the post-condition check consult the same
wrong tag, agree with each other, and emit corruption. Self-consistent and wrong.

For JSON specifically, ground truth is **decidable and cheap**: `JSON.parse` either succeeds
or does not. Where a decidable check exists, using a heuristic tag as the authority is the
weaker design.

So eligibility resolves in this order:

1. `selectValidator(item)` — reuse the *same function the checker uses*, so producer and
   checker cannot disagree by construction.
2. If it returns `null`, **probe anyway**: if `item.content` parses as JSON, treat the item
   as JSON regardless of tag. This catches the mislabelled Gateway case even before the
   relabel lands, and means the fix is not dependent on classification being correct.
3. Otherwise fall back to the tag.

### 3.3 Placeholder contract per content type

| Content type | Placeholder form | Rationale |
|---|---|---|
| `json` | `{"__td_block__":"<sha256>"}` | Valid JSON; self-describing; survives embedding in a larger structure; distinguishable from user data by the reserved key |
| `code`, `prose`, `logs`, `text`, `markdown`, others | `<BLOCK_HASH:<sha256>>` (unchanged) | Current behavior preserved; no cache disturbance on paths that work today |
| unknown / ambiguous | **refuse to elide** | See §3.5 |

I prefer the wrapper object over the quoted string for `json`. Both are JSON-valid, but the
quoted form is indistinguishable from a legitimate user string that happens to contain that
text, whereas a reserved object key is unambiguous — and unambiguous reverse-mapping is what
rehydration needs.

**Every form must remain a pure function of `sha256(content)`.** No position, index, session
id, turn number, or timestamp. This is the cache-alignment requirement and it is
non-negotiable: `cache-aware.ts` pins the prefix by accumulating `estimateItemTokens` over
items in order, so an unstable placeholder both busts the provider cache and perturbs
prefix-pin boundaries.

Note the JSON form is ~6 bytes longer than the bare form. Negligible against a 12 KB block,
but it does shift `estimateItemTokens` and therefore knapsack weights and the 1024-token
prefix accumulation. Worth asserting in a test rather than assuming.

### 3.4 Enforcement — and an honest limit

You asked for the invalid case to be **unrepresentable**, not merely checked. I want to be
straight about how far that is achievable here.

**TypeScript cannot statically prove a `string` is valid JSON.** `ContextItem.content` is a
`string`. No type-level encoding makes "emits invalid JSON for a JSON item" a compile error
without changing content to a parsed representation, which is a far larger change than this
task and would fight the immutable-bundle model. Anyone promising you pure type-level
unrepresentability here is overselling.

What is achievable is a **single chokepoint with an inescapable post-condition** — three
layers:

**Layer 1 — branded type.** Placeholder rendering returns a branded `Placeholder` type, not
`string`. Raw strings become unassignable to elided-item content, so a stage cannot
hand-roll a marker. This catches the careless case at compile time.

**Layer 2 — one chokepoint.** All eliding stages call a shared
`elideItem(item, hash): ContextItem | null` rather than constructing elided items
themselves. Today `session-dedup`, `token-hashing` and `delta-compression` each build their
own — which is why the same bug exists in more than one of them. One implementation, one
place to be correct.

**Layer 3 — post-condition inside the chokepoint.** `elideItem` renders the placeholder,
constructs the candidate item, then runs `validateItemAst()` on it *before returning*. If
the candidate fails, it returns `null` and the caller keeps the original item.

**Correction after implementation (2026-08-02).** Layer 3 is *not* what makes this safe, and
the original wording above oversold it. Measured: only `JsonValidator` rejects a bare
`<BLOCK_HASH:…>`; the TypeScript and Python AST-lite validators both **accept** it. Since
JSON is exactly the case Layer 1 renders safely, **`post_condition_rejected` is currently
unreachable**.

The load-bearing mechanism is **Layer 1, correct-by-construction rendering**: the stage does
not choose the encoding, so it cannot express the invalid case. Layer 3 is retained as
defense in depth against a future renderer bug or a stricter validator, and a test pins the
reasoning so it fails loudly if that changes.

Corollary worth recording: placeholder injection into TypeScript or Python content would not
be caught by AST validation at all. Only drift would flag it. That is a pre-existing
weakness in the AST-lite validators, not something this contract introduces — but it does
mean the AST gate is JSON-only in practice.

### 3.4.1 Refusal semantics

A refusal **skips that item and the stage continues**. It never aborts the stage.

Per-stage checkpointing (Phase 1c) does not exist yet, so a stage-level abort would surface
as `status: 'failed'`, which the engine converts into `STAGE_EXECUTION_FAILED` and a
whole-pipeline fallback. That would convert a placeholder defect into a fallback defect —
the exact failure mode this phase exists to remove.

The caller keeps the original item and records the skip. Trace reporting per stage:

| Metric | Meaning |
|---|---|
| `itemsSkipped` | total items the chokepoint declined |
| `skippedNoSavings` | rendered content was not shorter than the original |
| `skippedPostConditionRejected` | validator rejected the candidate (currently unreachable) |

The stage `notes` string carries the same breakdown in prose, so a stage that correctly
declined every item is visibly distinct from a stage that ran and was rolled back — which
today are indistinguishable in the trace.

Cost: one extra AST validation per elided item. `validateItemAst` already enforces a 5 ms
SLA and `JSON.parse` on 12 KB is microseconds. The existing per-stage validation already
walks every item, so this is a constant-factor increase on an existing traversal.

### 3.5 Misdetection behavior and failure direction

Direction: **conservative — refuse to transform, never emit-and-hope.**

| Misdetection | Outcome |
|---|---|
| JSON blob mislabelled `prose`/`text` | Caught by the §3.2 content probe → JSON contract applied → correct placeholder |
| Prose mislabelled `json` | JSON validator rejects the bare placeholder → Layer 3 refuses → item kept whole. Lost reduction, no corruption |
| Markdown containing fenced code | No JSON validator selected; bare placeholder; validator is `null` or TS → unchanged from today |
| JSONL / log file that is really JSON lines | Whole-content `JSON.parse` fails (JSONL is not a single document) → treated as logs → bare placeholder → no validator → no corruption. Reduction is achieved, structure is not claimed |
| Ambiguous / unknown | Refuse to elide |

In every row the failure mode is **lost reduction, not emitted corruption**. That is the
direction you asked for, and it falls out of Layer 3 rather than being separately
engineered: anything the validator would reject simply does not get emitted.

### 3.6 How the planner consults it

The brief wants the planner to consult content-type *before* transforms run. I agree with
the intent but think planner-level gating alone is insufficient, for the §1.1(c) reason:
the planner selects `stageIds` for the **whole bundle**, while eligibility is **per item**.
Gating there means "skip token-hashing if any item is JSON", which discards reduction on
every prose item in a mixed bundle.

Proposed split:

- **Planner (coarse, bundle-level):** consult `statistics.contentTypeCounts`. If *every*
  eligible item is a type a stage cannot transform, drop the stage from `stageIds` and say
  so in the trace. This is an honesty-and-cost optimization — it avoids scheduling a stage
  that will no-op, and makes the trace explain why.
- **Chokepoint (fine, per-item):** the §3.4 enforcement decides each item.

Both, not either. The planner's job is not scheduling work that cannot succeed; the
chokepoint's job is guaranteeing correctness. Only the second is load-bearing for the bug.

### 3.7 What changes in the trace

Today a JSON payload produces one aggregate fallback with AST and drift reasons commingled —
which is exactly why fixing the placeholder alone would look like a failure.

Additions:

- Per-stage `itemsSkipped` with a reason breakdown (`content_type_ineligible`,
  `post_condition_rejected`), so a stage that correctly declines is visibly distinct from a
  stage that ran and got rolled back.
- Planner records why a stage was dropped from `stageIds`.
- The bundle content-type histogram, so a trace is self-explaining without re-deriving it.
- Separate `astIssues` from `driftScore` in the fallback reason rather than joining them
  into one string. Required for the §4 acceptance criterion to be checkable at all.

---

## 4. Acceptance criteria

Per your instruction, success is defined as **the AST error no longer appearing in the
trace** — not as reduction going above zero.

**Primary (must hold):**

1. On `tool_output.json` and `session.json`, no `JSON_SYNTAX_ERROR` appears in the trace for
   any stage-emitted placeholder.
2. Round-trip: rehydrating an elided JSON item reproduces the original content **byte for
   byte**.
3. Every emitted placeholder is byte-identical across turns and across independent
   `TokenHasher` instances for identical content.
4. No stage can emit an item that fails its own validator — asserted by a test that calls
   the chokepoint directly with hostile inputs.

**Explicitly NOT criteria:**

- Reduction > 0% on `tool_output.json` / `session.json`. Per §2.1, token-hashing on JSON
  measures **drift 0.60 against a 0.40 threshold**, so those payloads may still legitimately
  fall back on drift *after* the AST error is gone. That is the drift gate doing its job.
  Judging this work by reduction would score a correct fix as a failure.
- Any change to the drift threshold. Out of scope here.

---

## 5. Test strategy

Contract tests (these I can write before approval, as agreed):

1. **Placeholder validity, table-driven** — for each content type, the rendered placeholder
   passes the validator `selectValidator` picks for that item.
2. **Round-trip byte-identity** — property/fuzz test over generated JSON documents
   (nested objects, arrays, embedded quotes, unicode, empty containers): elide → rehydrate →
   assert `===` original. Extends `test/unit/fuzz-diff-debt.test.ts` rather than adding a
   parallel harness.
3. **Cache stability** — identical content ⇒ identical placeholder bytes across independent
   hashers, across turns, and independent of item position within the bundle.
4. **Post-condition inescapability** — a deliberately wrong stage that tries to emit a bare
   placeholder for a JSON item; assert the chokepoint refuses and the original item survives.
5. **Misdetection matrix** — one case per §3.5 row; assert the outcome is lost reduction and
   never invalid emitted content.
6. **Regression: `session-dedup` on JSON** — the §1.3 defect; currently masked by the
   mislabel, must not reappear after relabelling.
7. **Relabel delta guard** — pins the §2.1 numbers, so a future change to `extractSymbols`
   or `selectValidator` that silently re-disarms the JSON path fails loudly.

---

## 6. Open questions for you

1. **Wrapper object vs quoted string** for the JSON placeholder (§3.3). I recommend the
   wrapper for unambiguous reverse-mapping; it costs ~4 bytes more than the quoted form.
2. **Scope of the relabel.** Correcting `bench/evaluator.ts`'s hardcoded `'code'` will change
   benchmark AST dispatch and therefore the baseline numbers. Include it here, or isolate it
   so this work is not entangled with benchmark movement?
3. **`session-dedup` inclusion.** §1.3 says it must be in scope or the relabel regresses the
   Gateway. Confirm you want that absorbed here rather than tracked separately.
4. **Gateway enablement** stays out of scope per the brief. For the record, the bar for
   enabling `token-hashing` there would be: this contract landed, round-trip proven, **and**
   the drift gate resolved for lossy stages on JSON — which §2.1 shows is a separate
   problem this design does not solve.
