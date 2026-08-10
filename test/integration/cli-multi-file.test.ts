import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/main';

/**
 * Multi-file ingestion — audit H5, DECISIONS §43.
 *
 * Until this existed, `createContextBundle` produced exactly **one** item for every shipping
 * entry point. `applyCacheAwarePrefixLocking` pins everything inside the first 1,024 tokens, and
 * `solve01Knapsack` places pinned items outside the candidate set and always selects them, so on
 * a one-item bundle item 0 was always pinned, `itemsPruned` was always 0, and the knapsack
 * solver, cache-aware prefix locking, topology scoring, the dependency graph and the git
 * inspector could not affect any output the product was able to produce.
 *
 * Measured after the change, on `src/core` at `maxInputTokens: 4000`: 31 items ingested, **15
 * pruned**, 20,540 tokens saved by the planner.
 */
describe('optimize over more than one file', () => {
  let dir: string;

  const capture = () => {
    const out: Buffer[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: {
        stdout: { write: (c: unknown) => { out.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8')); return true; } } as never,
        stderr: { write: (c: unknown) => { err.push(String(c)); return true; } } as never,
      },
    };
  };

  const write = (name: string, content: string): string => {
    const p = join(dir, name);
    writeFileSync(p, content, 'utf8');
    return p;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tokendamper-multi-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const FILE_A = 'export const alpha = 1;\nexport const beta = 2;\n';
  const FILE_B = 'export const gamma = 3;\nexport const delta = 4;\n';

  it('emits one delimited section per file', () => {
    const a = write('a.ts', FILE_A);
    const b = write('b.ts', FILE_B);

    const { out, io } = capture();
    const code = runCli(['optimize', a, b, '--target-reduction-ratio', '0.3'], io, dir);
    const stdout = Buffer.concat(out).toString('utf8');

    expect(code).toBe(0);
    expect(stdout.split('==> ').length - 1).toBe(2);
    expect(stdout).toContain(a);
    expect(stdout).toContain(b);
    // Both files' content survives — this run has nothing worth eliding.
    expect(stdout).toContain('export const alpha = 1;');
    expect(stdout).toContain('export const gamma = 3;');
  });

  it('leaves the single-file route byte-identical, with no header', () => {
    // The compatibility guarantee that makes the whole change safe. A one-item bundle must be
    // indistinguishable from what it was before multi-file ingestion existed.
    const a = write('a.ts', FILE_A);

    const { out, io } = capture();
    const code = runCli(['optimize', a, '--target-reduction-ratio', '0.3'], io, dir);
    const stdout = Buffer.concat(out).toString('utf8');

    expect(code).toBe(0);
    expect(stdout).not.toContain('==>');
    expect(stdout).toBe(FILE_A);
  });

  it('walks a directory, deterministically and without descending into node_modules', () => {
    write('b.ts', FILE_B);
    write('a.ts', FILE_A);
    writeFileSync(join(dir, 'notes.md'), '# Notes\n\nSome prose.\n', 'utf8');

    // A dependency tree that must not be swept in. Created for real — an exclusion test that
    // silently fails to create the thing being excluded asserts nothing.
    const nm = join(dir, 'node_modules');
    mkdirSync(nm, { recursive: true });
    const depFile = join(nm, 'dep.ts');
    writeFileSync(depFile, 'export const dep = 0;\n', 'utf8');
    expect(existsSync(depFile)).toBe(true);

    // A binary that the extension filter must skip even outside node_modules.
    writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const { out, io } = capture();
    const code = runCli(['optimize', dir, '--target-reduction-ratio', '0.3'], io, dir);
    const stdout = Buffer.concat(out).toString('utf8');

    expect(code).toBe(0);
    expect(stdout).not.toContain('export const dep = 0;');
    // The markdown file is ingestible and must be present, so the walk is not simply empty.
    expect(stdout).toContain('# Notes');
    expect(stdout).not.toContain('logo.png');

    // Sorted, because prefix locking pins the first ~1,024 tokens and therefore decides which
    // files bypass the knapsack entirely. A filesystem-ordered walk would make that arbitrary.
    const order = [...stdout.matchAll(/==> (.+?) <==/g)].map((m) => m[1]!);
    expect([...order].sort()).toEqual(order);
  });

  it('hands back every file byte-for-byte on fallback, including one that is not valid UTF-8', () => {
    // Fail-open is per file. `renderFallbackBytes` writes the original buffers rather than a
    // re-encoding of the decoded strings, so DECISIONS §35's guarantee holds per item — what is
    // not byte-identical is the stream as a whole, because the headers are TokenDamper's.
    const a = write('a.ts', FILE_A);
    const latin1 = join(dir, 'latin1.ts');
    // 0xE9 is `é` in Latin-1 and an illegal lone lead byte in UTF-8.
    const latin1Bytes = Buffer.concat([
      Buffer.from('// caf', 'utf8'),
      Buffer.from([0xe9]),
      Buffer.from('\nexport const x = 1;\n', 'utf8'),
    ]);
    writeFileSync(latin1, latin1Bytes);

    const { out, io } = capture();
    const code = runCli(['optimize', a, latin1, '--target-reduction-ratio', '0.3'], io, dir);
    const stdout = Buffer.concat(out);

    expect(code).toBe(0);
    // The exact bytes appear in the stream, un-re-encoded.
    expect(stdout.includes(latin1Bytes)).toBe(true);
    expect(stdout.includes(Buffer.from(FILE_A, 'utf8'))).toBe(true);
    expect(readFileSync(latin1).equals(latin1Bytes)).toBe(true);
  });

  it('does not report a negative reduction when nothing changed', () => {
    // The envelope headers are TokenDamper's framing and appear on both the input and output
    // side of a multi-item run. Counted on one side only, a fallback reported 72,973 -> 73,667
    // tokens — the same shape as the phantom -1.39% the project already diagnosed once in the
    // Python bench harness (Issue 5).
    const a = write('a.ts', FILE_A);
    const b = write('b.ts', FILE_B);

    const { err, io } = capture();
    runCli(['optimize', a, b, '--target-reduction-ratio', '0.3'], io, dir);
    const trace = JSON.parse(err.join('')) as { tokenBefore: number; tokenAfter: number };

    expect(trace.tokenAfter).toBeLessThanOrEqual(trace.tokenBefore);
  });
});
