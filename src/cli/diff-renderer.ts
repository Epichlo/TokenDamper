import type { ContextBundle } from '../core/model';
import { computeLineDiff as sharedComputeLineDiff } from '../core/utils/myers-diff';

export interface DiffRenderOptions {
  readonly color?: boolean; // Default: true
  readonly mode?: 'unified' | 'side-by-side'; // Default: 'unified'
  readonly contextLines?: number; // Default: 3
}

interface LineOp {
  type: 'keep' | 'add' | 'delete';
  line: string;
  lineNoBefore?: number;
  lineNoAfter?: number;
}

/**
 * Renders a terminal ANSI visual diff between before and after bundles or raw text strings.
 */
export function renderTerminalDiff(
  before: ContextBundle | string,
  after: ContextBundle | string,
  options?: DiffRenderOptions,
): string {
  const useColor = options?.color ?? true;
  const mode = options?.mode ?? 'unified';
  const contextLines = options?.contextLines ?? 3;

  const beforeText = extractText(before);
  const afterText = extractText(after);

  const linesBefore = beforeText.split('\n');
  const linesAfter = afterText.split('\n');

  const ops = computeLineDiff(linesBefore, linesAfter);

  const output: string[] = [];

  // 1. Header Banner
  const title = 'TokenDamper Optimization Visual Diff';
  const border = '='.repeat(60);
  if (useColor) {
    output.push(`\x1b[1;36m${border}\x1b[0m`);
    output.push(`\x1b[1;35m  ${title}\x1b[0m`);
    output.push(`\x1b[1;36m${border}\x1b[0m`);
  } else {
    output.push(border);
    output.push(`  ${title}`);
    output.push(border);
  }

  if (mode === 'side-by-side') {
    output.push(renderSideBySide(ops, useColor));
  } else {
    output.push(renderUnified(ops, contextLines, useColor));
  }

  return output.join('\n');
}

function extractText(input: ContextBundle | string): string {
  if (typeof input === 'string') {
    return input;
  }
  return input.items.map((item) => item.content).join('\n');
}

function computeLineDiff(a: string[], b: string[]): LineOp[] {
  const rawOps = sharedComputeLineDiff(a, b);
  const ops: LineOp[] = [];
  let lineNoBefore = 1;
  let lineNoAfter = 1;

  for (const op of rawOps) {
    if (op.type === 'keep') {
      ops.push({
        type: 'keep',
        line: op.line,
        lineNoBefore: lineNoBefore++,
        lineNoAfter: lineNoAfter++,
      });
    } else if (op.type === 'delete') {
      ops.push({
        type: 'delete',
        line: op.line,
        lineNoBefore: lineNoBefore++,
      });
    } else if (op.type === 'add') {
      ops.push({
        type: 'add',
        line: op.line,
        lineNoAfter: lineNoAfter++,
      });
    }
  }

  return ops;
}

function renderUnified(ops: LineOp[], contextLines: number, useColor: boolean): string {
  const lines: string[] = [];

  // Filter into chunks with context
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.type === 'keep') {
      i++;
      continue;
    }

    // Found change at index i, find window
    const start = Math.max(0, i - contextLines);
    let end = i;
    while (end < ops.length && (ops[end]!.type !== 'keep' || hasChangeWithin(ops, end, contextLines))) {
      end++;
    }
    const chunkOps = ops.slice(start, Math.min(ops.length, end + contextLines));

    const firstBefore = chunkOps.find((op) => op.lineNoBefore !== undefined)?.lineNoBefore ?? 1;
    const firstAfter = chunkOps.find((op) => op.lineNoAfter !== undefined)?.lineNoAfter ?? 1;
    const beforeCount = chunkOps.filter((op) => op.type !== 'add').length;
    const afterCount = chunkOps.filter((op) => op.type !== 'delete').length;

    const rangeHeader = `@@ -${firstBefore},${beforeCount} +${firstAfter},${afterCount} @@`;
    if (useColor) {
      lines.push(`\x1b[36m${rangeHeader}\x1b[0m`);
    } else {
      lines.push(rangeHeader);
    }

    for (const op of chunkOps) {
      lines.push(formatLine(op, useColor));
    }

    i = end + contextLines;
  }

  // If no changes were found
  if (lines.length === 0 && ops.length > 0) {
    const msg = 'No differences found between context bundles.';
    return useColor ? `\x1b[2m${msg}\x1b[0m` : msg;
  }

  return lines.join('\n');
}

function hasChangeWithin(ops: LineOp[], index: number, window: number): boolean {
  for (let k = index; k < Math.min(ops.length, index + window * 2); k++) {
    if (ops[k]!.type !== 'keep') {
      return true;
    }
  }
  return false;
}

function renderSideBySide(ops: LineOp[], useColor: boolean): string {
  const lines: string[] = [];
  const width = 45;

  const headerLeft = 'BEFORE (Original)'.padEnd(width);
  const headerRight = 'AFTER (Optimized)';
  lines.push(useColor ? `\x1b[1;33m${headerLeft}\x1b[0m | \x1b[1;32m${headerRight}\x1b[0m` : `${headerLeft} | ${headerRight}`);
  lines.push('-'.repeat(width * 2 + 3));

  let i = 0;
  while (i < ops.length) {
    const op = ops[i]!;
    if (op.type === 'keep') {
      const left = padLine(op.line, width);
      const right = padLine(op.line, width);
      lines.push(useColor ? `\x1b[2m${left}\x1b[0m | \x1b[2m${right}\x1b[0m` : `${left} | ${right}`);
      i++;
    } else if (op.type === 'delete') {
      let nextAdd: LineOp | undefined;
      if (i + 1 < ops.length && ops[i + 1]!.type === 'add') {
        nextAdd = ops[i + 1];
        i += 2;
      } else {
        i++;
      }
      const left = padLine(op.line, width);
      const right = padLine(nextAdd ? nextAdd.line : '', width);

      const formattedLeft = useColor ? `\x1b[31m- ${left.slice(2)}\x1b[0m` : `- ${left.slice(2)}`;
      const formattedRight = nextAdd
        ? (useColor ? `\x1b[32m+ ${right.slice(2)}\x1b[0m` : `+ ${right.slice(2)}`)
        : padLine('', width);

      lines.push(`${formattedLeft} | ${formattedRight}`);
    } else {
      // add
      const left = padLine('', width);
      const right = padLine(op.line, width);
      const formattedRight = useColor ? `\x1b[32m+ ${right.slice(2)}\x1b[0m` : `+ ${right.slice(2)}`;
      lines.push(`${left} | ${formattedRight}`);
      i++;
    }
  }

  return lines.join('\n');
}

function padLine(line: string, width: number): string {
  const truncated = line.length > width ? line.slice(0, width - 3) + '...' : line;
  return truncated.padEnd(width);
}

function formatLine(op: LineOp, useColor: boolean): string {
  let content = op.line;
  let prefix = ' ';

  if (op.type === 'add') {
    prefix = '+';
  } else if (op.type === 'delete') {
    prefix = '-';
  }

  if (!useColor) {
    return `${prefix} ${content}`;
  }

  // Apply special inline color highlighting for placeholders, elisions, directives
  content = highlightInlineTokens(content);

  if (op.type === 'add') {
    return `\x1b[32m+ ${content}\x1b[0m`;
  } else if (op.type === 'delete') {
    return `\x1b[31m- ${content}\x1b[0m`;
  } else {
    return `\x1b[90m  ${content}\x1b[0m`;
  }
}

function highlightInlineTokens(line: string): string {
  // Highlight elided blocks
  line = line.replace(/(\[TokenDamper[^\]]*\])/g, '\x1b[1;33;40m$1\x1b[0m');

  // Highlight block hash placeholders
  line = line.replace(/(<BLOCK_HASH:[^>]+>)/g, '\x1b[1;93m$1\x1b[0m');

  // Highlight TD_PRESERVE directives
  line = line.replace(/(TD_PRESERVE:[^\s>\n]+)/g, '\x1b[1;95m✓ $1\x1b[0m');

  return line;
}
