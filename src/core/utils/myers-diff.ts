/**
 * Core operation type for line-level diffs.
 */
export interface DiffOp {
  type: 'keep' | 'add' | 'delete';
  line: string;
}

/**
 * Computes a line-by-line diff using Myers' O(ND) greedy algorithm with
 * linear prefix/suffix trimming and Int32Array trace backtracking.
 *
 * @param oldLines - Original array of line strings
 * @param newLines - Modified array of line strings
 * @returns Array of diff operations in chronological order (start of file to end)
 */
export function computeLineDiff(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;

  // 1. Common Prefix Trimming
  let start = 0;
  while (start < n && start < m && oldLines[start] === newLines[start]) {
    start++;
  }

  // 2. Common Suffix Trimming
  let oldEnd = n - 1;
  let newEnd = m - 1;
  while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  const result: DiffOp[] = [];

  // Emit prefix keep operations
  for (let idx = 0; idx < start; idx++) {
    result.push({ type: 'keep', line: oldLines[idx]! });
  }

  // Slices for middle content
  const oldSlice = oldLines.slice(start, oldEnd + 1);
  const newSlice = newLines.slice(start, newEnd + 1);

  if (oldSlice.length > 0 || newSlice.length > 0) {
    const middleOps = computeMyersSliceDiff(oldSlice, newSlice);
    for (let idx = 0; idx < middleOps.length; idx++) {
      result.push(middleOps[idx]!);
    }
  }

  // Emit suffix keep operations
  for (let idx = oldEnd + 1; idx < n; idx++) {
    result.push({ type: 'keep', line: oldLines[idx]! });
  }

  return result;
}

/**
 * Executes greedy Myers O(ND) algorithm on middle line slices.
 */
function computeMyersSliceDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const vSize = 2 * max + 1;

  const v = new Int32Array(vSize);
  const trace: Int32Array[] = [];

  let dFound = max;

  // Step 0 initialization (k = 0, index = max)
  let x0 = 0;
  let y0 = 0;
  while (x0 < n && y0 < m && a[x0] === b[y0]) {
    x0++;
    y0++;
  }
  v[max] = x0;
  trace.push(new Int32Array(v));

  if (x0 >= n && y0 >= m) {
    dFound = 0;
  } else {
    searchLoop: for (let d = 1; d <= max; d++) {
      for (let k = -d; k <= d; k += 2) {
        const kIdx = k + max;
        let x: number;

        if (k === -d) {
          x = v[kIdx + 1]!;
        } else if (k === d) {
          x = v[kIdx - 1]! + 1;
        } else {
          const left = v[kIdx - 1]!;
          const right = v[kIdx + 1]!;
          if (left < right) {
            x = right;
          } else {
            x = left + 1;
          }
        }

        let y = x - k;

        while (x < n && y < m && a[x] === b[y]) {
          x++;
          y++;
        }

        v[kIdx] = x;

        if (x >= n && y >= m) {
          trace.push(new Int32Array(v));
          dFound = d;
          break searchLoop;
        }
      }
      trace.push(new Int32Array(v));
    }
  }

  // Backtrack to build Shortest Edit Script (SES)
  const ops: DiffOp[] = [];
  let currX = n;
  let currY = m;

  for (let d = dFound; d > 0; d--) {
    const k = currX - currY;
    const kIdx = k + max;
    const prevV = trace[d - 1]!;

    let prevK: number;
    if (k === -d || (k !== d && prevV[kIdx - 1]! < prevV[kIdx + 1]!)) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }

    const prevKIdx = prevK + max;
    const prevX = prevV[prevKIdx]!;
    const prevY = prevX - prevK;

    // Diagonal snake backwards
    while (currX > prevX && currY > prevY) {
      currX--;
      currY--;
      ops.push({ type: 'keep', line: a[currX]! });
    }

    // Single edit step
    if (d > 0) {
      if (currX === prevX) {
        currY--;
        ops.push({ type: 'add', line: b[currY]! });
      } else if (currY === prevY) {
        currX--;
        ops.push({ type: 'delete', line: a[currX]! });
      }
    }
  }

  // Post-loop snake at d = 0
  while (currX > 0 && currY > 0) {
    currX--;
    currY--;
    ops.push({ type: 'keep', line: a[currX]! });
  }

  return ops.reverse();
}
