import { describe, expect, it } from 'vitest';
import {
  classifyContent,
  createBundleFromItems,
  createContextItem,
  createOptimizationBudget,
  createOptimizationPlan,
} from '../../src/core/model/constructors';
import type { ContentType } from '../../src/core/model/types';
import { validate } from '../../src/core/validation';
import { selectValidator, validateBundleAst, validateItemAst } from '../../src/core/validation/ast';
import { optimize } from '../../src/core/engine';
import { loadConfig } from '../../src/config/load';
import { createOptimizationRequest } from '../../src/core/model/constructors';
import { TOKENDAMPER_VERSION } from '../../src/version';

const BROKEN_TS = [
  'export function beta(items: Array<string>): string {',
  '  const label = "unterminated;',
  '  return label;',
  '}',
].join('\n');

const plan = createOptimizationPlan({
  planId: 'test',
  mode: 'pass_through',
  stageIds: [],
  revalidationPoints: [],
  fallbackPolicy: 'original_input',
});
const budget = createOptimizationBudget({ riskTolerance: 'low', preserveKinds: [] });

describe('"no validator applied" is not "the check passed"', () => {
  it('reports validated: false for an item nothing covers', () => {
    const item = createContextItem({
      id: 'prose',
      kind: 'conversation',
      contentType: 'text',
      content: 'Please review the deployment notes before Thursday.',
    });

    const result = validateItemAst(item);

    // `valid` stays true on purpose — an unchecked item is not a failing item, and
    // inverting it would fall the engine back on every prose message.
    expect(result.valid).toBe(true);
    expect(result.validated).toBe(false);
    expect(result.validatorLanguage).toBeUndefined();
  });

  it('reports validated: true and names the validator when one runs', () => {
    const item = createContextItem({
      id: 'src',
      kind: 'file',
      contentType: 'code',
      content: 'export const a = 1;\n',
      path: 'src/a.ts',
    });

    const result = validateItemAst(item);

    expect(result.validated).toBe(true);
    expect(result.validatorLanguage).toBe('typescript');
  });

  it('distinguishes unchecked TypeScript from checked TypeScript on the same bytes', () => {
    // This is the shape that reached a provider unexamined. A Gateway message carries no
    // path and no language, so `contentType` is the only signal; when `classifyContent`
    // answered `html` for code, `selectValidator` returned null and the result was
    // indistinguishable from a clean pass.
    const withPath = createContextItem({
      id: 'a',
      kind: 'file',
      contentType: classifyContent(BROKEN_TS, 'file', 'src/a.ts'),
      content: BROKEN_TS,
      path: 'src/a.ts',
    });
    const pathless = createContextItem({
      id: 'b',
      kind: 'conversation',
      contentType: classifyContent(BROKEN_TS, 'text'),
      content: BROKEN_TS,
    });

    const checked = validateItemAst(withPath);
    expect(checked.validated).toBe(true);
    expect(checked.valid).toBe(false);

    const unchecked = validateItemAst(pathless);
    expect(unchecked.validated).toBe(false);
    expect(unchecked.valid).toBe(true);
  });

  it('lists the unvalidated items on the bundle result', () => {
    const bundle = createBundleFromItems([
      createContextItem({
        id: 'code',
        kind: 'file',
        contentType: 'code',
        content: 'const a = 1;\n',
        path: 'a.ts',
      }),
      createContextItem({ id: 'note', kind: 'note', contentType: 'text', content: 'a plain note' }),
    ]);

    const result = validateBundleAst(bundle);

    expect(result.valid).toBe(true);
    expect([...result.unvalidatedItemIds]).toEqual(['note']);
  });
});

describe('validation reports AST coverage without voting on it', () => {
  it('emits an info issue and still passes when an item is unchecked', () => {
    const bundle = createBundleFromItems([
      createContextItem({ id: 'note', kind: 'note', contentType: 'text', content: 'a plain note' }),
    ]);

    const report = validate(bundle, bundle, plan, budget);

    expect(report.astCoverage).toEqual({
      checked: 0,
      unchecked: 1,
      uncheckedContentTypes: ['text'],
    });

    const skipped = report.issues.filter((issue) => issue.code === 'AST_VALIDATION_SKIPPED');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.severity).toBe('info');

    // An informational finding must not force a fallback. Verdicts are error-scoped.
    expect(report.passed).toBe(true);
    expect(report.shouldFallback).toBe(false);
    expect(report.reason).toBeUndefined();
  });

  it('reports full coverage with no info issue when every item is checked', () => {
    const bundle = createBundleFromItems([
      createContextItem({
        id: 'code',
        kind: 'file',
        contentType: 'code',
        content: 'const a = 1;\n',
        path: 'a.ts',
      }),
    ]);

    const report = validate(bundle, bundle, plan, budget);

    expect(report.astCoverage).toEqual({ checked: 1, unchecked: 0, uncheckedContentTypes: [] });
    expect(report.issues.filter((issue) => issue.code === 'AST_VALIDATION_SKIPPED')).toHaveLength(
      0,
    );
  });

  it('surfaces coverage on the trace, which is all the CLI emits', () => {
    const request = createOptimizationRequest(
      'Please review the deployment notes.\n',
      loadConfig(),
      {
        requestId: 'trace-coverage',
        adapterName: 'cli',
        adapterVersion: TOKENDAMPER_VERSION,
        source: 'text',
      },
    );

    const result = optimize(request);

    expect(result.trace.astCoverage).toEqual({
      checked: 0,
      unchecked: 1,
      uncheckedContentTypes: ['text'],
    });
  });
});

describe('the content-type dispatch table is total', () => {
  // Compile-time exhaustiveness (`Record<ContentType, …>`) is what actually prevents an
  // unhandled tag; this asserts the runtime edge stays fail-open for every member and for a
  // forged value, because `selectValidator` sits inside the fail-open path (invariant 3).
  const ALL: ReadonlyArray<ContentType> = [
    'text',
    'markdown',
    'code',
    'html',
    'json',
    'yaml',
    'logs',
    'unknown',
  ];

  it('answers for every ContentType member without throwing', () => {
    for (const contentType of ALL) {
      const item = createContextItem({ id: contentType, kind: 'note', contentType, content: 'x' });
      expect(() => selectValidator(item)).not.toThrow();
    }
  });

  it('does not throw on a content type outside the union', () => {
    const item = createContextItem({
      id: 'forged',
      kind: 'note',
      contentType: 'xml' as ContentType,
      content: 'x',
    });
    expect(selectValidator(item)).toBeNull();
  });
});
