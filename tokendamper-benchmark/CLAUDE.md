# CLAUDE.md — tokendamper-benchmark

Python harness comparing TokenDamper vs. Headroom. Loads when working in this directory;
the repo-root `CLAUDE.md` still applies.

## Gotchas

- Benchmark latency numbers are **not** apples-to-apples: TokenDamper is timed through a
  Node process spawn via `subprocess.run()`, Headroom via an in-process Python call.
- Headroom's `target_ratio` is a soft hint, not an enforced budget — don't compare
  target-adherence naively.
