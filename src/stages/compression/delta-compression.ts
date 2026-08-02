import type { ContextBundle, ContextItem, OptimizationBudget, StageResult } from '../../core/model/types';
import { createBundleStatistics, createStageResult, freeze, hashContent } from '../../core/model/constructors';
import { computeLineDiff } from '../../core/utils/myers-diff';
import { elideItem, type ElisionSkipReason } from '../../core/elision';

export interface DeltaCompressionOptions {
  readonly previousItems?: ReadonlyArray<ContextItem>;
  readonly previousBundle?: ContextBundle;
  readonly baseVersions?: ReadonlyMap<string, string> | Record<string, string>;
  readonly contextLines?: number;
}

/**
 * Creates a unified line diff representation with hunk context between two text versions.
 */
export function createUnifiedDiff(
  oldText: string,
  newText: string,
  oldLabel: string,
  newLabel: string,
  contextSize = 3,
): string {
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);

  const lineDiffs = computeLineDiff(oldLines, newLines);
  const diffOps: Array<{ op: 'keep' | 'add' | 'delete'; line: string }> = lineDiffs.map((d) => ({
    op: d.type,
    line: d.line,
  }));

  // Determine which lines are within context range of changes
  const len = diffOps.length;
  const include = new Array<boolean>(len).fill(false);

  for (let idx = 0; idx < len; idx++) {
    if (diffOps[idx]!.op !== 'keep') {
      const start = Math.max(0, idx - contextSize);
      const end = Math.min(len - 1, idx + contextSize);
      for (let k = start; k <= end; k++) {
        include[k] = true;
      }
    }
  }

  // Group contiguous included indices into hunks
  const hunks: Array<{
    oldStart: number;
    oldLength: number;
    newStart: number;
    newLength: number;
    lines: Array<{ op: 'keep' | 'add' | 'delete'; line: string }>;
  }> = [];

  let currentOldLine = 1;
  let currentNewLine = 1;
  let inHunk = false;
  let currentHunk: (typeof hunks)[number] | null = null;

  for (let idx = 0; idx < len; idx++) {
    const op = diffOps[idx]!;
    const shouldInclude = include[idx]!;

    if (shouldInclude) {
      if (!inHunk) {
        inHunk = true;
        currentHunk = {
          oldStart: currentOldLine,
          oldLength: 0,
          newStart: currentNewLine,
          newLength: 0,
          lines: [],
        };
        hunks.push(currentHunk);
      }

      currentHunk!.lines.push(op);

      if (op.op === 'keep') {
        currentHunk!.oldLength++;
        currentHunk!.newLength++;
        currentOldLine++;
        currentNewLine++;
      } else if (op.op === 'delete') {
        currentHunk!.oldLength++;
        currentOldLine++;
      } else if (op.op === 'add') {
        currentHunk!.newLength++;
        currentNewLine++;
      }
    } else {
      inHunk = false;
      if (op.op === 'keep') {
        currentOldLine++;
        currentNewLine++;
      } else if (op.op === 'delete') {
        currentOldLine++;
      } else if (op.op === 'add') {
        currentNewLine++;
      }
    }
  }

  const header = `--- ${oldLabel}\n+++ ${newLabel}`;
  const hunkTexts = hunks.map((hunk) => {
    const hunkHeader = `@@ -${hunk.oldStart},${hunk.oldLength} +${hunk.newStart},${hunk.newLength} @@`;
    const hunkBody = hunk.lines
      .map((entry) => {
        if (entry.op === 'keep') return ` ${entry.line}`;
        if (entry.op === 'add') return `+${entry.line}`;
        return `-${entry.line}`;
      })
      .join('\n');
    return `${hunkHeader}\n${hunkBody}`;
  });

  return `${header}\n${hunkTexts.join('\n')}`;
}

/**
 * Built-in compression stage: `compression:delta-compression`.
 * Generates unified diffs for modified context files across conversation turns.
 */
export function runDeltaCompressionStage(
  bundle: ContextBundle,
  budget: OptimizationBudget,
  options?: DeltaCompressionOptions,
): StageResult {
  const stageId = 'compression:delta-compression';

  if (!options) {
    return createStageResult({
      stageId,
      status: 'ok',
      bundle,
      changed: false,
      metrics: {
        itemsCompressed: 0,
        bytesSaved: 0,
        tokenEstimateSaved: 0,
      },
      notes: 'No base versions or previous bundle available for delta compression.',
    });
  }

  const preserveKinds = new Set(budget.preserveKinds);
  let changed = false;
  let itemsCompressed = 0;
  let itemsSkipped = 0;
  let bytesSaved = 0;
  const skipReasons: Record<ElisionSkipReason, number> = {
    no_savings: 0,
    post_condition_rejected: 0,
  };

  const previousItems = options.previousItems ?? options.previousBundle?.items ?? [];

  const getBaseContent = (item: ContextItem): { content: string; hash: string } | undefined => {
    for (const prev of previousItems) {
      if ((item.path && prev.path === item.path) || prev.id === item.id || prev.origin === item.origin) {
        return { content: prev.content, hash: prev.contentHash };
      }
    }

    if (options.baseVersions) {
      const keys = item.path ? [item.path, item.id, item.origin] : [item.id, item.origin];
      for (const key of keys) {
        if (options.baseVersions instanceof Map) {
          const val = options.baseVersions.get(key);
          if (val !== undefined) {
            return { content: val, hash: hashContent(val) };
          }
        } else if (typeof options.baseVersions === 'object') {
          const val = (options.baseVersions as Record<string, string>)[key];
          if (val !== undefined) {
            return { content: val, hash: hashContent(val) };
          }
        }
      }
    }

    return undefined;
  };

  const newItems: ContextItem[] = bundle.items.map((item) => {
    // Rule 1: Never delta compress preserved kinds
    if (preserveKinds.has(item.kind)) {
      return item;
    }

    // Rule 2: Never compress system prompts
    if (item.role === 'system') {
      return item;
    }

    // Rule 3: Skip items already elided
    if (item.metadata.elided) {
      return item;
    }

    const base = getBaseContent(item);
    if (!base || base.content === item.content) {
      return item;
    }

    const labelOld = item.path ? `${item.path} (base:${base.hash.slice(0, 8)})` : `base:${base.hash.slice(0, 8)}`;
    const labelNew = item.path ? `${item.path} (current:${item.contentHash.slice(0, 8)})` : `current:${item.contentHash.slice(0, 8)}`;

    const diff = createUnifiedDiff(base.content, item.content, labelOld, labelNew, options.contextLines ?? 3);
    const deltaContent = `[TokenDamper Delta: path=${item.path ?? item.origin} baseHash=${base.hash.slice(0, 12)}]\n${diff}`;

    const originalLength = item.content.length;

    // Routed through the shared chokepoint. A unified diff is multi-line and is not valid
    // JSON, so this stage had the same latent defect as the other two (Issue 2). A refusal
    // skips the item and the stage continues.
    const outcome = elideItem({
      item,
      marker: deltaContent,
      contentHash: hashContent({ originalHash: item.contentHash, deltaContent }),
      metadata: {
        ...item.metadata,
        elided: true,
        deltaCompressed: true,
        baseContentHash: base.hash,
        originalBytes: originalLength,
        originalContent: item.content,
      },
    });

    if (outcome.status === 'skipped') {
      itemsSkipped += 1;
      skipReasons[outcome.reason] += 1;
      return item;
    }

    changed = true;
    itemsCompressed += 1;
    bytesSaved += outcome.bytesSaved;

    return outcome.item;
  });

  if (!changed) {
    return createStageResult({
      stageId,
      status: 'ok',
      bundle,
      changed: false,
      metrics: {
        itemsCompressed: 0,
        itemsSkipped,
        skippedNoSavings: skipReasons.no_savings,
        skippedPostConditionRejected: skipReasons.post_condition_rejected,
        bytesSaved: 0,
        tokenEstimateSaved: 0,
      },
      notes:
        itemsSkipped > 0
          ? `No items delta-compressed; skipped ${itemsSkipped} (${skipReasons.post_condition_rejected} rejected by post-condition, ${skipReasons.no_savings} for no savings).`
          : 'No matching modified items found for delta compression.',
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

  const tokenEstimateSaved = Math.max(0, Math.ceil(bytesSaved / 4));

  return createStageResult({
    stageId,
    status: 'ok',
    bundle: newBundle,
    changed: true,
    metrics: {
      itemsCompressed,
      itemsSkipped,
      skippedNoSavings: skipReasons.no_savings,
      skippedPostConditionRejected: skipReasons.post_condition_rejected,
      bytesSaved,
      tokenEstimateSaved,
    },
    notes: `Successfully delta-compressed ${itemsCompressed} item(s); skipped ${itemsSkipped} (${skipReasons.post_condition_rejected} rejected by post-condition, ${skipReasons.no_savings} for no savings).`,
  });
}
