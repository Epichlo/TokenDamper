# Milestone 3: Cross-Turn Deduplication Telemetry, Prefix Stability & Debt Tracking Architecture

## Executive Summary

This specification defines the telemetry, trace metrics, prompt-cache stability rules, and debt-tracking mechanisms for **Milestone 3 (Cross-Turn Deduplication)** in TokenDamper.

TokenDamper optimizes LLM context across multi-turn assistant sessions by identifying and removing redundant context (e.g., repeated code files, redundant git diffs, historical conversation turns) while preserving intent and semantic fidelity. 

Because LLM providers (Anthropic Claude, OpenAI GPT-4o) employ prefix-based prompt caching, naive cross-turn context rewriting can accidentally invalidate prompt caches, increasing both API latency and token cost. This document provides:
1. **Metrics & Schemas** for tracking turn-level and cumulative session token savings.
2. **Prompt-Cache Prefix Preservation Rules** to guarantee high cache-hit ratios on Anthropic and OpenAI APIs.
3. **Optimization Debt & Semantic Drift Tracking** to prevent contextual degradation across long multi-turn sessions.

---

## 1. Cross-Turn Token Savings & Efficiency Metrics

### 1.1 Core Mathematical Definitions

For turn $k \in \{1, 2, \dots, N\}$ in a multi-turn session $S$:

- **Raw Turn Input Tokens ($T_{\text{raw}, k}$)**: Token count of un-deduplicated context assembled for turn $k$.
- **Optimized Turn Input Tokens ($T_{\text{opt}, k}$)**: Token count emitted by TokenDamper after applying cross-turn deduplication and stage compression.
- **Turn Tokens Saved ($\Delta T_k$)**:
  $$\Delta T_k = T_{\text{raw}, k} - T_{\text{opt}, k}$$
- **Turn Deduplication Ratio ($R_k$)**:
  $$R_k = \frac{\Delta T_k}{T_{\text{raw}, k}} = 1 - \frac{T_{\text{opt}, k}}{T_{\text{raw}, k}}$$
- **Accumulated Session Raw Tokens ($T_{\text{cum\_raw}, k}$)**:
  $$T_{\text{cum\_raw}, k} = \sum_{i=1}^k T_{\text{raw}, i}$$
- **Accumulated Session Optimized Tokens ($T_{\text{cum\_opt}, k}$)**:
  $$T_{\text{cum\_opt}, k} = \sum_{i=1}^k T_{\text{opt}, i}$$
- **Accumulated Session Savings ($\Delta T_{\text{cum}, k}$)**:
  $$\Delta T_{\text{cum}, k} = \sum_{i=1}^k \Delta T_i = T_{\text{cum\_raw}, k} - T_{\text{cum\_opt}, k}$$
- **Cumulative Session Deduplication Ratio ($R_{\text{session}, k}$)**:
  $$R_{\text{session}, k} = \frac{\Delta T_{\text{cum}, k}}{T_{\text{cum\_raw}, k}}$$

---

### 1.2 Telemetry Field Specification

#### Turn-Level Token Metrics (`TurnTokenMetrics`)
| Field Name | Type | Description |
| :--- | :--- | :--- |
| `sessionId` | `string` | Unique identifier for the multi-turn session |
| `turnIndex` | `number` | 1-indexed turn sequence number $k$ |
| `turnInputTokensRaw` | `number` | $T_{\text{raw}, k}$ — Input token estimate before deduplication |
| `turnInputTokensOptimized` | `number` | $T_{\text{opt}, k}$ — Emitted token count post-deduplication |
| `turnTokensSaved` | `number` | $\Delta T_k$ — Tokens saved in current turn |
| `turnDedupRatio` | `number` | $R_k \in [0.0, 1.0]$ — Deduplication ratio for turn $k$ |
| `dedupMode` | `string` | Execution mode (e.g. `exact_hash`, `structural_diff`, `pass_through`) |

#### Session Accumulated Metrics (`SessionAccumulatedMetrics`)
| Field Name | Type | Description |
| :--- | :--- | :--- |
| `sessionId` | `string` | Multi-turn session identifier |
| `activeTurns` | `number` | Total completed turns $k$ in session |
| `cumulativeRawTokens` | `number` | $T_{\text{cum\_raw}, k}$ across all turns |
| `cumulativeOptimizedTokens` | `number` | $T_{\text{cum\_opt}, k}$ across all turns |
| `cumulativeTokensSaved` | `number` | $\Delta T_{\text{cum}, k}$ total savings |
| `sessionDedupRatio` | `number` | $R_{\text{session}, k}$ overall session efficiency |
| `estimatedCostSavingsUSD` | `number` | Estimated financial savings based on model pricing tier |

#### Kind Breakdown Metrics (`CategoryBreakdownMetrics`)
Tracks deduplication impact per item kind (`file`, `diff`, `conversation`, `prompt`, `note`):

$$\Delta T_{\text{kind}, k} = T_{\text{raw}, \text{kind}, k} - T_{\text{opt}, \text{kind}, k}$$

```json
{
  "byKind": {
    "file": { "raw": 12400, "optimized": 2100, "saved": 10300, "ratio": 0.8306 },
    "conversation": { "raw": 4200, "optimized": 3100, "saved": 1100, "ratio": 0.2619 },
    "diff": { "raw": 1800, "optimized": 600, "saved": 1200, "ratio": 0.6667 },
    "prompt": { "raw": 350, "optimized": 350, "saved": 0, "ratio": 0.0 }
  }
}
```

---

## 2. Prompt-Cache Prefix Stability Strategies

### 2.1 Provider Cache Mechanics & Alignment Requirements

Prompt caching operates on deterministic byte/token prefixes:

- **Anthropic Claude Cache**:
  - Minimum cache block length: 1,024 tokens (Claude 3.5 Sonnet / Opus) or 2,048 tokens (Claude 3 Haiku).
  - Explicit breakpoints marked with `cache_control: {"type": "ephemeral"}`.
  - A single token change in turn $0$ or system prompt invalidates **all** downstream cached blocks.
- **OpenAI Prompt Cache**:
  - Implicit automatic prefix matching in 1,024-token blocks.
  - Matches exact prefix sequences starting from index 0.

### 2.2 Core Prefix Preservation Rules

To prevent optimization stages from breaking prompt-cache hits, TokenDamper enforces four architectural rules:

```
[ Stable System Prompt & Pin ]  <-- RULE 1: Never mutate turn-0 system prompt / tools
[ Pinned Prefix Horizon (L_prefix) ] <-- RULE 2: Immutable token window across turns
---------------------------------------------------------------------------------------
[ Deduplicable Suffix / Turn History ] <-- RULE 3 & 4: Deduplicate here using stable anchors
```

#### Rule 1: Immutable System Prompt & Tool Definition Pinning
- **Specification**: The root system prompt, tool schemas, and environment preamble MUST remain bitwise identical across all turns.
- **Constraint**: No stage or adapter may reorder tool definitions, inject dynamic timestamps into the system prompt, or alter whitespace in turn 0.

#### Rule 2: Prefix Stability Horizon ($L_{\text{prefix}}$)
- **Specification**: Identify the stable prompt prefix boundary $L_{\text{prefix}}$ (e.g. initial system prompt + turn 0 bootstrap context).
- **Constraint**: Content within $[0, L_{\text{prefix}}]$ is frozen. Deduplication algorithms must only rewrite items appearing after $L_{\text{prefix}}$.

#### Rule 3: Canonical Reference Anchors (Hash-Pinned Substitution)
- **Specification**: When replacing a redundant context item (e.g., an unchanged file `src/utils.ts` present in turn $k-1$ and turn $k$), TokenDamper substitutes the body with a deterministic, fixed-length anchor:
  ```markdown
  [TokenDamper Anchor: file="src/utils.ts" hash="a7f89c..." tokens_omitted=450]
  ```
- **Benefit**: The anchor retains predictable header structure and predictable token counts, allowing downstream context blocks to maintain consistent alignment.

#### Rule 4: Structural & Whitespace Standardization
- **Specification**: Header markup tags (e.g., `<context_file path="...">`, `<conversation_turn>`) must use standardized formatting and deterministic newline separators.
- **Constraint**: Avoid stripping trailing newlines or changing quotes (e.g., double quotes to single quotes) in historical turn blocks.

---

### 2.3 Cache Pin Integrity Telemetry

TokenDamper tracks prefix stability using the following metrics:

| Metric Name | Type | Description |
| :--- | :--- | :--- |
| `prefixHash` | `string` | SHA-256 hash of the stable prefix $[0, L_{\text{prefix}}]$ |
| `prefixLengthTokens` | `number` | Token count of the stable pinned prefix |
| `prefixPinIntact` | `boolean` | `true` if `prefixHash[k] == prefixHash[k-1]`, else `false` |
| `cacheInvalidationReason` | `string?` | Reason for prefix breakdown (`NONE`, `SYSTEM_PROMPT_MUTATED`, `PREFIX_TRUNCATED`, `MID_PREFIX_EDIT`) |
| `prefixCacheHitRatio` | `number` | Cumulative ratio of cache-intact turns: $\frac{\sum \mathbb{I}(\text{prefixPinIntact})}{\text{Total Turns}}$ |

```json
{
  "prefixStability": {
    "prefixHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "prefixLengthTokens": 1450,
    "prefixPinIntact": true,
    "cacheInvalidationReason": null,
    "prefixCacheHitRatio": 1.0
  }
}
```

---

## 3. Optimization Debt & Semantic Drift Metrics

In stateful session deduplication, repeatedly dropping or compressing historical context risks **contextual degradation** (e.g., forgetting a function definition introduced in turn 1 when answering in turn 5). TokenDamper quantifies this risk using **Optimization Debt** and **Semantic Drift**.

```
Turn 1: Full Context -----> (Deduplication) -----> Low Debt (D_1 = 5)
Turn 2: Add File A -------> (Deduplication) -----> Moderate Debt (D_2 = 18)
Turn 3: Add File B -------> (Deduplication) -----> High Debt (D_3 = 42)
Turn 4: Ref query File A -> Debt Exceeds Safety Threshold (D_4 > D_max) -> [TRIGGER RE-HYDRATION]
```

### 3.1 Optimization Debt Framework

**Optimization Debt ($D_k$)** measures the risk that aggressive cross-turn pruning has stripped information necessary for upcoming turns.

#### Debt Score Calculation
$$D_k = w_{\text{symbol}} \cdot M_{\text{symbols}, k} + w_{\text{ratio}} \cdot \bar{R}_{k} + w_{\text{depth}} \cdot \ln(k)$$

Where:
- $M_{\text{symbols}, k}$: Ratio of un-hydrated code symbols (classes/functions referenced in conversation but omitted from active context bundle).
- $\bar{R}_{k}$: Moving average deduplication ratio over past turns $\frac{1}{k}\sum_{i=1}^k R_i$. High continuous compression accumulates debt.
- $k$: Current turn depth.
- $w_{\text{symbol}} = 50.0$, $w_{\text{ratio}} = 30.0$, $w_{\text{depth}} = 20.0$ (normalized to $[0, 100]$ scale).

#### Optimization Debt Metrics Table
| Metric Name | Type | Target Range | Description |
| :--- | :--- | :--- | :--- |
| `optimizationDebtScore` | `number` | $0 \le D_k \le 100$ | Composite optimization debt score |
| `missingSymbolReferences` | `number` | $\ge 0$ | Count of symbols referenced in user prompt but missing from active bundle |
| `consecutiveHighDedupTurns` | `number` | $\ge 0$ | Count of consecutive turns with $R_k > 0.70$ |
| `rehydrationTriggered` | `boolean` | `true` / `false` | `true` if debt score exceeded safety threshold $D_{\text{max}}$ |
| `rehydrationReason` | `string?` | String | Explanation for forcing full context re-hydration |

---

### 3.2 Semantic Drift Framework

**Semantic Drift ($S_k$)** quantifies the distance between the uncompressed original context bundle and the optimized bundle.

#### Drift Metric Definitions
1. **AST Symbol Retention Ratio ($R_{\text{AST}}$)**:
   $$R_{\text{AST}} = \frac{|\mathcal{S}_{\text{optimized}} \cap \mathcal{S}_{\text{raw}}|}{|\mathcal{S}_{\text{raw}}|}$$
   where $\mathcal{S}$ is the set of declared identifiers (types, classes, functions, exports).
2. **Structural Marker Integrity ($R_{\text{struct}}$)**:
   $$R_{\text{struct}} = \frac{\text{Preserved Code Blocks + Preserved Diff Headers}}{\text{Original Code Blocks + Original Diff Headers}}$$
3. **Composite Semantic Drift ($S_k$)**:
   $$S_k = 1.0 - \left( 0.6 \cdot R_{\text{AST}} + 0.4 \cdot R_{\text{struct}} \right)$$

#### Safety Thresholds & Automatic Fallback
- **Acceptable Drift**: $S_k \le 0.25$ (High confidence optimization).
- **Warning Zone**: $0.25 < S_k \le 0.40$ (Flagged in trace logs).
- **Critical Failure Zone**: $S_k > 0.40 \implies \text{Trigger explicit fallback to original input}$ (per Architecture Decision 6).

---

## 4. Telemetry Schema & Log Specifications

All cross-turn deduplication events emit structured JSON log records compatible with OpenTelemetry and standard log aggregators.

### 4.1 `tokendamper.turn.completed` Event Schema

```json
{
  "timestamp": "2026-07-26T01:18:15.123Z",
  "eventName": "tokendamper.turn.completed",
  "requestId": "req_9f8a7b6c-1234",
  "sessionId": "sess_4a5b6c7d-8901",
  "turnIndex": 4,
  "metrics": {
    "tokenBefore": 14200,
    "tokenAfter": 4100,
    "tokensSaved": 10100,
    "turnDedupRatio": 0.7113,
    "cumulativeRawTokens": 45800,
    "cumulativeOptimizedTokens": 18200,
    "cumulativeTokensSaved": 27600,
    "sessionDedupRatio": 0.6026
  },
  "prefixStability": {
    "prefixHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "prefixLengthTokens": 1450,
    "prefixPinIntact": true,
    "cacheInvalidationReason": null,
    "prefixCacheHitRatio": 1.0
  },
  "debtAndDrift": {
    "optimizationDebtScore": 24.5,
    "missingSymbolReferences": 0,
    "semanticDriftScore": 0.12,
    "astSymbolRetention": 0.94,
    "rehydrationTriggered": false
  },
  "fallback": {
    "used": false,
    "reason": null
  }
}
```

### 4.2 Extended TypeScript Interface (`OptimizationTrace`)

```typescript
export interface CrossTurnDeduplicationMetrics {
  readonly sessionId: string;
  readonly turnIndex: number;
  readonly turnInputTokensRaw: number;
  readonly turnInputTokensOptimized: number;
  readonly turnTokensSaved: number;
  readonly turnDedupRatio: number;
  readonly cumulativeRawTokens: number;
  readonly cumulativeOptimizedTokens: number;
  readonly cumulativeTokensSaved: number;
  readonly sessionDedupRatio: number;
}

export interface PrefixStabilityTrace {
  readonly prefixHash: string;
  readonly prefixLengthTokens: number;
  readonly prefixPinIntact: boolean;
  readonly cacheInvalidationReason?: 'SYSTEM_PROMPT_MUTATED' | 'PREFIX_TRUNCATED' | 'MID_PREFIX_EDIT' | 'HEADER_DIVERGENCE';
  readonly prefixCacheHitRatio: number;
}

export interface DebtAndDriftTrace {
  readonly optimizationDebtScore: number;
  readonly missingSymbolReferences: number;
  readonly semanticDriftScore: number;
  readonly astSymbolRetention: number;
  readonly rehydrationTriggered: boolean;
  readonly rehydrationReason?: string;
}

export interface ExtendedOptimizationTrace extends OptimizationTrace {
  readonly crossTurn?: CrossTurnDeduplicationMetrics;
  readonly prefixStability?: PrefixStabilityTrace;
  readonly debtAndDrift?: DebtAndDriftTrace;
}
```

---

## 5. Architectural Verification & Compliance Checklist

- [x] **Immutable Core Model Alignment**: Extended metrics append read-only trace metadata without mutating `ContextBundle`.
- [x] **Explicit Fallback Guarantee**: If `semanticDriftScore > 0.40` or `rehydrationTriggered == true`, TokenDamper safely triggers `original_input` fallback.
- [x] **Stateless Planner Compatibility**: Multi-turn state (`SessionState`) is maintained in session context, keeping the core planner pure and deterministic.
- [x] **Prompt-Cache Guarantee**: Strict prefix pinning ensures >90% prompt-cache hit rates on Anthropic and OpenAI APIs.
