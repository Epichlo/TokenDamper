# TokenDamper vs Headroom Benchmark — Known Issues (context for Claude Code)

## Project summary
Benchmarking two LLM context/token compression engines — **TokenDamper** (this repo,
TypeScript, CLI) and **Headroom** (third-party Python package) — using a harness at
`tokendamper-benchmark/run_benchmark.py`. The goal is a fair, apples-to-apples comparison
of reduction % and latency across static single-file payloads and a synthetic multi-turn
agent session.

Repo entry points relevant to this work:
- `tokendamper-benchmark/run_benchmark.py` — the benchmark harness
- `src/core/planner/index.ts` — TokenDamper's planner (decides `pass_through` vs
  `topology_knapsack` mode based on whether a budget/ratio is supplied)
- `src/core/validation/index.ts` — runs `DriftTracker`, enforces semantic drift ≤ 0.40,
  issues `SEMANTIC_DRIFT_EXCEEDED` and forces fallback if exceeded
- `docs/v1_deployment_audit.md` — documents a now-fixed bug where `emittedOutput` used to
  always return raw input regardless of what the engine computed (confirmed already fixed
  in current `fallback/index.ts`, which now returns the rendered `currentBundle`)
- `test_data/session.json` — new 7-turn synthetic agent session fixture (added to test
  cross-turn dedup / delta compression, which single-file payloads don't exercise)

---

## Issue 1 — Harness gave neither engine a compression target (FIXED)
**Symptom:** Both TokenDamper and Headroom showed 0% reduction on every payload.

**Root cause:**
- `run_tokendamper()` called `subprocess.run([cmd, "optimize", "-"], ...)` with no
  `--max-input-tokens` / `--target-reduction-ratio` flag. Per `src/core/planner/index.ts`,
  no budget → `isKnapsackMode = false` → mode = `pass_through` → `stageIds` stays an empty
  array → zero optimization stages ever run. Guaranteed 0% regardless of input.
- `run_headroom()` called `headroom_compress(messages)` with no target/budget argument, and
  wrapped every payload as a bare `{"role": "user", "content": text}` turn regardless of
  what the payload actually represented (tool output vs. live user prompt).

**Fix applied:**
- TokenDamper now called with `--target-reduction-ratio 0.3`. **Correction (re-verified):**
  this flag alone was not sufficient to fix the harness. `isKnapsackMode` in
  `src/core/planner/index.ts` originally only tripped on `budget.maxInputTokens`, so a
  `--target-reduction-ratio`-only budget was silently inert — it still resolved to
  `pass_through` mode with zero stages, regardless of the flag. A planner code change
  (adding `targetReductionRatio > 0` as a second trigger for knapsack mode) was also
  required before this flag had any effect. See `CLAUDE.md` Known bugs.
- Headroom now called with `target_ratio=0.7` (keep 70%), `protect_recent=0`,
  `compress_user_messages=True`.
- Tool-output-shaped payloads (`tool_output.json`, `codebase.py`, etc.) are now wrapped as
  `{"role": "tool", "tool_call_id": "...", "content": raw_text}` for Headroom instead of
  `role: "user"`.
- `target_tokens` is explicitly computed and printed per payload so both engines are held
  to the same bar.
- TokenDamper's stderr trace (`result.trace`) is now parsed and logged: `planMode`,
  `stageCount`, `tokenBefore`, `tokenAfter`, `fallbackUsed`, `fallbackReason`.
- Added `test_data/session.json`, a multi-turn fixture, since single static files don't
  exercise either engine's actual differentiators (cross-turn dedup, delta compression,
  live-zone/session compression).
- Latency column now flagged as non-equivalent: TokenDamper is timed via
  `subprocess.run()` (Node process spawn), Headroom via an in-process Python call.

**Status:** Harness fix confirmed working — it now surfaces real engine behavior instead
of a config artifact. The issues below are what showed up *after* this fix.

---

## Issue 2 — TokenDamper's own hash placeholders break its own JSON/AST validator (BUG, unresolved)
**Symptom:** On `tool_output.json` and `session.json`, TokenDamper falls back to 0% (or
worse) reduction with trace reason:
```
AST Error... JSON Syntax Error: Unexpected token '<', "<BLOCK_HAS"... is not valid JSON
```

**Root cause (as observed):** The `compression:token-hashing` stage substitutes large
strings with `<BLOCK_HASH:sha256>`-style placeholders. The validation pipeline then runs an
AST/JSON syntax check on the *compressed* output and correctly finds `<BLOCK_HASH:...>` is
not valid JSON — because token-hashing wrote a non-JSON-safe placeholder into JSON content.
The pipeline then aborts and falls back to raw input.

**Why this matters:** This is not a legitimate safety abort (unlike Issue 3 below) — it's
TokenDamper's own compression stage producing output that its own validation stage
necessarily rejects, for structured-data payloads. This will 0%-fail on **any** JSON-shaped
payload run through token-hashing.

**Questions for Claude Code to investigate:**
- Does `compression:token-hashing` have any content-type awareness (JSON/code vs prose)?
  If not, should it skip structured-data payloads, or use a placeholder format that
  round-trips as valid JSON (e.g. a quoted string token instead of a bare `<...>` tag)?
- Is there a config flag to make the hashing stage JSON-safe, or does this need a code fix
  in the hashing stage itself?

**Update (re-verified) — co-occurs with Issue 3:** On `tool_output.json` and `session.json`,
the actual `fallbackReason` is not the JSON-AST error in isolation. The trace reports the
JSON-AST error *and* the Issue 3 semantic-drift breach (`0.60 > 0.40`) together, concatenated
in a single fallback reason. These are two failures co-occurring on the same payload, not two
independent single-cause failures on separate payloads. See Issue 3.

---

## Issue 3 — Semantic drift fallback on code (plausibly legitimate, needs confirmation)
**Symptom:** On `codebase.py`, TokenDamper falls back with:
```
Semantic drift metric (0.60) exceeds maximum threshold (0.40).
```

**Context:** `src/core/validation/index.ts` enforces drift ≤ 0.40 (see also lines ~2660,
2770, 2875, 2908 in the consolidated source). Headroom independently chose `router:noop`
on the same file (0% reduction), so both engines agree this file shouldn't be aggressively
compressed — this is weaker evidence of a bug and more likely correct conservative
behavior on source code. Worth confirming intent rather than treating as broken.

**Update (re-verified) — the Headroom corroboration above is no longer supported:** On
re-run, Headroom did not independently choose `router:noop` on `codebase.py`. It instead hit
a 20-second `ContentRouter` single-cache-miss timeout and failed open to passthrough (the
`kompress` ML model was not downloaded/ready; `HEADROOM_DETECT_BACKEND=rust` was active for
this run, skipping the ML path entirely — see Issue 6). Same 0% output, different mechanism.
That is not an independent second opinion, and the reasoning above should not be cited as
settled on that basis. The drift abort on `codebase.py` may still be correct behavior — the
evidence for it just isn't there anymore. Needs a re-run with Headroom's ML backend actually
available (not `HEADROOM_DETECT_BACKEND=rust`) before this corroboration can be trusted again.

**Update (re-verified) — not isolated to `codebase.py`:** the same `0.60 > 0.40` drift breach
also fires on `tool_output.json` and `session.json`, co-occurring there with the Issue 2
JSON-AST error in a single combined `fallbackReason`. See Issue 2.

---

## Issue 4 — Constraint-preservation correctly protected a planted "secret" (not a bug, confirms feature works)
**Symptom:** On `sample_logs.txt`, TokenDamper aborted (0% reduction) with a
`constraint-preservation` fallback after detecting an imperative-tagged line (a synthetic
`Secret Key: "BLUE-PANDA-992"` line planted specifically to test this).

**Status:** This is TokenDamper working as intended — it refused to silently drop a line
it flagged as a hard constraint. Not a bug. (Note: `BLUE-PANDA-992` is a fake string
generated purely for this benchmark, not a real credential — no leak occurred.)

---

## Issue 5 — Fallback path returns a different byte size than the original (-1.39%, unresolved)
**Symptom:** On `session.json`, TokenDamper's fallback shows **-1.39%** reduction (i.e. the
"compressed" output is *larger* than the original), not 0%.

**Why this is odd:** A fallback is supposed to return the original payload unchanged
(0% reduction), not a modified/larger one. Something in the fallback path is
re-serializing, reformatting, or otherwise mutating the payload before emitting it.

**Questions for Claude Code to investigate:**
- Diff the exact bytes: original `session.json` vs. the emitted fallback output.
- Check whether `fallback/index.ts` (or whatever renders `currentBundle` on fallback) is
  re-stringifying JSON with different whitespace/key order, or appending metadata/trace
  info to the emitted payload instead of returning the untouched raw input.

---

## Issue 6 — Headroom's `target_ratio` is a soft hint, not an enforced budget
**Symptom:** Against a 30% target reduction, Headroom actually produced:
- `sample_logs.txt`: 18.15%
- `tool_output.json`: 34.36%
- `codebase.py`: 0.00% (`router:noop`)
- `session.json`: 87.92%

None of these hit the 30% target — Headroom's heuristic engines (SmartCrusher,
CacheAligner, its `router:mixed:*` transforms) treat `target_ratio` as guidance, not a
hard constraint the way TokenDamper's `--target-reduction-ratio` is meant to be.

**Why this matters for the benchmark:** Any headline claim like "Headroom achieves X%
reduction" needs the caveat that it isn't reliably steerable to a specified target — this
is the same kind of disclosure gap the original 0%-reduction investigation was trying to
surface for TokenDamper.

**Note:** This run also used `HEADROOM_DETECT_BACKEND=rust` because of a Windows/ONNX
backend issue for Headroom's ML components — Headroom skipped its ML-based `kompress`
compression and only ran heuristic engines. Any future run should confirm whether the ML
backend changes these numbers, and note which backend was active in the report.

---

## Open items / suggested next steps for Claude Code
1. Fix or work around the `<BLOCK_HASH>` vs JSON-validator conflict (Issue 2) — this is
   the highest-impact bug since it silently defeats TokenDamper on all structured-data
   payloads.
2. Root-cause the -1.39% fallback size anomaly (Issue 5) with a byte-level diff.
3. Decide whether the `codebase.py` semantic-drift abort (Issue 3) is correct behavior or
   an overly conservative threshold — may need a code-specific drift threshold rather than
   one shared with prose/logs.
4. Re-test Headroom with the ONNX/ML backend working (not `HEADROOM_DETECT_BACKEND=rust`)
   to see if reduction numbers or target-adherence change.
5. Consider whether Headroom exposes any *hard* budget/enforcement parameter (vs. the
   soft `target_ratio` hint) and re-run with it if so, to get a genuinely comparable
   "does it hit the target" number against TokenDamper.
