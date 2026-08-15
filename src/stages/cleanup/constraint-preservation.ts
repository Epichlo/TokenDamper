import type { ContextBundle, ContextItem, OptimizationBudget, StageResult } from '../../core/model/types';
import { createBundleStatistics, createContextItem, createStageResult, freeze, hashContent } from '../../core/model/constructors';
import { extractImperativeDirectives, extractProseRegions } from '../../core/constraints/directives';
import { estimateBundleTokens } from '../../core/hashing/tokenizer';
import type { ContentType } from '../../core/model/types';

/**
 * Extracts constraint directive sentences or clauses containing imperative keywords.
 *
 * `contentType` is optional so existing callers that scan a bare string keep working; it
 * defaults to `text`, which scans everything, i.e. the pre-H6 behaviour. Pass the item's real
 * content type to get the region filter — see `extractProseRegions`.
 */
export function extractConstraintDirectives(
  content: string,
  contentType: ContentType = 'text',
): {
  readonly directives: ReadonlyArray<string>;
  readonly keywords: ReadonlyArray<string>;
} {
  return extractImperativeDirectives(extractProseRegions(content, contentType));
}

/**
 * Built-in cleanup stage: `cleanup:constraint-preservation`.
 * Scans context items for imperative constraint directives
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
    const { directives, keywords } = extractConstraintDirectives(item.content, item.contentType);
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

    // This folds the *previous* `contentHash` into the new one, because `...item` carries it.
    // Audit L4, recorded rather than changed — and its premise needs correcting first.
    //
    // L4 says that after this stage `item.contentHash` is "no longer a hash of `item.content`",
    // implying it was one before. On the route that reaches this stage it never was:
    // `createContextBundle` hashes `{source, sourcePath, content, kind, contentType, metadata,
    // language}` — a provenance hash — and sets `id` to it. Only `createContextItem`'s default
    // is content-only. So the real defect is narrower: the value is *chained*, so two items
    // identical in every field after this stage hash differently if their histories differed.
    //
    // Not changed, for two reasons. It is unreachable: the one consumer that treats this hash as
    // a content identity is `cleanup:session-dedup`, which keys cross-turn dedup on it, and that
    // stage runs only under `session_dedup` planner mode — where this stage is not planned. The
    // knapsack list that does plan this stage never plans that one. And changing it would move
    // `bundle.contentHash` and every id pinned in the suite while moving no output byte, which
    // is the churn-for-nothing shape this project has talked itself out of before.
    //
    // What would make it live: planning both stages in one list, or any new consumer comparing
    // this hash across a bundle boundary. Do that and fix this first.
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
  const tokenEstimate = estimateBundleTokens(newItems);

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
