import os
import sys
import json
import shutil
import subprocess
import time
import statistics
from typing import Dict, List, Tuple, Any
import tiktoken
from headroom import compress as headroom_compress

tokenizer = tiktoken.get_encoding("cl100k_base")

def count_tokens(text: str) -> int:
    return len(tokenizer.encode(text))

def run_headroom(messages: List[Dict[str, Any]], target_tokens: int, orig_tokens: int, is_session: bool) -> Tuple[str, float, Any]:
    # target_ratio is keep ratio for headroom, so we want 0.7 to keep 70% (30% reduction)
    target_ratio = target_tokens / orig_tokens if orig_tokens > 0 else 1.0

    start = time.perf_counter()
    try:
        # Pass protect_recent=0 so it doesn't just bypass the last messages
        result = headroom_compress(messages, target_ratio=target_ratio, protect_recent=0, compress_user_messages=True)
        # Reconstruct output text from messages
        if hasattr(result, "messages"):
            if is_session:
                compressed_text = json.dumps(result.messages)
            else:
                msg = result.messages[0]
                compressed_text = msg.get("content", str(msg)) if isinstance(msg, dict) else getattr(msg, "content", str(msg))
        else:
            compressed_text = str(result)
        trace = getattr(result, "transforms_applied", [])
    except Exception as e:
        compressed_text = f"Error running Headroom: {e}"
        trace = []

    elapsed_ms = (time.perf_counter() - start) * 1000.0
    return compressed_text, elapsed_ms, trace

def run_tokendamper(file_path: str, target_ratio: float) -> Tuple[str, float, Dict[str, Any]]:
    # Pass the path, not the bytes over stdin.
    #
    # This is not cosmetic and it is not a style preference. `createContextBundle` derives
    # `contentType` from the content *and* the `sourcePath`, and `selectValidator` dispatches
    # `language` -> path extension -> `contentType`. Piping to `optimize -` supplies no path,
    # so the item classifies as `text`, `selectValidator` returns null, `selectElisionRegions`
    # finds no language to select regions for, and the item falls to whole-item hashing --
    # where `S_k` pins at the formula constant 0.60 and the pipeline falls back to raw input.
    #
    # Measured on test_data/codebase.py at 0.3: stdin 16,937 bytes out, fallback, 0% saved;
    # path 11,328 bytes out, no fallback, 34.18% saved. Same bytes, same engine, same budget.
    # Every TokenDamper figure this harness published before 2026-08-04 was measured through
    # the stdin route and understates the file-argument route it was presented as measuring.
    #
    # The pathless route is a real engine defect (docs/phase-4b-pathless-code-scope.md) and is
    # tracked separately. It is not this harness's job to compensate for it: the harness should
    # exercise the route a developer actually uses, which is a file argument.
    cmd = shutil.which("tokendamper") or "tokendamper"
    start = time.perf_counter()
    try:
        process = subprocess.run(
            [cmd, "optimize", file_path, "--target-reduction-ratio", str(target_ratio)],
            text=True,
            capture_output=True,
            check=True,
            shell=(os.name == "nt")
        )
        compressed_text = process.stdout
        try:
            trace = json.loads(process.stderr)
        except json.JSONDecodeError:
            trace = {"error": "Could not parse trace JSON", "stderr": process.stderr}
    except subprocess.CalledProcessError as e:
        compressed_text = f"Error running TokenDamper: {e.stderr}"
        trace = {"error": "Process error"}
    except Exception as e:
        compressed_text = f"Error running TokenDamper: {e}"
        trace = {"error": str(e)}

    elapsed_ms = (time.perf_counter() - start) * 1000.0
    return compressed_text, elapsed_ms, trace

def benchmark_payload(file_path: str) -> Dict[str, Any]:
    file_name = os.path.basename(file_path)
    with open(file_path, "r", encoding="utf-8") as f:
        raw_text = f.read()

    is_session = file_name.endswith(".json") and "session" in file_name
    if is_session:
        messages = json.loads(raw_text)
        orig_tokens = count_tokens(json.dumps(messages))
    else:
        # Wrap as tool for Headroom
        messages = [{"role": "tool", "tool_call_id": f"read_{file_name}", "content": raw_text}]
        orig_tokens = count_tokens(raw_text)

    # Calculate 30% reduction target (keep 70%)
    target_reduction_ratio = 0.3
    target_tokens = round(orig_tokens * (1.0 - target_reduction_ratio))

    # Warmup pass (1 iteration)
    run_headroom(messages, target_tokens, orig_tokens, is_session)
    run_tokendamper(file_path, target_reduction_ratio)

    # 5 Timed Iterations for Headroom
    hr_latencies: List[float] = []
    hr_compressed_text = ""
    hr_trace = None
    for _ in range(5):
        comp_text, lat_ms, tr = run_headroom(messages, target_tokens, orig_tokens, is_session)
        hr_latencies.append(lat_ms)
        hr_compressed_text = comp_text
        hr_trace = tr

    hr_comp_tokens = count_tokens(hr_compressed_text)
    hr_median_lat = statistics.median(hr_latencies)
    hr_reduction = ((orig_tokens - hr_comp_tokens) / orig_tokens) * 100.0 if orig_tokens > 0 else 0.0

    # 5 Timed Iterations for TokenDamper
    td_latencies: List[float] = []
    td_compressed_text = ""
    td_trace = {}
    for _ in range(5):
        comp_text, lat_ms, tr = run_tokendamper(file_path, target_reduction_ratio)
        td_latencies.append(lat_ms)
        td_compressed_text = comp_text
        td_trace = tr

    td_comp_tokens = count_tokens(td_compressed_text)
    td_median_lat = statistics.median(td_latencies)
    td_reduction = ((orig_tokens - td_comp_tokens) / orig_tokens) * 100.0 if orig_tokens > 0 else 0.0

    secret_key = "BLUE-PANDA-992"
    hr_secret_preserved = secret_key in hr_compressed_text if "sample_logs" in file_name else None
    td_secret_preserved = secret_key in td_compressed_text if "sample_logs" in file_name else None

    # Parse TD trace
    td_plan_mode = td_trace.get("planMode", "unknown")
    td_stage_count = td_trace.get("stageCount", 0)
    td_token_before = td_trace.get("tokenBefore", 0)
    td_token_after = td_trace.get("tokenAfter", 0)
    td_fallback_used = td_trace.get("fallbackUsed", False)
    td_fallback_reason = td_trace.get("fallbackReason", "N/A")

    return {
        "file_name": file_name,
        "original_tokens": orig_tokens,
        "original_chars": len(raw_text),
        "target_tokens": target_tokens,
        "target_reduction_pct": target_reduction_ratio * 100.0,
        "headroom": {
            "compressed_tokens": hr_comp_tokens,
            "reduction_pct": hr_reduction,
            "median_lat_ms": hr_median_lat,
            "latencies": hr_latencies,
            "secret_preserved": hr_secret_preserved,
            "trace": hr_trace,
        },
        "tokendamper": {
            "compressed_tokens": td_comp_tokens,
            "reduction_pct": td_reduction,
            "median_lat_ms": td_median_lat,
            "latencies": td_latencies,
            "secret_preserved": td_secret_preserved,
            "plan_mode": td_plan_mode,
            "stage_count": td_stage_count,
            "token_before": td_token_before,
            "token_after": td_token_after,
            "fallback_used": td_fallback_used,
            "fallback_reason": td_fallback_reason,
        }
    }

def generate_markdown_report(results: List[Dict[str, Any]], report_path: str):
    md_lines = [
        "# TokenDamper vs. Headroom Benchmarking Suite Results",
        "",
        "## Executive Summary",
        "This benchmark evaluates performance, context compression efficiency, latency overhead, and critical secret preservation between **TokenDamper** and **Headroom** across realistic enterprise payload types.",
        "Both engines were given a **30% token reduction target** (`target_tokens = round(orig_tokens * 0.7)`).",
        "",
        "### Methodology",
        "- **Tokenizer**: OpenAI `cl100k_base` via Python `tiktoken` library.",
        "- **Target**: 30% reduction ratio for both engines.",
        "- **Message Formatting**: Single payload files were formatted as `role: tool` for Headroom. A multi-turn JSON session was passed as an array of messages.",
        "- **Latency Note**: ⚠️ **Latency comparison is non-equivalent.** TokenDamper latency includes a Node.js process spawn overhead (`subprocess.run`), while Headroom is timed as an in-process Python call.",
        "- **Invocation**: TokenDamper is invoked with a **file argument** (`tokendamper optimize <path>`), the route a developer actually uses. Until 2026-08-04 this harness piped bytes to `optimize -` instead; with no path the engine cannot resolve a language, elides nothing, and falls back. Every TokenDamper figure published here before that date understates the file-argument route it was presented as measuring.",
        "- **Iterations**: 5 timed iterations per payload per engine after a warmup pass.",
        "",
        "## Consolidated Benchmark Results",
        "",
        "| Payload File | Orig Tokens | Target Tokens | Engine | Comp Tokens | Reduction % | Median Latency (ms) | Notes |",
        "| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |"
    ]

    for res in results:
        file_name = res["file_name"]
        orig_tok = res["original_tokens"]
        tgt_tok = res["target_tokens"]

        hr = res["headroom"]
        td = res["tokendamper"]
        
        td_notes = []
        if td['fallback_used']:
            note = f"Fallback: {td['fallback_reason']}"
            if td['fallback_reason'] == 'SEMANTIC_DRIFT_EXCEEDED':
                note = f"⚠️ {note}"
            td_notes.append(note)
        td_notes_str = ", ".join(td_notes) if td_notes else "OK"

        hr_notes = f"Transforms: {hr['trace']}" if hr['trace'] else "No transforms"

        md_lines.append(f"| `{file_name}` | {orig_tok:,} | {tgt_tok:,} | **Headroom** | {hr['compressed_tokens']:,} | {hr['reduction_pct']:.2f}% | {hr['median_lat_ms']:.2f} ms (in-process) | {hr_notes} |")
        md_lines.append(f"| | | | **TokenDamper** | {td['compressed_tokens']:,} | {td['reduction_pct']:.2f}% | {td['median_lat_ms']:.2f} ms (process spawn) | {td_notes_str} |")

    md_lines.extend([
        "",
        "## Detailed Payload Analysis",
        ""
    ])

    for res in results:
        file_name = res["file_name"]
        orig_tok = res["original_tokens"]
        tgt_tok = res["target_tokens"]
        orig_chars = res["original_chars"]
        hr = res["headroom"]
        td = res["tokendamper"]

        md_lines.extend([
            f"### Payload: `{file_name}`",
            f"- **Original**: {orig_chars:,} characters | **{orig_tok:,} tokens** (`cl100k_base`)",
            f"- **Target**: **{tgt_tok:,} tokens** (30% reduction)",
            f"- **Headroom Performance**:",
            f"  - Compressed Tokens: **{hr['compressed_tokens']:,}** ({hr['reduction_pct']:.2f}% reduction)",
            f"  - Median Latency: **{hr['median_lat_ms']:.2f} ms** (Iter: {', '.join(f'{l:.1f}ms' for l in hr['latencies'])})",
            f"- **TokenDamper Performance**:",
            f"  - Compressed Tokens: **{td['compressed_tokens']:,}** ({td['reduction_pct']:.2f}% reduction)",
            f"  - Median Latency: **{td['median_lat_ms']:.2f} ms** (Iter: {', '.join(f'{l:.1f}ms' for l in td['latencies'])})",
            f"  - Trace: `planMode`={td['plan_mode']}, `stageCount`={td['stage_count']}, `tokenBefore`={td['token_before']}, `tokenAfter`={td['token_after']}"
        ])

        if td['fallback_used']:
            flag = "⚠️ " if td['fallback_reason'] == "SEMANTIC_DRIFT_EXCEEDED" else ""
            md_lines.append(f"  - Fallback: {flag}{td['fallback_reason']}")

        if res["file_name"] == "sample_logs.txt":
            md_lines.extend([
                f"- **Secret Preservation Check (`BLUE-PANDA-992`)**:",
                f"  - Headroom: {'✅ Preserved' if hr['secret_preserved'] else '❌ Redacted/Lost'}",
                f"  - TokenDamper: {'✅ Preserved' if td['secret_preserved'] else '❌ Redacted/Lost'}"
            ])
        md_lines.append("")

    report_content = "\n".join(md_lines)
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(report_content)
    print(f"\nSaved report to: {report_path}")

def main():
    print("=========================================================")
    print("  TokenDamper vs Headroom Benchmark Harness Executing   ")
    print("=========================================================")

    test_files = [
        "test_data/sample_logs.txt",
        "test_data/tool_output.json",
        "test_data/codebase.py",
        "test_data/session.json"
    ]

    results = []
    for tf in test_files:
        if not os.path.exists(tf):
            print(f"Error: {tf} not found. Ensure generate_test_data.py and generate_session_data.py were run.")
            return
        print(f"\nBenchmarking payload: {tf}...")
        res = benchmark_payload(tf)
        results.append(res)

        print(f"  Original Tokens  : {res['original_tokens']:,} (Target: {res['target_tokens']:,})")
        print(f"  Headroom Median  : {res['headroom']['median_lat_ms']:.2f} ms | Tok: {res['headroom']['compressed_tokens']:,} ({res['headroom']['reduction_pct']:.1f}%)")
        
        td_fallback = f" [Fallback: {res['tokendamper']['fallback_reason']}]" if res['tokendamper']['fallback_used'] else ""
        print(f"  TokenDamper Median: {res['tokendamper']['median_lat_ms']:.2f} ms | Tok: {res['tokendamper']['compressed_tokens']:,} ({res['tokendamper']['reduction_pct']:.1f}%){td_fallback}")
        print(f"  TD Trace         : planMode={res['tokendamper']['plan_mode']}, stageCount={res['tokendamper']['stage_count']}")
        
        if res["file_name"] == "sample_logs.txt":
            print(f"  Secret Preserved : Headroom={res['headroom']['secret_preserved']}, TokenDamper={res['tokendamper']['secret_preserved']}")

    report_file = "BENCHMARK_RESULTS.md"
    generate_markdown_report(results, report_file)
    print("\nBenchmark Suite Execution Completed Successfully!")

if __name__ == "__main__":
    main()
