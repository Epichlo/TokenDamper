import { describe, expect, it, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewaySessionStore } from '../../src/gateway/session-store';
import { generateHtmlReport } from '../../src/cli/html-reporter';
import { ELISION_HASH_PREFIX_LENGTH } from '../../src/core/elision';
import { renderSessionElisionMarker } from '../../src/core/elision/marker';
import { createContextBundle, createOptimizationResult } from '../../src/core/model/constructors';
import type { OptimizationResult } from '../../src/core/model/types';

/**
 * Fixes for the 2026-08-30 security review (`docs/security-review-2026-08-30.md`).
 *
 * Each block below is the test that would have caught the finding it names, per the convention in
 * `oxaudit-split.md` §9. The reproductions in the report's §4 are the specification — where a test
 * asserts a literal, it is the literal that reproduction observed.
 */
describe('security review 2026-08-30 — findings', () => {
  // --------------------------------------------------------------------------
  // F-02 — GatewaySessionStore.getContent resolved an arbitrarily short prefix
  // --------------------------------------------------------------------------
  describe('F-02: short-prefix content oracle in GatewaySessionStore.getContent', () => {
    const FULL_HASH = 'deadbeefcafe0123456789abcdef';
    const SECRET = 'SECRET-PLAINTEXT';

    const seeded = (): GatewaySessionStore => {
      const store = new GatewaySessionStore();
      store.storeContent('sess', FULL_HASH, SECRET);
      return store;
    };

    it('still resolves a full digest', () => {
      expect(seeded().getContent('sess', FULL_HASH)).toBe(SECRET);
    });

    it('still resolves the exact prefix length a marker carries', () => {
      const ref = FULL_HASH.slice(0, ELISION_HASH_PREFIX_LENGTH);
      expect(ref).toHaveLength(12);
      expect(seeded().getContent('sess', ref)).toBe(SECRET);
    });

    it('still resolves a real session elision marker, which is the shipping caller', () => {
      // `session-dedup.ts` emits `item.contentHash.slice(0, 12)` as the ref, so the marker path
      // must keep working — it is the only producer, and the guard is keyed to its length.
      const marker = renderSessionElisionMarker({
        refId: FULL_HASH.slice(0, ELISION_HASH_PREFIX_LENGTH),
        originalBytes: 16,
        kind: 'file',
      });
      expect(seeded().getContent('sess', marker)).toBe(SECRET);
    });

    it('refuses a one-character ref — the oracle R-01 demonstrated', () => {
      expect(seeded().getContent('sess', 'd')).toBeUndefined();
    });

    it('refuses an empty ref, which resolved when the session held one block', () => {
      // Session 4b: `hash.startsWith('')` is true for every hash, so a single-block session
      // returned its content for zero guesses. This is the cheapest form of the same defect.
      expect(seeded().getContent('sess', '')).toBeUndefined();
    });

    it('refuses a marker-shaped string carrying a one-character ref', () => {
      // The reachable form: `normalizeHashOrRef` extracts `ref=` out of a marker, so the oracle
      // was drivable from a string and not only from an API call.
      expect(seeded().getContent('sess', '[TokenDamper Elided: ref=d bytes=1 kind=file]')).toBeUndefined();
    });

    it('refuses any prefix shorter than the marker length, including 11 characters', () => {
      for (let n = 1; n < ELISION_HASH_PREFIX_LENGTH; n++) {
        expect(seeded().getContent('sess', FULL_HASH.slice(0, n))).toBeUndefined();
      }
    });

    it('keeps content scoped by session — the negative result R-01 also recorded', () => {
      expect(seeded().getContent('other', FULL_HASH)).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // F-04 — --diff-html wrote a full plaintext copy at the process umask
  // --------------------------------------------------------------------------
  describe('F-04: --diff-html report file permissions', () => {
    let dir: string | undefined;

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    const writeReport = (): string => {
      dir = mkdtempSync(join(tmpdir(), 'td-f04-'));
      const outputPath = join(dir, 'report.html');
      const before = createContextBundle('api_token: sk-live-9999\n', 'file', 'secrets.yaml');
      const after = createContextBundle('api_token: sk-live-9999\n', 'file', 'secrets.yaml');
      const result = createOptimizationResult({
        finalBundle: after,
        emittedOutput: after.items.map((i) => i.content).join('\n'),
        stageResults: [],
        trace: {
          requestId: 'req-f04',
          bundleId: 'b-f04',
          bundleContentHash: 'h-f04',
          planMode: 'pass_through',
          stageCount: 0,
          stageTraces: [],
          inputTokenEstimate: 10,
          outputTokenEstimate: 10,
          tokenBefore: 10,
          tokenAfter: 10,
          bundleStatistics: after.statistics,
          fallbackUsed: false,
        },
        validation: { passed: true, confidence: 1.0, issues: [], shouldFallback: false },
        fallbackUsed: false,
      } as unknown as OptimizationResult);

      generateHtmlReport(result, before, { outputPath });
      return outputPath;
    };

    it('writes the report where it was asked to', () => {
      expect(existsSync(writeReport())).toBe(true);
    });

    // POSIX only: on Windows the mode bits are not the operative access control (ACLs are), which
    // is the caveat R-05 recorded when it could only be run there. Measured on ext4 under WSL2,
    // the pre-fix mode was 644.
    it.skipIf(process.platform === 'win32')('creates it 0600, not at the umask', () => {
      expect(statSync(writeReport()).mode & 0o777).toBe(0o600);
    });

    it.skipIf(process.platform === 'win32')('narrows an existing world-readable file too', () => {
      // `writeFileSync`'s `mode` applies only when the file is *created*, so overwriting a report
      // that already exists would otherwise keep its old, wider mode.
      const path = writeReport();
      chmodSync(path, 0o644);
      const before = createContextBundle('api_token: sk-live-9999\n', 'file', 'secrets.yaml');
      const result = createOptimizationResult({
        finalBundle: before,
        emittedOutput: '',
        stageResults: [],
        trace: {
          requestId: 'r',
          bundleId: 'b',
          bundleContentHash: 'h',
          planMode: 'pass_through',
          stageCount: 0,
          stageTraces: [],
          inputTokenEstimate: 1,
          outputTokenEstimate: 1,
          tokenBefore: 1,
          tokenAfter: 1,
          bundleStatistics: before.statistics,
          fallbackUsed: false,
        },
        validation: { passed: true, confidence: 1.0, issues: [], shouldFallback: false },
        fallbackUsed: false,
      } as unknown as OptimizationResult);
      generateHtmlReport(result, before, { outputPath: path });

      expect(statSync(path).mode & 0o777).toBe(0o600);
    });
  });
});
