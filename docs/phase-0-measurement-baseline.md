# Phase 0 — Measurement Baseline, and Seam 2 Measured

> **Date:** 2026-08-06 · **Status: harness landed, corpus frozen, seam 2 measured.**
> No engine change. Engine: `dist` built from `2df850d`, tree dirty with the harness itself
> (recorded as `dirty: true` in the manifest — this is an instrumented run, not a release
> baseline). Corpus: 289 files under `sha256` manifest, 578 CLI runs, 0 failures.
> Tokens are the **engine estimator** throughout, because every figure here comes from a CLI
> trace; `cl100k` aggregates are not quoted.
>
> **Headline: seam 2 is not dead. It is the best-separating lever measured so far** — 114 code
> files misclassified as markdown drop to 12, with **zero** prose casualties. DECISIONS §32
> deferred on the assumption that a classifier change carries blast radius over prose. Measured,
> it does not.
>
> **Second headline, unplanned: §32 is not a pathless-route defect.** It reaches the file
> argument, and the worst case found is 57,037 → 19 tokens on a file passed by name.

---

## 1. What landed

`tools/corpus-harness/` — `collect.js` (freeze + pin), `measure.js` (verify + run both routes +
dump traces), `seam2.js` (this note's analysis), `recipe.json`, `README.md`.

The guarantees it adds are in the README. The two that already paid for themselves:

- **Asserted bucket counts.** The first collection run reported three mismatches immediately.
  One was real (see §2), two were my recipe being wrong about this machine.
- **A pin that shows dirt.** Every run records the commit, a hash over all 116 `dist/**/*.js`,
  and whether the tree was dirty.

## 2. The corpus, and a near-miss worth recording

289 files, nine buckets, chosen so the population Phase A actually tests is present rather
than assumed:

| bucket | n | extension in `isCodeExtension`? | AST-lite covers it? |
|---|---|---|---|
| shell `.sh` | 40 | yes | no |
| perl `.pl` | 40 | **no** | no |
| tcl `.tcl` | 40 | **no** | no |
| c `.c/.h` | 30 | yes | no |
| rust `.rs` | 3 | yes | no |
| css `.css` | 10 | yes | no |
| python `.py` | 45 | yes | **yes** |
| typescript `.ts` | 56 | yes | **yes** |
| prose `.md` | 25 | — | n/a (negative set) |

No Ruby, Go, SQL or Java exist on this machine; Perl and Tcl replace them and turn out to be
the more interesting cases anyway (§3). The TypeScript bucket is **56, not the 64** quoted in
`docs/phase-4b-*.md` — a 1 KB floor excludes eight sources — so aggregates here are not
directly comparable to those documents.

**The near-miss.** Selection is "sort by path, take the first N", which is deterministic and
was silently wrong: `.agents/` sorts before everything, so the first run filled all 40 prose
slots with prior agent scratchpads and selected **zero** hand-written documents. The prose
bucket is the negative set the entire seam-2 question rests on. Deterministic is not
representative, and the failure is invisible unless you look at what a bucket caught.

## 3. Baseline

`--target-reduction-ratio 0.3`, both routes, all 289 files.

| bucket | route | n | reduce | fallback | ast=0 | drift `measured:true` | saved% |
|---|---|---|---|---|---|---|---|
| shell | file | 40 | 0 | 40 | 0 | 15 | 0.00% |
| shell | stdin | 40 | 20 | 20 | **40** | 40 | 17.28% |
| perl | file | 40 | **34** | 6 | **40** | 13 | **81.91%** |
| perl | stdin | 40 | **34** | 6 | **40** | 13 | **81.91%** |
| tcl | file | 40 | 9 | 31 | **40** | 40 | 3.95% |
| tcl | stdin | 40 | 9 | 31 | **40** | 40 | 3.95% |
| c | file | 30 | 0 | 30 | 0 | 28 | 0.00% |
| c | stdin | 30 | 2 | 28 | 30 | 28 | 0.80% |
| rust | file | 3 | 3 | 0 | 0 | 3 | 21.40% |
| rust | stdin | 3 | 0 | 3 | 3 | 3 | 0.00% |
| css | file | 10 | 3 | 7 | 0 | 3 | 9.58% |
| css | stdin | 10 | 6 | 4 | 10 | 3 | 11.13% |
| python | file | 45 | 22 | 23 | 0 | 45 | 14.98% |
| python | stdin | 45 | 21 | 24 | 3 | 45 | 14.88% |
| typescript | file | 56 | 21 | 35 | 0 | 56 | 14.13% |
| typescript | stdin | 56 | 0 | 56 | **56** | 56 | 0.00% |
| prose | file | 25 | 2 | 23 | 25 | 25 | 0.85% |
| prose | stdin | 25 | 2 | 23 | 25 | 25 | 0.85% |

Where this corpus overlaps prior work it reproduces it: TypeScript over stdin reduces nothing
and is wholly uncovered (§29's case for `--language`), Python's two routes are near-identical
(4b.2's probe working), and exactly two prose files reduce over stdin (the lever-disposition's
`CODE_OF_CONDUCT.md` / `SECURITY.md` pair).

## 4. Finding — §32 reaches the file-argument route

`isCodeExtension` lists 19 extensions. `.pl` and `.tcl` are not among them, so a Perl or Tcl
file **passed by name** falls past every extension branch into the content probes and is
classified `markdown` on both routes:

```
shell  file:{"contentType":"code"}      stdin:{"contentType":"markdown"}
rust   file:{"contentType":"code"}      stdin:{"contentType":"text"}
perl   file:{"contentType":"markdown"}  stdin:{"contentType":"markdown"}
tcl    file:{"contentType":"markdown"}  stdin:{"contentType":"markdown"}
prose  file:{"contentType":"markdown"}  stdin:{"contentType":"markdown"}
```

§32, the scope document and CLAUDE.md all frame this as a defect of the pathless routes, with
"the file route refuses it" as the reassuring half. For any language whose extension is not in
that list, there is no reassuring half. The route is not the variable; **membership of a
hardcoded list of 19 extensions** is.

## 5. Finding — the two defect shapes separate cleanly, and Perl carries both

| bucket/route | classified `markdown` | of those, `measured:true` | classified `text` | of those, `measured:true` | reduced |
|---|---|---|---|---|---|
| perl / file | 13 | **13** | 27 | 0 | 7 md + **27 text** |
| perl / stdin | 13 | **13** | 27 | 0 | 7 md + **27 text** |
| tcl / file | 40 | 40 | 0 | — | 9 |
| shell / stdin | 40 | 40 | 0 | — | 20 |

Two distinct failures, and Perl is the first corpus member to exhibit both at once:

- **The §32 shape** (13 files): classified `markdown`, `#` comments harvested as headings,
  drift reports `measured: true` on fabricated evidence.
- **The §28 shape** (27 files): classified `text`, no markers, no validator, drift honestly
  reports `measured: false` — **and the item reduces anyway**, because §28 reports rather than
  enforces outside validator-covered items.

The worst case is the second shape, on the file route:

```
Unicode_Collate_Locale_ja.pl   57,037 -> 19 tokens (100.0%)   fallbackUsed false
  contentType text   astCoverage.checked 0   driftScore 0   driftCoverage.measured false
```

A 57,037-token file deleted whole, by name, with every reporting field correctly saying that
nothing checked it. §32's `tclConfig.sh` (1,877 → 19) is the same defect two orders of
magnitude smaller. Nothing here is lying; nothing here is stopping it either.

## 6. Finding — seam 2 measures viable

Ground truth: the 264 code-bucket files must not be `markdown`; the 25 prose files must be.
The candidates are **shape** discriminators, not count thresholds — the disposition already
established that counts point the wrong way (`tclConfig.sh` 79 markers vs
`CODE_OF_CONDUCT.md` 12).

| candidate | code → markdown (of 264) | prose → markdown (of 25) |
|---|---|---|
| V0 — what ships | **114** | 25 |
| V1 — require a non-`#` marker | 11 | **24** ← loses `CODE_OF_CONDUCT.md` |
| **V2 — V1, with the list regex repaired** | **12** | **25** |
| V3 — a heading needs corroboration | 12 | 25 |
| V4 — any two distinct signals | **7** | **25** |

**V2 and V4 both hold all 25 prose files while removing ~90% of the misclassification.**
V4 separates best; V2 is the smaller change. Neither has a prose casualty.

Residual leaks under V2 are honest rather than spurious — two shell scripts with `- ` lists,
three Tcl files whose `[...]` command syntax matches the markdown link regex, four pip files,
and three of this repo's own TypeScript sources whose doc comments genuinely contain fenced
markdown.

**This contradicts the premise §32 deferred on.** §32 seam 2: *"could require more than one `#`
line, but that is a classifier change with blast radius over every prose item"*. The measured
blast radius over prose is **zero files** — because the fix is not a count threshold, which is
the form §32 imagined and the form the disposition separately proved wrong.

## 7. Finding — the shipped list regex does not match markdown lists

`RE_LIST` is `/(^|\n)(- |\* |\d+\.)\s+\S/`. The alternation already consumes the space after
`-`, and `\s+` then demands another one:

```
"- item"    shipped false   fixed true
"-  item"   shipped true    fixed true
"* item"    shipped false   fixed true
"1. item"   shipped true    fixed true
```

So `- item` and `* item` — the two commonest list forms — do not match, and only ordered lists
and double-spaced bullets do. Measured, 21 of 25 prose files trip the shipped rule against
25 of 25 under the repair. This is why V1 loses `CODE_OF_CONDUCT.md` and V2 does not: V1 leans
on a rule that half-works.

Not fixed here. It is a one-character class of change with a real blast radius on
classification, and it belongs to whoever implements the seam, measured under this harness.

## 8. What this changes for Phase A

1. **Seam 2 is back on the table and should be measured against seam 3, not assumed worse than
   it.** It is cheap, it is the only lever with a measured zero-cost negative set, and it
   attacks the fabrication at its source rather than compensating downstream.
2. **It is a mitigation, not the fix.** V2/V4 would convert the 13 `markdown`-shaped Perl files
   into `text`-shaped ones — moving them from the §32 defect to the §28 defect, where they
   still reduce unwitnessed. `Unicode_Collate_Locale_ja.pl` is already `text` and a classifier
   change does not touch it. **Seam 3 remains load-bearing.**
3. **Phase A's population is bigger than "pathless".** The file route needs measuring for every
   language outside those 19 extensions, and the `astCoverage` reassurance in CLAUDE.md's
   invariant 10 entry should be re-read with §4 in hand.
4. **`isCodeExtension` is itself a finding.** A hardcoded 19-entry list decides whether a real
   source file is checked at all, and `.pl`/`.tcl`/`.rb`/`.lua`/`.r`/`.swift`/`.kt` are outside
   it.

## 9. Correction owed to earlier documents

- `docs/phase-4b-pathless-code-scope.md` §1 ("The CLI file argument is the only route that
  works") and CLAUDE.md's Phase 4b.2 note ("the file route refuses it") are true for Python and
  false in general. Both should say *the file route works for extensions in
  `isCodeExtension`*.
- DECISIONS §32's seam-2 sentence should record that the seam was measured on 2026-08-06 and
  that its blast radius over prose is zero under a shape discriminator, against 114 → 12 on
  code.
