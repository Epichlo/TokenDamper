# TokenDamper Study Guide & Onboarding Document

Welcome to **TokenDamper**! This document is designed for new developers joining the project. It provides the complete context of what the engine is, what has been happening in development up until now, how the architecture works, the mathematics powering it, and its current safety boundaries and vulnerabilities.

---

## 1. What is TokenDamper?

**TokenDamper** is a universal context optimization engine for AI coding assistants. When users send massive context bundles (prompts, entire codebases, file diffs, log files) to an LLM, it costs a lot of money and slows down response times.

TokenDamper sits in the middle (as a CLI, local Gateway HTTP proxy, or MCP server) and aggressively but *safely* compresses this context before it hits the LLM. It guarantees correctness and semantics while reducing token usage and latency.

### How it differs from other compressors (e.g., Headroom)
- **Headroom** largely relies on Machine Learning models (like the `kompress` model) to heuristically summarize and squash text, backed by SmartCrusher and CacheAligner algorithms. If the ML model isn't available, it falls back to basic structural dedup.
- **TokenDamper** is strictly **deterministic and mathematical**. It doesn't use an ML model to guess what to compress. Instead, it uses a Topology-Aware **0/1 Knapsack algorithm** to pack the most valuable context into a strict budget, reversible **SHA-256 Token Hashing** to deduplicate cross-turn sessions, and **Myers Diff** to send only changed lines. TokenDamper heavily prioritizes **safety** over aggressive compression.

---

## 2. Context: What's Happening Right Now?

We recently built and ran a full benchmark suite comparing TokenDamper against Headroom using realistic enterprise payloads (`sample_logs.txt`, `tool_output.json`, `codebase.py`, and a multi-turn `session.json`). Both engines were given a strict **30% token reduction target**.

### The Benchmark Discovery
Initially, the benchmark harness had a bug where the budget wasn't explicitly passed down, causing both engines to default to 0% reduction (Pass-Through mode). We fixed the `isKnapsackMode` trigger in TokenDamper's `src/core/planner/index.ts` and rebuilt the engine.

Once the budget was enforced, we discovered exactly how strict TokenDamper's safety boundaries are. In the benchmark, TokenDamper yielded a **0% reduction** on several files because it triggered **explicit safety fallbacks**:
1. **Constraint Loss**: While trying to compress `sample_logs.txt`, TokenDamper dropped a line containing a simulated secret key (`BLUE-PANDA-992`). The Validation stage caught this constraint loss and forced a fallback to the original payload to prevent data corruption.
2. **JSON AST Corruption**: For `tool_output.json` and `session.json`, the TokenHasher stage replaced large duplicate blocks with `<BLOCK_HASH:sha256...>` placeholders. Because these payloads were JSON, inserting `<BLOCK_...` broke the JSON structure. The AST Validator caught the `Unexpected token '<'` syntax error and safely aborted compression.
3. **Semantic Drift Exceeded**: On `codebase.py`, the pruning was too aggressive, pushing the semantic drift metric (0.60) past the maximum allowed threshold (0.40).

This proved TokenDamper is extremely safe (it never sends corrupted data to the LLM), but currently struggles to achieve high compression ratios on JSON payloads due to its placeholder strategy.

---

## 3. High-Level Architecture

TokenDamper uses a strict, linear pipeline (No DAGs in MVP).

```text
Raw Input (JSON/Text)
  -> Adapter (CLI / HTTP Gateway / MCP)
  -> ContextBundle + OptimizationBudget
  -> Stateless 0/1 Knapsack Planner
  -> Linear Engine
      -> Session Deduplication (TokenHasher)
      -> Delta Compression (Myers Diff)
      -> Workspace Topology Pruning
  -> Validators (ConfidenceLedger, DebtTracker, DriftTracker)
  -> Fallback (if safety thresholds violated)
  -> Final Output (Optimized Context or Raw Input)
  -> Explainability Trace (stderr / JSON)
```

### Core Subsystems
1. **Core Data Model (`src/core/model`)**: Frozen domain objects like `OptimizationRequest`, `ContextBundle`, `OptimizationBudget`, and `StageResult`. Immutability is preferred.
2. **Planner (`src/core/planner`)**: Pure and stateless. It looks at the budget and context and picks an `OptimizationPlan` (e.g., triggering `topology_knapsack` mode if a `targetReductionRatio` is present).
3. **Linear Engine (`src/core/engine`)**: Executes the chosen stages in order.
4. **Validation & Fallback (`src/core/validation`, `src/core/fallback`)**: Pure validators that compare the "before" and "after" state. If it detects a broken AST or dropped constraints, it tells the engine to completely fallback to the original raw input.
5. **Adapters (`src/adapters`)**: Allow TokenDamper to run as a CLI tool (`tokendamper optimize`), a transparent LLM proxy (`tokendamper exec`), or a Claude Desktop/Cursor server (`tokendamper mcp`).

---

## 4. The Mathematics & Processes

### 1. 0/1 Knapsack Planning
When a budget constraint is applied (`maxInputTokens` or `targetReductionRatio`), the planner treats context optimization as a **0/1 Knapsack Problem**.
- **Items**: Each file, function, or chat message is an item.
- **Weight**: The token count of the item.
- **Value**: A heuristic score assigned to the item based on its relevance (e.g., recent messages have high value, large unchanged files have lower value).
- **Goal**: Maximize the total value without exceeding the token weight budget.

### 2. Myers Diff (Delta Compression)
Instead of sending an entire modified file to the LLM again, TokenDamper computes the difference between the previously cached file and the new file using the deterministic **Myers Diff** algorithm. It then sends only the changed lines (the diff), saving massive amounts of tokens.

### 3. Token Hashing (Session Deduplication)
If a massive block of text has been sent to the LLM previously, the `TokenHasher` stage replaces that chunk with a tiny placeholder: `<BLOCK_HASH:sha256-hash-here>`. When the LLM responds, or if it needs to be restored, TokenDamper rehydrates the original content.

### 4. Semantic Drift ($S_k$) & Optimization Debt ($D_k$)
- **Optimization Debt ($D_k$)**: Measures raw information loss. If you remove 50% of the tokens, debt increases.
- **Semantic Drift ($S_k$)**: Measures how much the *meaning* or *structure* of the code has deviated from the original. TokenDamper runs an AST (Abstract Syntax Tree) check. If structural nodes are missing or corrupted, $S_k$ spikes. If $S_k > 0.40$, the engine falls back.

---

## 5. Current Safety Features & Vulnerabilities

### Safety Features
- **Strict AST Validation**: The engine parses the final output to ensure code and JSON syntaxes are still valid. If they aren't, it aborts compression.
- **Constraint Ledger**: It tracks critical pieces of information (like secrets, explicit user prompts, or system instructions). If these are accidentally pruned by the Knapsack algorithm, it catches the loss and aborts.
- **Unconditional Fallback**: When validation fails, the engine does not try to guess or "repair" the output. It 100% falls back to the original raw input to prevent hallucinations or data loss.

### Current Vulnerabilities / Areas for Improvement
1. **JSON AST Corruption via Hashing**: Right now, if TokenDamper processes a huge JSON payload (like `tool_output.json`) and tries to deduplicate a string inside it, it injects `<BLOCK_HASH:...>`. Because it does this via raw string replacement rather than AST-aware node replacement, it breaks JSON parsing boundaries. The safety validator catches this and falls back, meaning **JSON payloads frequently see 0% compression**.
2. **Aggressive Semantic Drift Constraints**: The max drift threshold (0.40) is currently very sensitive. In long Python files, removing even redundant functions can push the score above 0.40, resulting in the planner failing open (0% compression) far too often.
3. **No ML Heuristics**: While being deterministic is a safety feature, it means TokenDamper lacks the semantic understanding that an ML model has (like knowing *which* logs are useless noise vs. important stack traces).

---

## Next Steps for New Developers
1. Review `run_benchmark.py` in `tokendamper-benchmark/` to see how we test the engine constraints.
2. Look at `src/core/planner/index.ts` to understand how the Knapsack plan is triggered.
3. Investigate `src/core/validation/` to see how the AST Validator catches the JSON TokenHasher bugs. Your first major PR could be making the `TokenHasher` AST-aware so it doesn't break JSON structures!
