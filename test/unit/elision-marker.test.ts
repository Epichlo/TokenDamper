import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyContent,
  createBundleFromItems,
  createContextItem,
  createOptimizationBudget,
  hashContent,
} from '../../src/core/model/constructors';
import {
  describeContentType,
  ELISION_MARKER_BYTES,
  ELISION_MARKER_PATTERN,
  renderElisionMarker,
} from '../../src/core/elision';
import { runTokenHashingStage } from '../../src/stages/compression/token-hashing';
import { TokenHasher } from '../../src/core/hashing/token-hasher';

const budget = createOptimizationBudget({ riskTolerance: 'low', preserveKinds: [] });
const SOURCE = readFileSync(resolve(process.cwd(), 'src/core/hashing/token-hasher.ts'), 'utf8');
const LOGS = readFileSync(
  resolve(process.cwd(), 'tokendamper-benchmark/test_data/sample_logs.txt'),
  'utf8',
);

function bundleOf(content: string, path?: string) {
  return createBundleFromItems([
    createContextItem({
      id: 'a',
      kind: 'file',
      contentType: classifyContent(content, path ? 'file' : 'text', path),
      content,
      ...(path ? { path } : {}),
    }),
  ]);
}

describe('an elision marker says what it replaced', () => {
  it('names the quantity, the unit and the kind, and keeps the hash as one field', () => {
    const text = 'alpha\nbravo\ncharlie\n';
    const marker = renderElisionMarker(text, 'log', hashContent(text));

    expect(marker).toMatch(/^\[TokenDamper: 4 log lines elided, 20 bytes, sha256:[a-f0-9]{12}\]$/);
    // The hash is present for provenance, and is not the whole message.
    expect(marker.replace(/sha256:[a-f0-9]{12}/, '')).toContain('4 log lines elided');
  });

  it('uses the singular for a one-line elision', () => {
    expect(renderElisionMarker('one line', 'text', hashContent('x'))).toContain(
      '1 text line elided',
    );
  });

  it('is deterministic', () => {
    const a = renderElisionMarker(SOURCE, 'code', hashContent(SOURCE));
    const b = renderElisionMarker(SOURCE, 'code', hashContent(SOURCE));
    expect(a).toBe(b);
  });

  it('stays within the byte budget the region floor is derived from', () => {
    // The floor in `regions.ts` is `ELISION_MARKER_BYTES + 24`. If a realistic marker can
    // exceed the budget the floor stops being conservative and small regions can grow.
    const longest = renderElisionMarker(
      'x\n'.repeat(500), // 3 digits of lines, 4 digits of bytes
      'function-body',
      hashContent('x'),
    );
    expect(longest.length).toBeLessThanOrEqual(ELISION_MARKER_BYTES);
  });

  it('describes every content type', () => {
    for (const contentType of [
      'text',
      'markdown',
      'code',
      'html',
      'json',
      'yaml',
      'logs',
      'unknown',
    ] as const) {
      expect(describeContentType(contentType)).toMatch(/^[a-z-]+$/);
    }
  });
});

describe('the stage emits it on both paths', () => {
  it('names the function body on the sub-item path', () => {
    const result = runTokenHashingStage(bundleOf(SOURCE, 'src/a.ts'), budget, {});
    const content = result.bundle.items[0]!.content;

    expect(result.metrics.regionsHashed).toBeGreaterThan(0);
    expect(content).toContain('function-body lines elided');
    // Matched by shape, not by substring: this fixture is `token-hasher.ts`, whose retained
    // source legitimately contains the text `<BLOCK_HASH:` in a regex and a docblock. The
    // claim is that the stage no longer *writes* the old marker, and only the old marker
    // carries a full 64-character digest.
    expect(content).not.toMatch(/<BLOCK_HASH:[a-f0-9]{64}>/);
  });

  it('names the content type on the whole-item path', () => {
    const result = runTokenHashingStage(bundleOf(LOGS, 'sample_logs.txt'), budget, {});
    const content = result.bundle.items[0]!.content;

    expect(result.metrics.regionsHashed).toBe(0);
    expect(content).toMatch(
      /^\[TokenDamper: 76 log lines elided, \d+ bytes, sha256:[a-f0-9]{12}\]$/,
    );
  });
});

describe('the reverse path still resolves what the store holds', () => {
  it('round-trips a sub-item elision byte-for-byte', () => {
    const hasher = new TokenHasher();
    const result = runTokenHashingStage(bundleOf(SOURCE, 'src/a.ts'), budget, {
      tokenHasher: hasher,
    });

    expect(result.bundle.items[0]!.content).not.toBe(SOURCE);
    expect(hasher.rehydrateText(result.bundle.items[0]!.content)).toBe(SOURCE);
  });

  it('round-trips a whole-item elision', () => {
    const hasher = new TokenHasher();
    const result = runTokenHashingStage(bundleOf(LOGS, 'sample_logs.txt'), budget, {
      tokenHasher: hasher,
    });

    expect(hasher.rehydrateText(result.bundle.items[0]!.content)).toBe(LOGS);
  });

  it('leaves a marker alone when the store does not hold it', () => {
    const orphan = renderElisionMarker('gone', 'text', hashContent('gone'));
    expect(new TokenHasher().rehydrateText(orphan)).toBe(orphan);
  });

  it('still reads the previous <BLOCK_HASH:> format', () => {
    // Only one format is written, but text captured before this change must still resolve.
    const hasher = new TokenHasher();
    const placeholder = hasher.createBlockPlaceholder('retained content');
    expect(hasher.rehydrateText(`before ${placeholder} after`)).toBe(
      'before retained content after',
    );
  });

  it('refuses an ambiguous truncated hash rather than guessing', () => {
    const hasher = new TokenHasher();
    hasher.registerBlock('aaaaaaaaaaaa1111', 'first');
    hasher.registerBlock('aaaaaaaaaaaa2222', 'second');

    // Both share the 12-character prefix a marker would carry.
    expect(hasher.hasHash('aaaaaaaaaaaa')).toBe(false);
    expect(hasher.expandBlockHash('aaaaaaaaaaaa')).toBeUndefined();
    // The unambiguous full digests still resolve.
    expect(hasher.expandBlockHash('aaaaaaaaaaaa1111')).toBe('first');
  });
});

describe('the marker pattern does not capture the other stages markers', () => {
  it('ignores session-dedup and delta-compression markers', () => {
    const pattern = new RegExp(ELISION_MARKER_PATTERN.source, 'g');
    expect(pattern.test('[TokenDamper Elided: ref=abc123 bytes=40 kind=file]')).toBe(false);
    expect(pattern.test('[TokenDamper Delta: path=a.ts baseHash=abc123456789]')).toBe(false);
  });
});
