---
name: widen-language
description: How to add a new language to TokenDamper's elision path — the measured order is extractSymbols, then the validator, then the region scanner, and doing it in the obvious order instead creates silent unmeasured data loss. Use this skill whenever the task involves making Go, Java, C, C++, Rust, Ruby, Swift, Kotlin or any non-TypeScript/Python language reduce; whenever someone proposes writing a region scanner or brace-span selector for a new language; whenever extractSymbols, selectValidator, REGION_ELISION_LANGUAGES or supportsRegionElision are being edited; and whenever a language is reported at 0.00% and the fix is assumed to be "add a scanner". Triggers on: widen elision, new language support, region scanner, language coverage, H2, 3 of 17 languages, why is Go 0%.
---

# Adding a language to the elision path

Elision reduces TypeScript, JavaScript and Python. Everything else is 0.00%. Widening it is the
largest measured gain available (DECISIONS §56), and it is the one place in this codebase where
doing the work in the intuitive order produces **silent data loss that every gate reports as
green**.

## Three gates, not one

`supportsRegionElision` is one function, which makes this look like a one-line change. It is not.

```
selectValidator(item)          -> a validator with a .language, or null
  └─ regionElisionLanguage     -> that language, if it is in REGION_ELISION_LANGUAGES
       └─ selectElisionRegions -> [] unless a scanner exists for it

DriftTracker.extractSymbols    -> independent of all of the above
```

`extractSymbols` is regex over `item.content` and does **not** consult the validator. That
independence is the whole hazard below.

## The order, and why the obvious one is wrong

**1. `extractSymbols` first.** Add function/type declaration patterns for the language.

**2. Then the validator**, so `selectValidator` returns a `.language` for the item.

**3. Then `REGION_ELISION_LANGUAGES` + the region scanner.**

The docs used to say that shipping the scanner alone converts a 0% into a fallback via §33's
measurement gate — a safe, visible failure. **Measured, that is false for real source files**
(DECISIONS §56):

| case | symbolsBefore | S_k | astMeasured | measurementGate | fallback |
|---|---|---|---|---|---|
| Go **with** `struct`/`import` | `type:Point, import:fmt` | 0.0000 | **true** | **pass** | **false** |
| Go **without** either | *(none)* | 0.0000 | false | refuse | true |

`extractSymbols` harvests **no function symbols at all** for Go, C, Java or Rust. `type:Point`
comes from `struct` being an alternative in the TypeScript class regex; `import:fmt` from the
import regex. Both **survive body elision by construction**, because signatures are always
retained. So on any file with a struct, class or import — which is nearly all real source — the
drift gate passes with `astMeasured: true` while having witnessed nothing. Every function body in
the file could be deleted and `S_k` stays `0.0000`.

This is C1's shape one step over, and **§33 does not cover it**. §33 closed *"the before-set is
empty, so `R_AST` defaults to 1.0"*. This is the sibling: the before-set is non-empty but
**structurally incapable of registering the loss**. The gate asks whether evidence existed, not
whether the evidence could witness this particular transform.

So: scanner-first is not a visible zero. It is unmeasured elision on the CLI, where elision is
irreversible.

## The negative control at step 1

After `extractSymbols` alone, before any scanner exists:

- reduction stays **0.00%** on every bucket — nothing can elide yet
- drift on a **hand-elided** file of that language becomes **non-zero** — the symbols are now
  visible

If reduction moved, the change reached something it should not have. If drift is still 0.0000 on
a hand-elided file, the patterns are not matching and step 3 would be unmeasured.

Watch for the reverse blast radius too: a C-style `int foo(...)` pattern can match TypeScript or
Python content and shift drift scores on files that already reduce. Run the per-row A/B (see the
`measure-corpus` skill) — this step should be byte-identical everywhere.

## Validate the instrument before believing the result

Any scanner or symbol extractor needs its own known-answer tests **before** its output is used to
justify anything. For a brace-span scanner that means at minimum: the language's raw/multi-line
string form, both comment forms, a declaration with no body (interface method, prototype, `func`
type), a nested closure counted once, and a brace inside a string literal.

§56's Go ceiling was only trustworthy because the scanner passed 12/12 such cases first. A scanner
that silently misses bodies understates the ceiling and can kill a feature on a false negative.

## Picking the language

Judge by how cleanly the header discriminator lands, not by corpus file counts:

- **Go** — `func` is unambiguous; no preprocessor, no header/impl split; gofmt makes formatting
  uniform. Measured ceiling **55–65%** of bytes against TypeScript's 57.78%, projecting to
  **23–28%** achieved. This is the recommended first language.
- **C/C++** — `int foo(...)` is ambiguous between prototype and definition, and the preprocessor
  sits above the grammar. Worst first choice despite having corpus files.
- **Java/C#** — brace languages with clear modifiers; plausible second.

`FUNCTION_HEADER` in `elision/regions.ts` is a *shape* test (ends in `)`) because JavaScript has
several ways to declare a function. A language with a keyword should use the keyword — that is
cheaper and more precise, and it is most of why Go is first.

## What is still unmeasured

The 23–28% projection borrows TypeScript's conversion from ceiling to achieved, which embeds
**TypeScript's** fallback rate. The new language's own fallback rate cannot be known until steps 1
and 2 exist. Expect `CONSTRAINT_DIRECTIVE_LOST` to behave differently — this repo's TS is 32.8%
comment prose and most codebases are not.

**Test files may be the larger prize.** In the Go application corpus `_test.go` is 53 MB against
36 MB of source, at 92.22% elidable. Nothing in this project has been counting them; check the
equivalent for any language you add.

## Before opening the PR

- new tests fail against the **unfixed** engine (stash `src/`, re-run) — and the ones that pass
  both ways are your negative controls, which is fine as long as you know which is which
- per-row A/B over one frozen corpus, row count asserted
- `trace.languageSupport` reports the new language as supported
- DECISIONS entry with the measurement, including what it does not establish
