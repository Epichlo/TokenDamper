# TokenDamper vs. Headroom Benchmarking Suite Results

## Executive Summary
This benchmark evaluates performance, context compression efficiency, latency overhead, and critical secret preservation between **TokenDamper** and **Headroom** across realistic enterprise payload types.
Both engines were given a **30% token reduction target** (`target_tokens = round(orig_tokens * 0.7)`).

### Methodology
- **Tokenizer**: OpenAI `cl100k_base` via Python `tiktoken` library.
- **Target**: 30% reduction ratio for both engines.
- **Message Formatting**: Single payload files were formatted as `role: tool` for Headroom. A multi-turn JSON session was passed as an array of messages.
- **Latency Note**: ⚠️ **Latency comparison is non-equivalent.** TokenDamper latency includes a Node.js process spawn overhead (`subprocess.run`), while Headroom is timed as an in-process Python call.
- **Invocation**: TokenDamper is invoked with a **file argument** (`tokendamper optimize <path>`), the route a developer actually uses. Until 2026-08-04 this harness piped bytes to `optimize -` instead; with no path the engine cannot resolve a language, elides nothing, and falls back. Every TokenDamper figure published here before that date understates the file-argument route it was presented as measuring.
- **Iterations**: 5 timed iterations per payload per engine after a warmup pass.

## Consolidated Benchmark Results

| Payload File | Orig Tokens | Target Tokens | Engine | Comp Tokens | Reduction % | Median Latency (ms) | Notes |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| `sample_logs.txt` | 3,718 | 2,603 | **Headroom** | 3,043 | 18.15% | 0.79 ms (in-process) | Transforms: ['router:mixed:0.90'] |
| | | | **TokenDamper** | 3,718 | 0.00% | 103.71 ms (process spawn) | Fallback: Imperative constraint directive dropped during optimization: "999Z [CRITICAL] com." |
| `tool_output.json` | 3,315 | 2,320 | **Headroom** | 2,176 | 34.36% | 0.59 ms (in-process) | Transforms: ['router:mixed:0.66'] |
| | | | **TokenDamper** | 3,315 | 0.00% | 93.30 ms (process spawn) | Fallback: Semantic drift metric (0.60) exceeds maximum threshold (0.40). |
| `codebase.py` | 3,549 | 2,484 | **Headroom** | 3,549 | 0.00% | 2.60 ms (in-process) | Transforms: ['router:noop'] |
| | | | **TokenDamper** | 2,569 | 27.61% | 101.40 ms (process spawn) | OK |
| `session.json` | 6,199 | 4,339 | **Headroom** | 749 | 87.92% | 1.24 ms (in-process) | Transforms: ['router:mixed:0.01', 'router:mixed:0.71'] |
| | | | **TokenDamper** | 6,285 | -1.39% | 107.97 ms (process spawn) | Fallback: Semantic drift metric (0.60) exceeds maximum threshold (0.40). |

## Detailed Payload Analysis

### Payload: `sample_logs.txt`
- **Original**: 10,821 characters | **3,718 tokens** (`cl100k_base`)
- **Target**: **2,603 tokens** (30% reduction)
- **Headroom Performance**:
  - Compressed Tokens: **3,043** (18.15% reduction)
  - Median Latency: **0.79 ms** (Iter: 1.1ms, 0.8ms, 0.8ms, 1.3ms, 0.7ms)
- **TokenDamper Performance**:
  - Compressed Tokens: **3,718** (0.00% reduction)
  - Median Latency: **103.71 ms** (Iter: 100.6ms, 104.8ms, 96.4ms, 103.7ms, 181.1ms)
  - Trace: `planMode`=topology_knapsack, `stageCount`=4, `tokenBefore`=3029, `tokenAfter`=3029
  - Fallback: Imperative constraint directive dropped during optimization: "999Z [CRITICAL] com."
- **Secret Preservation Check (`BLUE-PANDA-992`)**:
  - Headroom: ✅ Preserved
  - TokenDamper: ✅ Preserved

### Payload: `tool_output.json`
- **Original**: 11,603 characters | **3,315 tokens** (`cl100k_base`)
- **Target**: **2,320 tokens** (30% reduction)
- **Headroom Performance**:
  - Compressed Tokens: **2,176** (34.36% reduction)
  - Median Latency: **0.59 ms** (Iter: 0.9ms, 0.6ms, 0.6ms, 0.6ms, 0.6ms)
- **TokenDamper Performance**:
  - Compressed Tokens: **3,315** (0.00% reduction)
  - Median Latency: **93.30 ms** (Iter: 93.1ms, 100.1ms, 93.3ms, 93.1ms, 94.4ms)
  - Trace: `planMode`=topology_knapsack, `stageCount`=4, `tokenBefore`=3974, `tokenAfter`=3974
  - Fallback: Semantic drift metric (0.60) exceeds maximum threshold (0.40).

### Payload: `codebase.py`
- **Original**: 16,545 characters | **3,549 tokens** (`cl100k_base`)
- **Target**: **2,484 tokens** (30% reduction)
- **Headroom Performance**:
  - Compressed Tokens: **3,549** (0.00% reduction)
  - Median Latency: **2.60 ms** (Iter: 3.4ms, 2.6ms, 2.5ms, 2.5ms, 3.0ms)
- **TokenDamper Performance**:
  - Compressed Tokens: **2,569** (27.61% reduction)
  - Median Latency: **101.40 ms** (Iter: 103.4ms, 100.4ms, 100.9ms, 101.4ms, 103.7ms)
  - Trace: `planMode`=topology_knapsack, `stageCount`=4, `tokenBefore`=5029, `tokenAfter`=3310

### Payload: `session.json`
- **Original**: 16,131 characters | **6,199 tokens** (`cl100k_base`)
- **Target**: **4,339 tokens** (30% reduction)
- **Headroom Performance**:
  - Compressed Tokens: **749** (87.92% reduction)
  - Median Latency: **1.24 ms** (Iter: 1.7ms, 1.2ms, 1.7ms, 1.2ms, 1.2ms)
- **TokenDamper Performance**:
  - Compressed Tokens: **6,285** (-1.39% reduction)
  - Median Latency: **107.97 ms** (Iter: 108.0ms, 129.3ms, 116.8ms, 103.7ms, 101.8ms)
  - Trace: `planMode`=topology_knapsack, `stageCount`=4, `tokenBefore`=4679, `tokenAfter`=4679
  - Fallback: Semantic drift metric (0.60) exceeds maximum threshold (0.40).
