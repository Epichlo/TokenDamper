# Retired documents

Audit **M11**. These files were removed from the working tree because their conclusions already
live in `DECISIONS.md`, `CHANGELOG.md` or `docs/audit-remediation-status.md`, and maintaining a
second copy of an argument is how the two drift apart.

**Nothing is lost.** Git keeps every one of them. To read any file as it stood at retirement:

```bash
git log --diff-filter=D --format=%H -1 -- docs/phase-1d-drift-investigation.md
```

then `git show <sha>^:docs/phase-1d-drift-investigation.md`, or in one step:

```bash
git show "$(git rev-list -1 HEAD -- docs/phase-1d-drift-investigation.md)^:docs/phase-1d-drift-investigation.md"
```

Source comments that cite a retired document keep the citation and mark it `(retired)`. The
citation is still meaningful — it names a document and section that existed, and the command
above retrieves it.

---

## What each held, and where the conclusion lives now

| Retired file | What it was | Conclusion now in |
|---|---|---|
| `docs/phase-0-measurement-baseline.md` | The frozen-corpus baseline and the Seam 2 measurement | DECISIONS §33–§34; `docs/audit-remediation-status.md` §2 |
| `docs/phase-1-stabilization-summary.md` | Phase 1.0 / Issue 2 summary report | DECISIONS §16, §22–§23; CLAUDE.md invariant 8 |
| `docs/phase-1d-drift-investigation.md` | Diagnostic record for the drift gate; the `S_k = 0.60` formula constant | DECISIONS §19, §28, §40; CLAUDE.md's Issue 3 entry |
| `docs/phase-1d-granularity-design.md` | Design proposal for sub-item hashing granularity | Implemented; DECISIONS §43 and `core/elision/regions.ts` |
| `docs/phase-1d-semantic-gate-disposition.md` | Disposition of the semantic gate's precondition (a) | DECISIONS §42; `core/constraints/directives.ts` |
| `docs/phase-4b-lever-disposition.md` | Measurement of three proposed levers against §32 | DECISIONS §33–§34, §40 |
| `docs/phase-4b-pathless-code-scope.md` | Scope of pathless code being invisible to validators | DECISIONS §29, §31; CLAUDE.md's Issue 2 entry |
| `docs/issue-2-content-type-contract-design.md` | The content-type contract design proposal | Implemented; DECISIONS §22–§23, §45 |
| `NOTES-FOR-DOCS.md` | Corrections to planning docs, recorded rather than edited in place | Folded into the documents they corrected |
| `tokendamper-headroom-known-issues.md` | The TokenDamper-vs-Headroom benchmark issue list | CLAUDE.md "Known bugs"; `docs/audit-remediation-status.md` |
| `study.md` | Onboarding guide for new contributors | `README.md` and `CLAUDE.md` |
| `purposed architecture changes.md` | Proposed architecture changes (pre-audit) | DECISIONS §22–§23, §35, §45 |

---

## Why the ratio argument was weaker than it looked

M11 was raised as a **4.1 : 1** documentation-to-code ratio (528 KB markdown against 127 KB of
`src/`). Measured immediately before this cleanup, it was **1.40 : 1** — and the improvement was
not real. Markdown had *grown* to 726 KB; `src/` had grown faster, to 518 KB.

More to the point, **32.8% of `src/` is comment prose** (165 KB of 518 KB, 2,972 of 12,607
non-blank lines). Counting that honestly, prose ran about **2.6 : 1** against code. The volume
did not shrink on its own; some of it moved into the source files, where it is at least adjacent
to what it describes.

This retirement removes ~230 KB of narrative. The in-source commentary is deliberately left
alone: it is the part that sits next to the code it explains and is maintained with it.
