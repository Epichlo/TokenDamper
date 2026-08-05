# Phase 4b — Disposition of the Three Levers Against DECISIONS §32

> **Date:** 2026-08-06 · **Status: measured, nothing implemented, no remedy proposed.**
> Engine: `dist` built from `73177bd`. Corpus frozen under `sha256` manifests: 144 files —
> 45 `pip` Python, 64 repo TypeScript, 9 shell scripts, 25 repo markdown, 1 log. Tokens are
> `cl100k_base` where a corpus aggregate is quoted and the **engine estimator** where a CLI
> trace is quoted verbatim; each figure says which.
>
> **Question:** §32 defers the hash-commented-code defect into drift/§28 on the grounds that
> the only identified fix is a `looksLikeMarkdown` change with blast radius over every prose
> item. Is that the only fix?
>
> **Answer: two of the three levers are dead, and the third terminates in the same deferral.**
> §32 stands, with better evidence than it had. Its claim that a classifier change is the *only*
> identified fix is now wrong in the letter — three are identified — and right in the substance.

---

## 0. Reconciliation first: what the 4b.3 characterization test actually does

The `73177bd` commit message says the `KNOWN DEFECT` block exists "so whoever fixes it removes
a failing assertion deliberately". **That description is wrong, and the discrepancy the
question points at is real.**

`test/unit/markdown-marker-allowlist.test.ts` contains no `.skip`, no `.fails`, no `.todo`. Both
`KNOWN DEFECT` tests **pass**, and are counted in the 471. They assert current behaviour:

```ts
expect(result.trace.astCoverage).toEqual({ checked: 0, unchecked: 1, uncheckedContentTypes: ['markdown'] });
expect(result.validation.driftCoverage?.structMeasured).toBe(true);
expect(result.validation.driftCoverage?.measured).toBe(true);
expect(result.validation.driftCoverage?.unwitnessedItems).toEqual([]);
```

So: **a passing characterization test.** The mechanism I described is real but inverted — the
assertions do not fail now, they will *begin* failing the moment someone fixes the defect, which
is what forces the encounter.

**Does that make the defect the de facto spec? Yes.** A green assertion is a specification; the
only thing marking these as not-a-spec is the `describe` name and a docblock, which are prose
and enforce nothing. A tool reading the suite — or a person skimming green output — sees
`structMeasured: true` on a 99%-deleted shell script asserted as correct. `it.fails` is not the
fix (it inverts to "the body must throw", which these bodies do not). The minimal honest remedy
is an assertion that carries its own verdict, e.g. asserting the pair
`(structMeasured: true, astCoverage.checked: 0)` is *contradictory* and marking the test
`todo`-adjacent. **Not implemented here** — flagged, because it is the same shape as the defect
it documents: a green result standing in for a judgement nobody made.

---

## 1. Lever 1 — prohibit whole-item elision when `astCoverage.checked == 0`

### What it would change

Computed against per-item traces, not simulated by patching: an item with `checked == 0` that
currently reduces would return its input.

| corpus | n | reduce | `checked==0` | **lose** | tok saved now | after lever |
|---|---|---|---|---|---|---|
| pip | 45 | 19 | 6 | 1 | 8,832 | 8,815 |
| ts | 64 | 2 | 64 | 2 | 78 | 0 |
| shell | 9 | 4 | 9 | **4** | 3,670 | 0 |
| prose | 25 | 2 | 25 | **2** | 785 | 0 |
| logs | 1 | 0 | 1 | 0 | 0 | 0 |
| **stdin total** | **144** | 27 | | **9** | **13,365** | **8,815** |

**4,550 of 13,365 cl100k tokens given back — 34% of everything the pathless route currently
saves.** On the file-argument route the cost is small: 46 files reduce, 2 at `checked == 0`,
785 tokens.

### Does it kill the cases §24 established are not structurally doomed?

**Prose: yes, both of them.** The two prose files that reduce over stdin are exactly the §24
class, and the lever stops both (engine estimator, as the CLI reports it):

```
CODE_OF_CONDUCT.md   910 -> 19 tokens (97.9%)   drift 0.400   fallbackUsed false
SECURITY.md          305 -> 19 tokens (93.8%)   drift 0.400   fallbackUsed false
```

**Logs: the case does not arise on this corpus, and I am not claiming the lever kills it.**
`sample_logs.txt` reduces 0% on *both* routes, falling back on constraint-preservation —
`Imperative constraint directive dropped: "999Z [CRITICAL] com."`, which is Issue 4's planted
directive doing its job. §24's `logs:WHOLE saved=97.5%` was measured on a payload this corpus
does not contain. Unmeasured here, stated as unmeasured.

### The Gateway, which is where the lever actually dies

Invariant 8: `cleanup:session-dedup` is the only stage the proxy runs. Measured on the
cross-turn scenario (not `session.json`, whose turn 2 falls back for unrelated reasons and
would have hidden this):

```
turn 2 elided the repeated context: true
   elided to: "[TokenDamper Elided: ref=82744641a800 bytes=349 kind=conversation]"
   msg[0] contentType=text  validator=NONE (checked=0)
   msg[1] contentType=text  validator=NONE (checked=0)
   msg[2] contentType=text  validator=NONE (checked=0)
turns: [{raw:87, opt:87, saved:0, fb:false}, {raw:101, opt:32, saved:69, fb:false}]
```

**Every dedup elision the Gateway performs is a `checked == 0` whole-item elision.** The lever
does not cost the Gateway some reduction; it makes the Gateway a pass-through. Conversational
messages have no validator and never will — that is what §17 settled.

### Why it cannot be narrowed

The two items the lever must tell apart are **identical on every field it could key on**:

| trace field | `tclConfig.sh` (must stop) | `CODE_OF_CONDUCT.md` (must not) |
|---|---|---|
| `contentType` | markdown | markdown |
| `astCoverage` | `checked 0, unchecked 1` | `checked 0, unchecked 1` |
| `driftScore` | 0.400 | 0.400 |
| `structMeasured` / `astMeasured` / `measured` | true / false / true | true / false / true |
| `symbolsBefore` | 0 | 0 |
| `unwitnessedItems` | `[]` | `[]` |
| `fallbackUsed` | false | false |
| outcome (engine estimator) | 1,877 → 19 | 910 → 19 |

The single differing field is `contentMarkersBefore`: **79 versus 12** — and it points the wrong
way. The shell script has *more* structural evidence than the real document, because its
evidence is fabricated. Any threshold on marker count protects the shell script less.

**Verdict: dead.** Not because it costs 34% of pathless yield, but because at the moment the
gate would fire the harmed case and the intended case are the same item — coverage is precisely
what they have in common — and because it stops the Gateway product outright.

---

## 2. Lever 2 — non-content discriminators (shebang, executable bit, extension)

Question set: 9 shell scripts + the 4 `pip` files 4b.2's probe declines *and* that land in
`markdown` + 25 real documents = **38**. (Two further declined `pip` files land in `text` and are
not part of the question — they harvest nothing.)

### Availability, before accuracy

| discriminator | stdin | MCP | Gateway | file argument |
|---|---|---|---|---|
| path extension | **absent** | **absent** | **absent** | present — and already decides correctly |
| executable bit | **absent** (no file) | **absent** | **absent** | present in principle |
| shebang | present | present | present | present |

Two of the three do not exist on the routes where the defect lives. That is Phase 4b's premise,
not an incidental gap. The extension is decisive on the one route where nothing is harmed: all
four destroyed shell scripts reduce **only** pathless.

The executable bit is additionally non-informative where it can be read at all: at the source
install on NTFS, `gettext.sh` tests `-x` true and **`env.sh` — one of the four files being
destroyed — tests `-x` false.**

### Shebang confusion matrix

| group | want | has shebang |
|---|---|---|
| 9 shell scripts | not markdown | **5 / 9** |
| 4 undetected `pip` files | not markdown | **0 / 4** |
| 25 real documents | markdown | **0 / 25** |

Zero false positives — no document in the negative set starts with `#!`. Recall is **5 of 13**
on the positives. And the distribution is adversarial in the way that matters:

```
MISS env.sh          376 ->  27   <-- deleted 99%
MISS tclConfig.sh   1898 ->  28   <-- deleted 99%
MISS tkConfig.sh    1052 ->  29   <-- deleted 99%
MISS git-prompt.sh  6454 -> 6454
```

**Of the four files actually being destroyed, the shebang catches one** (`vimspell.sh`). The
three it misses are sourced-not-executed shell — `env.sh`, `tclConfig.sh`, `tkConfig.sh` are
`.`-included config fragments, which is exactly why they carry no shebang, and exactly the
shape that survives whole-item elision at `S_k = 0.400`.

**Verdict: dead.** Perfect precision, useless recall on the harmed subset, and its two stronger
companions are unavailable by construction on every route that matters.

---

## 3. Lever 3 — the exact-0.400 cluster

### The population

16 item/route pairs land on exactly `0.400`, in two structurally opposite configurations:

| attractor | algebra | n | what it means |
|---|---|---|---|
| **A** | `R_AST = 1` (empty-set default), `R_struct = 0` | **14** | nothing was measured on one side; everything was destroyed on the other |
| **B** | `R_AST = 1/3`, `R_struct = 1` | **2** | exactly one third of symbols retained, structure intact — the code gate's own boundary (§18) |

`S_k = 1 − (0.6·R_AST + 0.4·R_struct)` gives `0.400` for both. One scalar, two opposite
situations, and `>` versus `>=` decides them together.

Not all 16 are decided by the boundary: `ARCHITECTURE.md` and `bench_evaluator.ts` sit at
`0.400` and fall back on **constraint-preservation**, not drift. The boundary actually decides
**7**.

### What flipping the inequality would do (computed, not implemented)

7 currently-passing items would fall back, giving back **5,080 cl100k tokens**:

```
shell  env.sh                                  stdin     376 ->  27
shell  tclConfig.sh                            stdin    1898 ->  28
shell  tkConfig.sh                             stdin    1052 ->  29
shell  vimspell.sh                             stdin     457 ->  29
prose  CODE_OF_CONDUCT.md                      stdin     621 ->  28
prose  SECURITY.md                             stdin     220 ->  28
ts     stages_cleanup_constraint-preservation.ts  filearg   851 -> 226
```

The last row is the cost: a **legitimate sub-item code elision on the file-argument route**,
at `R_AST` exactly `1/3`, killed to stop four shell scripts on a route it has nothing to do
with. Flipping is not free and is not proposed.

### What an explicit code gate would have to state

Four things, and the fourth is why the inequality is currently load-bearing:

1. **That the comparison applies only to a measured quantity.** Attractor A reaches the
   threshold carrying `R_AST = 1` as an *empty-set default*, not a measurement. §28 established
   this for validator-covered items and stopped there; every one of the 14 is outside that
   scope.
2. **That for code `R_struct` is pinned at `1.0`** (§18 — the only marker is `filepath:`, which
   elision cannot destroy), so for code the gate reduces exactly to `R_AST ≥ 1/3`.
3. **That "one third" is a chosen retention policy, not an artifact.** It is currently the
   arithmetic consequence of `w_AST = 0.6`, `w_struct = 0.4` and `threshold = 0.40`, none of
   which was picked to mean "keep a third of the symbols". Whether retaining exactly one third
   is acceptable is a real question that `>` answers "yes" by direction rather than by decision.
4. **That the two attractors need different verdicts** — which a single scalar cannot express.
   An explicit gate is therefore *two* gates: a measurement gate and a retention gate. `>` vs
   `>=` stops being a decision only once they are separated.

### What it would change on the corpus

**As a restatement, nothing — inert.** Points 2–4 are documentation of behaviour that already
holds. Point 1 is the only one with teeth, and enforcing it removes the 14 attractor-A items
from the comparison entirely, routing them to the unmeasurable branch. That is §28's rule
extended past validator-covered items — **the deferred question, reached from the arithmetic
instead of from the classifier.**

**Verdict: not dead, and the only lever that survives.** But its terminus is the deferral, not
an alternative to it.

---

## 4. Findings

1. **§32 stands.** Two of three levers are dead on measurement — lever 1 because the harmed and
   intended cases are trace-identical at the point of decision *and* it stops the Gateway
   product; lever 2 because it misses three of the four destroyed files and its stronger
   companions do not exist on pathless routes. The third confirms the deferral rather than
   avoiding it.
2. **§32's wording needs one correction.** It says the only identified fix is a
   `looksLikeMarkdown` change. Three fixes are identified. Two are worse than the deferral and
   one *is* the deferral, so the conclusion holds — but "only identified fix" should read "only
   fix that does not either destroy the Gateway or reduce to §28's open question".
3. **The 4b.3 stdin denominator was 132 and should be 144.** The A/B loop globbed
   `corpus-prose/*` at top level, covering 13 of 25 markdown files. Re-run over all 25:
   **0 changed.** The inert conclusion is unaffected; the number was understated.
4. **The characterization test is a passing spec, not a pending one** (§0). Its status should be
   made structural rather than nominal.
5. **A new datum for whoever takes up §28's question.** The prose casualties of lever 1 —
   `CODE_OF_CONDUCT.md` at 97.9% and `SECURITY.md` at 93.8%, both at `S_k = 0.400`, both
   `fallbackUsed: false` — are not a separate population from the shell scripts. They are the
   same trace. Any rule that saves `tclConfig.sh` and spares them has to distinguish them by
   something no current field carries.
