# TokenDamper vs. Headroom Benchmarking Suite Results

## Executive Summary
This benchmark evaluates performance, context compression efficiency, latency overhead, and critical secret preservation between **TokenDamper** and **Headroom** across realistic enterprise payload types.
Both engines were given a **30% token reduction target** (`target_tokens = round(orig_tokens * 0.7)`).

### Methodology
- **Tokenizer**: OpenAI `cl100k_base` via Python `tiktoken` library.
- **Target**: 30% reduction ratio for both engines.
- **Message Formatting**: Single payload files were formatted as `role: tool` for Headroom. A multi-turn JSON session was passed as an array of messages.
- **Latency Note**: ⚠️ **Latency comparison is non-equivalent.** TokenDamper latency includes a Node.js process spawn overhead (`subprocess.run`), while Headroom is timed as an in-process Python call.
- **Iterations**: 5 timed iterations per payload per engine after a warmup pass.

## Consolidated Benchmark Results

| Payload File | Orig Tokens | Target Tokens | Engine | Comp Tokens | Reduction % | Median Latency (ms) | Notes |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| `sample_logs.txt` | 3,718 | 2,603 | **Headroom** | 3,043 | 18.15% | 0.92 ms (in-process) | Transforms: ['router:mixed:0.90'] |
| | | | **TokenDamper** | 3,718 | 0.00% | 164.52 ms (process spawn) | Fallback: Imperative constraint directive dropped during optimization: "999Z [CRITICAL] com." |
| `tool_output.json` | 3,315 | 2,320 | **Headroom** | 2,176 | 34.36% | 0.84 ms (in-process) | Transforms: ['router:mixed:0.66'] |
| | | | **TokenDamper** | 3,315 | 0.00% | 153.29 ms (process spawn) | Fallback: AST Error in item [257c348b9d20dabca6437379676f3f92c793f3916e85eb6d61d9b5622ff5cefe] at line 1, col 78: JSON Syntax Error: Unexpected token '<', "<BLOCK_HAS"... is not valid JSON; Semantic drift metric (0.60) exceeds maximum threshold (0.40). |
| `codebase.py` | 3,549 | 2,484 | **Headroom** | 3,549 | 0.00% | 2.45 ms (in-process) | Transforms: ['router:noop'] |
| | | | **TokenDamper** | 3,549 | 0.00% | 162.85 ms (process spawn) | Fallback: Semantic drift metric (0.60) exceeds maximum threshold (0.40). |
| `session.json` | 6,199 | 4,339 | **Headroom** | 749 | 87.92% | 1.81 ms (in-process) | Transforms: ['router:mixed:0.01', 'router:mixed:0.71'] |
| | | | **TokenDamper** | 6,285 | -1.39% | 160.08 ms (process spawn) | Fallback: AST Error in item [8a52969517fd91bbbcc62cb4c626f090cce3d121bbf5dc8605ca4ec3b7b019ab] at line 1, col 78: JSON Syntax Error: Unexpected token '<', "<BLOCK_HAS"... is not valid JSON; Semantic drift metric (0.60) exceeds maximum threshold (0.40). |

## Detailed Payload Analysis

### Payload: `sample_logs.txt`
- **Original**: 10,821 characters | **3,718 tokens** (`cl100k_base`)
- **Target**: **2,603 tokens** (30% reduction)
- **Headroom Performance**:
  - Compressed Tokens: **3,043** (18.15% reduction)
  - Median Latency: **0.92 ms** (Iter: 1.5ms, 0.9ms, 0.8ms, 0.8ms, 1.4ms)
- **TokenDamper Performance**:
  - Compressed Tokens: **3,718** (0.00% reduction)
  - Median Latency: **164.52 ms** (Iter: 182.5ms, 164.5ms, 143.4ms, 165.9ms, 145.8ms)
  - Trace: `planMode`=topology_knapsack, `stageCount`=4, `tokenBefore`=3029, `tokenAfter`=2724
  - Fallback: Imperative constraint directive dropped during optimization: "999Z [CRITICAL] com."
- **Secret Preservation Check (`BLUE-PANDA-992`)**:
  - Headroom: ✅ Preserved
  - TokenDamper: ✅ Preserved

### Payload: `tool_output.json`
- **Original**: 11,603 characters | **3,315 tokens** (`cl100k_base`)
- **Target**: **2,320 tokens** (30% reduction)
- **Headroom Performance**:
  - Compressed Tokens: **2,176** (34.36% reduction)
  - Median Latency: **0.84 ms** (Iter: 1.1ms, 0.8ms, 0.8ms, 0.8ms, 1.0ms)
- **TokenDamper Performance**:
  - Compressed Tokens: **3,315** (0.00% reduction)
  - Median Latency: **153.29 ms** (Iter: 153.0ms, 164.9ms, 150.5ms, 161.9ms, 153.3ms)
  - Trace: `planMode`=topology_knapsack, `stageCount`=4, `tokenBefore`=3974, `tokenAfter`=3009
  - Fallback: AST Error in item [257c348b9d20dabca6437379676f3f92c793f3916e85eb6d61d9b5622ff5cefe] at line 1, col 78: JSON Syntax Error: Unexpected token '<', "<BLOCK_HAS"... is not valid JSON; Semantic drift metric (0.60) exceeds maximum threshold (0.40).

### Payload: `codebase.py`
- **Original**: 16,545 characters | **3,549 tokens** (`cl100k_base`)
- **Target**: **2,484 tokens** (30% reduction)
- **Headroom Performance**:
  - Compressed Tokens: **3,549** (0.00% reduction)
  - Median Latency: **2.45 ms** (Iter: 2.8ms, 2.4ms, 2.6ms, 2.4ms, 2.4ms)
- **TokenDamper Performance**:
  - Compressed Tokens: **3,549** (0.00% reduction)
  - Median Latency: **162.85 ms** (Iter: 143.9ms, 163.7ms, 168.4ms, 162.9ms, 147.1ms)
  - Trace: `planMode`=topology_knapsack, `stageCount`=4, `tokenBefore`=5029, `tokenAfter`=4235
  - Fallback: Semantic drift metric (0.60) exceeds maximum threshold (0.40).

### Payload: `session.json`
- **Original**: 16,131 characters | **6,199 tokens** (`cl100k_base`)
- **Target**: **4,339 tokens** (30% reduction)
- **Headroom Performance**:
  - Compressed Tokens: **749** (87.92% reduction)
  - Median Latency: **1.81 ms** (Iter: 1.8ms, 2.5ms, 1.3ms, 1.2ms, 1.8ms)
- **TokenDamper Performance**:
  - Compressed Tokens: **6,285** (-1.39% reduction)
  - Median Latency: **160.08 ms** (Iter: 150.3ms, 160.1ms, 158.6ms, 751.5ms, 210.8ms)
  - Trace: `planMode`=topology_knapsack, `stageCount`=4, `tokenBefore`=4679, `tokenAfter`=4049
  - Fallback: AST Error in item [8a52969517fd91bbbcc62cb4c626f090cce3d121bbf5dc8605ca4ec3b7b019ab] at line 1, col 78: JSON Syntax Error: Unexpected token '<', "<BLOCK_HAS"... is not valid JSON; Semantic drift metric (0.60) exceeds maximum threshold (0.40).
