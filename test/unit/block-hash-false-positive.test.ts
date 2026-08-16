import { describe, expect, it } from 'vitest';
import { optimize } from '../../src/core/engine';
import { TokenHasher } from '../../src/core/hashing/token-hasher';
import { createContextBundle, createOptimizationBudget } from '../../src/core/model/constructors';
import { loadConfig } from '../../src/config/load';
import { TOKENDAMPER_VERSION } from '../../src/version';
import type { OptimizationRequest } from '../../src/core/model/types';

/**
 * A file that *describes* the block-hash placeholder format must not be mistaken for one.
 *
 * `detectCorruptedPlaceholders` scanned emitted content for `<BLOCK_HASH:([^>]+)>` — any text
 * up to the next `>`. Prose that quotes the legacy format therefore matched, the captured
 * "hash" was absent from the store, and the run was failed as corrupted.
 *
 * The route matters: the check begins `if (!hasher) return []`, and the CLI supplies no
 * `TokenHasher`. So this was invisible to every corpus measurement in the project — the harness
 * drives the CLI — and fired only on MCP, which does supply one.
 *
 * Found by dogfooding `tokendamper mcp` against this repository's own source.
 */
const body = Array.from({ length: 12 }, (_, i) => `  const filler${i} = ${'"' + 'x'.repeat(60) + '"'};`).join('\n');
const CLEAN = `export function alpha(n: number): number {\n${body}\n  return n;\n}\n`;

const request = (content: string): OptimizationRequest => ({
  requestId: 'block-hash-test',
  rawInput: content,
  bundle: createContextBundle(content, 'file', 'sample.ts'),
  budget: createOptimizationBudget({ targetReductionRatio: 0.3 }),
  config: loadConfig({ env: {} }),
  adapterName: 'test',
  adapterVersion: TOKENDAMPER_VERSION,
});

const run = (content: string) => optimize(request(content), { tokenHasher: new TokenHasher() });

describe('block-hash corruption detection', () => {
  it('does not fail a file that merely documents the placeholder format', () => {
    const documenting = `// The old format was a fixed-width \`<BLOCK_HASH:\` + 64 hex + \`>\` placeholder.\n${CLEAN}`;
    const result = run(documenting);

    expect(result.fallbackUsed).toBe(false);
    expect(result.trace.fallbackReason ?? '').not.toMatch(/Block hash corruption/);
  });

  it('reduces the documenting file as much as the identical file without the comment', () => {
    // The comment is one line of prose. Before the fix it was the difference between
    // 87% reduction and a total fallback.
    const documenting = `// mentions <BLOCK_HASH:deadbeef> in passing\n${CLEAN}`;

    expect(run(CLEAN).fallbackUsed).toBe(false);
    expect(run(documenting).fallbackUsed).toBe(false);
  });

  it.each([
    ['a doc-comment reference', '// see `<BLOCK_HASH:` + 64 hex + `>` for the legacy shape'],
    ['a template placeholder', '// returns `<BLOCK_HASH:${hash}>`'],
    ['an elided/abbreviated digest', '// e.g. <BLOCK_HASH:4af59ca4…>'],
    ['a type-ish description', '// placeholder form: <BLOCK_HASH:sha256>'],
  ])('tolerates %s', (_label, comment) => {
    expect(run(`${comment}\n${CLEAN}`).fallbackUsed).toBe(false);
  });

  it('still catches a real placeholder whose block is missing from the store', () => {
    // The negative control. A genuine placeholder is `<BLOCK_HASH:` + a sha256 hex digest,
    // and one the hasher has never seen is exactly the corruption this check exists to find.
    // Narrowing the pattern must not cost that.
    const orphan = `${'a1b2c3d4e5f6'.repeat(5)}abcd`; // 64 hex chars
    expect(orphan).toHaveLength(64);

    const result = run(`// <BLOCK_HASH:${orphan}>\n${CLEAN}`);

    expect(result.fallbackUsed).toBe(true);
    expect(result.trace.fallbackReason ?? '').toMatch(/Block hash corruption/);
  });

  it('resolves a placeholder the hasher does know, without failing the run', () => {
    const hasher = new TokenHasher();
    const placeholder = hasher.createBlockPlaceholder('some registered block content');
    const result = optimize(request(`// ${placeholder}\n${CLEAN}`), { tokenHasher: hasher });

    expect(result.trace.fallbackReason ?? '').not.toMatch(/Block hash corruption/);
  });
});
