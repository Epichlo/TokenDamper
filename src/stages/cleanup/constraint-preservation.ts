import type { ContextBundle, ContextItem, OptimizationBudget, StageResult } from '../../core/model/types';
import { createBundleStatistics, createContextItem, createStageResult, freeze, hashContent } from '../../core/model/constructors';

const IMPERATIVE_KEYWORD_REGEX = /\b(MUST|NEVER|ONLY IF|DO NOT)\b/g;

/**
 * Extracts constraint directive lines containing imperative keywords ('MUST', 'NEVER', 'ONLY IF', 'DO NOT').
 */
export function extractConstraintDirectives(content: string): {
  readonly directives: ReadonlyArray<string>;
  readonly keywords: ReadonlyArray<string>;
} {
  const lines = content.split(/\r?\n/);
  const directives: string[] = [];
  const keywordsSet = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const matches = Array.from(trimmed.matchAll(IMPERATIVE_KEYWORD_REGEX));
    if (matches.length > 0) {
      directives.push(trimmed);
      for (const m of matches) {
        if (m[1]) {
          keywordsSet.add(m[1]);
        }
      }
    }
  }

  return {
    directives: Object.freeze(directives),
    keywords: Object.freeze(Array.from(keywordsSet)),
  };
}

/**
 * Built-in cleanup stage: `cleanup:constraint-preservation`.
 * Scans context items for imperative keywords ('MUST', 'NEVER', 'ONLY IF', 'DO NOT')
 * and records constraint directives in item metadata.
 */
export function runConstraintPreservationStage(
  bundle: ContextBundle,
  _budget: OptimizationBudget,
): StageResult {
  const stageId = 'cleanup:constraint-preservation';
  let totalDirectivesFound = 0;
  let itemsWithConstraints = 0;
  let changed = false;

  const newItems: ContextItem[] = bundle.items.map((item) => {
    const { directives, keywords } = extractConstraintDirectives(item.content);
    const hasConstraints = directives.length > 0;
    const directiveCount = directives.length;

    if (hasConstraints) {
      totalDirectivesFound += directiveCount;
      itemsWithConstraints++;
    }

    const constraintDirectivesJson = JSON.stringify(directives);
    const imperativeKeywordsJson = JSON.stringify(keywords);

    // Check if metadata already matches
    if (
      item.metadata?.hasConstraints === hasConstraints &&
      item.metadata?.directiveCount === directiveCount &&
      item.metadata?.constraintDirectives === constraintDirectivesJson &&
      item.metadata?.imperativeKeywords === imperativeKeywordsJson
    ) {
      return item;
    }

    changed = true;

    const updatedMetadata = freeze({
      ...item.metadata,
      hasConstraints,
      directiveCount,
      constraintDirectives: constraintDirectivesJson,
      imperativeKeywords: imperativeKeywordsJson,
    });

    const newContentHash = hashContent({
      ...item,
      metadata: updatedMetadata,
    });

    return createContextItem({
      id: item.id,
      kind: item.kind,
      contentType: item.contentType,
      content: item.content,
      origin: item.origin,
      contentHash: newContentHash,
      ...(item.role ? { role: item.role } : {}),
      ...(item.path ? { path: item.path } : {}),
      ...(item.language ? { language: item.language } : {}),
      metadata: updatedMetadata,
    });
  });

  if (!changed) {
    return createStageResult({
      stageId,
      status: 'ok',
      bundle,
      changed: false,
      metrics: {
        directivesFound: totalDirectivesFound,
        itemsWithConstraints,
      },
      notes: 'No new constraint directives needed recording.',
    });
  }

  const statistics = createBundleStatistics(newItems);
  const bundleHash = hashContent({
    source: bundle.source,
    items: newItems.map((entry) => entry.contentHash),
    statistics,
  });

  const rawCombined = newItems.map((i) => i.content).join('\n');
  const tokenEstimate = Math.max(1, Math.ceil(rawCombined.length / 4));

  const newBundle: ContextBundle = freeze({
    id: bundleHash,
    bundleId: bundleHash,
    source: bundle.source,
    items: freeze(newItems),
    summary: freeze({
      itemCount: newItems.length,
      tokenEstimate,
      preview: rawCombined.slice(0, 80),
    }),
    statistics,
    contentHash: bundleHash,
  });

  return createStageResult({
    stageId,
    status: 'ok',
    bundle: newBundle,
    changed: true,
    metrics: {
      directivesFound: totalDirectivesFound,
      itemsWithConstraints,
    },
    notes: `Recorded ${totalDirectivesFound} constraint directive(s) across ${itemsWithConstraints} item(s).`,
  });
}
