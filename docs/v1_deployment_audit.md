# TokenDamper v1 — Critical Deployment Audit Report

> **Audit Date**: 2026-07-26
> **Verdict: 🔴 NOT READY for public deployment**
>
> There are **3 critical**, **5 high**, and **7 medium** severity findings that must be resolved before a v1 public release.

---

## Summary

| Severity | Count | Category |
|---|---|---|
| 🔴 Critical | 3 | Architecture flaw, Security, Build |
| 🟠 High | 5 | Memory leak, DoS, Shutdown, Documentation |
| 🟡 Medium | 7 | Version, CI/CD, Test gaps, Dependency, Error handling |
| 🟢 Passing | 6 | Type safety, Tests, Licensing, Packaging |

---

## 🔴 Critical Issues (Must Fix)

### C1. `emittedOutput` Always Returns Raw Input — Optimization Never Reaches Consumers

**Files**: [engine/index.ts#L236](file:///C:/Users/ojass/Projects/TokenDamper/src/core/engine/index.ts#L236), [fallback/index.ts#L15-L28](file:///C:/Users/ojass/Projects/TokenDamper/src/core/fallback/index.ts#L15-L28)

`resolveFallback()` returns `request.rawInput` in **both** branches (fallback used AND not used). The engine then sets `emittedOutput = fallback.output`, so **no optimization ever reaches the caller**:

```diff
 // fallback/index.ts
 if (!validation.shouldFallback) {
   return {
     used: false,
-    output: request.rawInput,   // BUG: should be the optimized bundle text
+    output: renderBundle(currentBundle),
   };
 }
```

**Impact**: MCP `optimize_context` tool, CLI output, and any consumer of `result.emittedOutput` receive the **unoptimized original input**. The optimization engine does real work (verified via `finalBundle.summary.tokenEstimate` in benchmarks), but never exposes it to consumers.

**Evidence**: Every test asserts `result.emittedOutput === rawInput`. The benchmark measures reduction from `result.finalBundle.summary.tokenEstimate`, bypassing `emittedOutput`.

> [!CAUTION]
> This means TokenDamper currently **does nothing observable to its users**. The entire optimization pipeline runs but its output is silently discarded in favor of the original input.

---

### C2. Gateway HTTP Server Has No Request Body Size Limit

**File**: [server.ts#L81-L84](file:///C:/Users/ojass/Projects/TokenDamper/src/gateway/server.ts#L81-L84)

```typescript
let body = '';
req.on('data', (chunk) => {
  body += chunk;  // UNBOUNDED — no size limit
});
```

A malicious client can send an arbitrarily large POST body to crash the process with an out-of-memory error. There is no `Content-Length` check, no streaming limit, and no timeout on the body accumulation.

**Fix**: Add a body size limit (e.g., 10 MB) and abort the request if exceeded:
```typescript
const MAX_BODY_SIZE = 10 * 1024 * 1024;
req.on('data', (chunk) => {
  body += chunk;
  if (body.length > MAX_BODY_SIZE) {
    res.writeHead(413); res.end('Payload Too Large');
    req.destroy();
  }
});
```

---

### C3. `dist/` Build Output Is Stale — MCP Adapter Not Compiled

**File**: `dist/src/adapters/` only contains `cli/` — the `mcp/` directory is missing.

The compiled distribution doesn't include the MCP adapter. Running `npm run start` or installing the package globally will fail when invoking `tokendamper mcp` because the compiled JS files don't exist.

**Fix**: Run `npm run build` before release, and add a `prebuild` or `prepublishOnly` script to automate this.

---

## 🟠 High Severity Issues

### H1. MCP `traceStore` Is an Unbounded Memory Leak

**File**: [tools.ts#L89](file:///C:/Users/ojass/Projects/TokenDamper/src/adapters/mcp/tools.ts#L89)

```typescript
const traceStore = new Map<string, OptimizationTrace>();
```

Every `optimize_context` MCP tool call appends to this global Map. It is **never evicted or cleared**. In a long-running MCP server process, this will grow indefinitely, eventually exhausting memory.

**Fix**: Implement LRU eviction (reuse the same pattern from `GatewaySessionStore`) or cap at N entries.

---

### H2. MCP Server stdin Buffer Is Unbounded

**File**: [server.ts#L26](file:///C:/Users/ojass/Projects/TokenDamper/src/adapters/mcp/server.ts#L26)

```typescript
private buffer = '';
```

If a client sends a very large message without a newline delimiter, the buffer grows indefinitely. A single 1GB string with no `\n` would crash the process.

**Fix**: Add a max buffer size and emit a `PARSE_ERROR` when exceeded.

---

### H3. No Graceful Shutdown — SIGINT/SIGTERM Not Handled

**Files**: [server.ts](file:///C:/Users/ojass/Projects/TokenDamper/src/adapters/mcp/server.ts), [gateway/server.ts](file:///C:/Users/ojass/Projects/TokenDamper/src/gateway/server.ts)

Neither the MCP server nor the Gateway server registers `SIGINT` or `SIGTERM` handlers. On termination:
- Active Gateway connections are dropped without proper HTTP responses
- MCP server may send truncated JSON-RPC responses
- No cleanup of resources or logs

---

### H4. `exec.ts` Uses `shell: true` with Arbitrary User Command

**File**: [exec.ts#L50-L54](file:///C:/Users/ojass/Projects/TokenDamper/src/gateway/exec.ts#L50-L54)

```typescript
const child = spawn(command, commandArgs, {
  env,
  stdio: 'inherit',
  shell: true,  // SHELL INJECTION RISK
});
```

`tokendamper exec <command>` passes user-supplied CLI arguments directly to a shell. While this is the intended behavior (users are running their own commands), `shell: true` enables shell metacharacter expansion (`$()`, `` ` ` ``, `&&`, `||`, `;`). Combined with the injected `HTTP_PROXY` / `HTTPS_PROXY` env vars, this could be used to exfiltrate data.

**Recommendation**: Document the security model explicitly. Consider using `shell: false` (the default) instead.

---

### H5. README and Documentation Are Severely Outdated

**Files**: [README.md](file:///C:/Users/ojass/Projects/TokenDamper/README.md), [CHANGELOG.md](file:///C:/Users/ojass/Projects/TokenDamper/CHANGELOG.md), [ARCHITECTURE.md](file:///C:/Users/ojass/Projects/TokenDamper/ARCHITECTURE.md)

| Issue | Location |
|---|---|
| README says "still at the documentation and implementation-contract stage" | [L102](file:///C:/Users/ojass/Projects/TokenDamper/README.md#L102) |
| README lists "Multi-adapter support" as a non-goal, but MCP adapter exists | [L38](file:///C:/Users/ojass/Projects/TokenDamper/README.md#L38) |
| No installation instructions, usage examples, or API docs | Entire README |
| CHANGELOG only has a placeholder "v0.1.0" entry with no feature list | [CHANGELOG.md#L13-L37](file:///C:/Users/ojass/Projects/TokenDamper/CHANGELOG.md#L13-L37) |
| ARCHITECTURE.md doesn't mention MCP adapter or gateway | ARCHITECTURE.md |
| No `tokendamper mcp` documentation anywhere | — |
| No environment variable documentation | — |

---

## 🟡 Medium Severity Issues

### M1. Version `0.1.0` Is Not Appropriate for a v1 Release

**File**: [package.json#L3](file:///C:/Users/ojass/Projects/TokenDamper/package.json#L3)

The version is `0.1.0` which signals "pre-release/experimental". A public v1 release should use `1.0.0`.

---

### M2. Missing `engines` Field — No Node.js Version Enforcement

**File**: [package.json](file:///C:/Users/ojass/Projects/TokenDamper/package.json)

The codebase uses `node:` module prefixes and modern features requiring Node.js ≥18. Without an `engines` field, users on older Node.js versions will get cryptic errors.

```json
"engines": {
  "node": ">=18.0.0"
}
```

---

### M3. No CI/CD Pipeline

There is no `.github/workflows/` directory. No automated testing, linting, or build verification on pull requests or releases.

---

### M4. `src/index.ts` Does Not Export MCP Adapter

**File**: [src/index.ts](file:///C:/Users/ojass/Projects/TokenDamper/src/index.ts)

The public API entry point doesn't re-export `src/adapters/mcp/`. Users importing `tokendamper` as a library cannot access MCP types or factory functions.

---

### M5. Test Coverage Gaps — No Dedicated Tests for Key Modules

| Module | Test File |
|---|---|
| `src/core/fallback/index.ts` | ❌ None |
| `src/core/stage-registry/index.ts` | ❌ None |
| `src/core/trace/index.ts` | ❌ None |
| `src/gateway/exec.ts` | ❌ None |
| `src/adapters/cli/index.ts` | ❌ None |

MCP adapter tests only cover happy paths — no tests for malformed JSON-RPC, missing required arguments, or unknown tool names.

---

### M6. DevDependency Vulnerability in `eslint` Chain

`npm audit` reports **5 high severity** vulnerabilities in the `brace-expansion` → `minimatch` → `eslint` dependency chain (DoS via unbounded expansion). These are dev-only and don't affect runtime, but should be resolved.

---

### M7. Gateway Proxy Leaks Internal Error Messages

**File**: [server.ts#L104-L106](file:///C:/Users/ojass/Projects/TokenDamper/src/gateway/server.ts#L104-L106)

```typescript
const message = error instanceof Error ? error.message : 'Gateway Internal Error';
res.end(JSON.stringify({ error: message }));
```

Internal error messages (which may contain file paths, stack traces, or configuration details) are sent directly to HTTP clients.

---

## 🟢 Passing Checks

| Check | Status |
|---|---|
| TypeScript strict mode + zero type errors | ✅ |
| 259/259 tests pass across 36 test files | ✅ |
| Zero production dependencies (all devDependencies) | ✅ |
| MIT license file present | ✅ |
| `files` field in package.json properly scopes npm package | ✅ |
| `.gitignore` covers stale/debug files | ✅ |
| No `eval()`, `new Function()`, or hardcoded secrets | ✅ |
| No prototype pollution patterns detected | ✅ |
| `tsconfig.json` has strict, declaration, sourceMap enabled | ✅ |
| Session store has LRU eviction with `maxSessions` cap | ✅ |

---

## Recommendations for Deployment Readiness

### Before Public Release (Blockers)

1. **Fix `emittedOutput`** (C1) — This is the most critical issue. The optimization pipeline does real work but silently discards the result. Either:
   - Emit the optimized bundle as `emittedOutput` when validation passes
   - Or explicitly document that `emittedOutput` is always the safe fallback and provide a separate API for the optimized output
2. **Add body size limit to Gateway** (C2)
3. **Rebuild `dist/`** and add `prepublishOnly` build script (C3)
4. **Add LRU eviction to MCP `traceStore`** (H1)
5. **Cap MCP stdin buffer** (H2)
6. **Add SIGINT/SIGTERM handlers** (H3)
7. **Rewrite README** with installation, usage, MCP docs (H5)
8. **Bump version to `1.0.0`** (M1)
9. **Add `engines` field** (M2)

### Recommended (Non-Blocking)

10. Add CI/CD pipeline (M3)
11. Export MCP adapter from `src/index.ts` (M4)
12. Add error path tests for MCP (M5)
13. Fix `eslint` dependency vulnerabilities (M6)
14. Sanitize gateway error messages (M7)
15. Document `shell: true` risk in `exec.ts` (H4)
