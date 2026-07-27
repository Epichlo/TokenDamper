import * as path from 'path';
import type { ContextItem } from '../model/types';

export interface DependencyNode {
  readonly path: string;
  readonly language: 'typescript' | 'javascript' | 'python' | 'unknown';
  readonly imports: ReadonlySet<string>; // Resolved or relative paths/specifiers
  readonly exports: ReadonlySet<string>; // Exported symbol names
}

export interface DependencyGraph {
  readonly nodes: ReadonlyMap<string, DependencyNode>;
  readonly edges: ReadonlyMap<string, ReadonlySet<string>>; // sourcePath -> Set<targetPath>
  readonly reverseEdges: ReadonlyMap<string, ReadonlySet<string>>; // targetPath -> Set<sourcePath>
}

/**
 * Normalizes backslashes and removes leading ./
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Resolves a specifier relative to a file's directory.
 */
function resolveRelativePath(filePath: string, specifier: string): string {
  const normFile = normalizePath(filePath);
  const dir = path.dirname(normFile);

  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const resolved = path.join(dir, specifier);
    return normalizePath(resolved);
  }
  return normalizePath(specifier);
}

/**
 * Parses ESM/CJS import statements from TS/JS code content.
 */
export function parseTsJsImports(filePath: string, content: string): ReadonlySet<string> {
  const imports = new Set<string>();

  // Regex patterns for TS/JS imports/requires/exports
  // 1. import ... from '...'
  // 2. export ... from '...'
  // 3. require('...')
  // 4. import('...')
  const importFromRegex = /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  const requireRegex = /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  let match: RegExpExecArray | null;

  while ((match = importFromRegex.exec(content)) !== null) {
    if (match[1]) {
      const specifier = match[1];
      imports.add(resolveRelativePath(filePath, specifier));
    }
  }

  while ((match = requireRegex.exec(content)) !== null) {
    if (match[1]) {
      const specifier = match[1];
      imports.add(resolveRelativePath(filePath, specifier));
    }
  }

  return imports;
}

/**
 * Parses export declarations from TS/JS code content.
 */
export function parseTsJsExports(content: string): ReadonlySet<string> {
  const exports = new Set<string>();

  // Named exports: export function foo, export const bar, export class Baz, export interface Qux, export type T
  const namedExportRegex = /\bexport\s+(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([a-zA-Z0-9_$]+)/g;
  // Export list: export { a, b as c }
  const exportListRegex = /\bexport\s*\{([^}]+)\}/g;

  let match: RegExpExecArray | null;

  while ((match = namedExportRegex.exec(content)) !== null) {
    if (match[1]) {
      exports.add(match[1]);
    }
  }

  while ((match = exportListRegex.exec(content)) !== null) {
    if (match[1]) {
      const symbols = match[1].split(',');
      for (const sym of symbols) {
        const parts = sym.trim().split(/\s+as\s+/);
        const exportedName = (parts[parts.length - 1] ?? '').trim();
        if (exportedName && exportedName !== 'default') {
          exports.add(exportedName);
        }
      }
    }
  }

  if (/\bexport\s+default\b/.test(content)) {
    exports.add('default');
  }

  return exports;
}

/**
 * Parses import/from statements from Python code content.
 */
export function parsePythonImports(filePath: string, content: string): ReadonlySet<string> {
  const imports = new Set<string>();
  const normFile = normalizePath(filePath);
  const dir = path.dirname(normFile);

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const fromMatch = /^\s*from\s+(\.+)?([a-zA-Z0-9_.]*)\s+import\s+/i.exec(trimmed);
    if (fromMatch) {
      const dots = fromMatch[1] || '';
      const mod = fromMatch[2] || '';

      if (dots) {
        const dotCount = dots.length;
        let currentDir = dir;
        for (let i = 1; i < dotCount; i++) {
          currentDir = path.dirname(currentDir);
        }
        const modPath = mod.replace(/\./g, '/');
        const resolved = modPath ? path.join(currentDir, modPath) : currentDir;
        imports.add(normalizePath(resolved));
      } else if (mod) {
        const modPath = mod.replace(/\./g, '/');
        imports.add(normalizePath(modPath));
      }
      continue;
    }

    const importMatch = /^\s*import\s+([a-zA-Z0-9_.,\s]+)/i.exec(trimmed);
    if (importMatch && importMatch[1]) {
      const modulesStr = importMatch[1];
      const modules = modulesStr.split(',');
      for (const m of modules) {
        const item = (m.trim().split(/\s+as\s+/)[0] ?? '').trim();
        if (item) {
          const modPath = item.replace(/\./g, '/');
          imports.add(normalizePath(modPath));
        }
      }
    }
  }

  return imports;
}

/**
 * Parses export/definition names from Python code content.
 */
export function parsePythonExports(content: string): ReadonlySet<string> {
  const exports = new Set<string>();
  const defRegex = /^\s*(?:def|class)\s+([a-zA-Z0-9_]+)/gm;

  let match: RegExpExecArray | null;
  while ((match = defRegex.exec(content)) !== null) {
    if (match[1] && !match[1].startsWith('_')) {
      exports.add(match[1]);
    }
  }

  const allRegex = /__all__\s*=\s*\[([^\]]+)\]/;
  const allMatch = allRegex.exec(content);
  if (allMatch && allMatch[1]) {
    const items = allMatch[1].split(',');
    for (const item of items) {
      const clean = item.trim().replace(/['"]/g, '');
      if (clean) exports.add(clean);
    }
  }

  return exports;
}

/**
 * Determines language classification from file path or item properties.
 */
function detectLanguage(item: ContextItem): 'typescript' | 'javascript' | 'python' | 'unknown' {
  if (item.language) {
    const lang = item.language.toLowerCase();
    if (lang === 'typescript' || lang === 'ts' || lang === 'tsx') return 'typescript';
    if (lang === 'javascript' || lang === 'js' || lang === 'jsx') return 'javascript';
    if (lang === 'python' || lang === 'py') return 'python';
  }

  if (item.path) {
    const ext = path.extname(item.path).toLowerCase();
    if (ext === '.ts' || ext === '.tsx') return 'typescript';
    if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return 'javascript';
    if (ext === '.py') return 'python';
  }

  return 'unknown';
}

/**
 * Helper to check if a resolved import path matches a known item path.
 */
function findMatchingItemPath(importPath: string, knownPaths: Set<string>): string | null {
  const normImport = normalizePath(importPath);

  // Exact match
  if (knownPaths.has(normImport)) return normImport;

  // Try extension additions
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '/index.ts', '/index.js', '/__init__.py'];
  for (const ext of extensions) {
    const candidate = normImport + ext;
    if (knownPaths.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Constructs a DependencyGraph from a list of ContextItems.
 */
export function buildDependencyGraph(items: ReadonlyArray<ContextItem>): DependencyGraph {
  const nodes = new Map<string, DependencyNode>();
  const edges = new Map<string, Set<string>>();
  const reverseEdges = new Map<string, Set<string>>();

  const knownPaths = new Set<string>();
  const codeItems: ContextItem[] = [];

  for (const item of items) {
    if (item.path) {
      const norm = normalizePath(item.path);
      knownPaths.add(norm);
      codeItems.push(item);
    }
  }

  // First pass: create nodes and initialize edge sets
  for (const item of codeItems) {
    if (!item.path) continue;
    const itemPath = normalizePath(item.path);
    const language = detectLanguage(item);
    let imports: ReadonlySet<string> = new Set();
    let exports: ReadonlySet<string> = new Set();

    if (language === 'typescript' || language === 'javascript') {
      imports = parseTsJsImports(itemPath, item.content);
      exports = parseTsJsExports(item.content);
    } else if (language === 'python') {
      imports = parsePythonImports(itemPath, item.content);
      exports = parsePythonExports(item.content);
    }

    nodes.set(itemPath, {
      path: itemPath,
      language,
      imports,
      exports,
    });

    edges.set(itemPath, new Set<string>());
    if (!reverseEdges.has(itemPath)) {
      reverseEdges.set(itemPath, new Set<string>());
    }
  }

  // Second pass: resolve edges between known items
  for (const [sourcePath, node] of nodes.entries()) {
    const sourceEdgeSet = edges.get(sourcePath)!;

    for (const rawImport of node.imports) {
      const matchedTarget = findMatchingItemPath(rawImport, knownPaths);
      if (matchedTarget && matchedTarget !== sourcePath) {
        sourceEdgeSet.add(matchedTarget);

        if (!reverseEdges.has(matchedTarget)) {
          reverseEdges.set(matchedTarget, new Set<string>());
        }
        reverseEdges.get(matchedTarget)!.add(sourcePath);
      }
    }
  }

  return {
    nodes,
    edges,
    reverseEdges,
  };
}

/**
 * Computes the shortest path distance (BFS) from any source path in sourcePaths
 * to ALL reachable nodes in the graph. Runs a single multi-source BFS traversal.
 *
 * Returns a Map where keys are normalized paths and values are distances.
 * Nodes not present in the map are unreachable (distance = Infinity).
 *
 * Uses a head-index pointer for O(1) dequeue instead of Array.shift() which is O(V).
 */
export function computeAllDistances(
  graph: DependencyGraph,
  sourcePaths: ReadonlySet<string>,
): ReadonlyMap<string, number> {
  const distances = new Map<string, number>();

  // Normalize source paths and seed the BFS queue
  const queue: Array<{ path: string; dist: number }> = [];
  let head = 0;

  for (const sp of sourcePaths) {
    const norm = normalizePath(sp);
    if (!distances.has(norm)) {
      distances.set(norm, 0);
      queue.push({ path: norm, dist: 0 });
    }
  }

  while (head < queue.length) {
    const { path: current, dist } = queue[head]!;
    head++;

    // Neighbors via outgoing edges (imports)
    const outgoing = graph.edges.get(current);
    if (outgoing) {
      for (const next of outgoing) {
        if (!distances.has(next)) {
          distances.set(next, dist + 1);
          queue.push({ path: next, dist: dist + 1 });
        }
      }
    }

    // Neighbors via incoming edges (imported by)
    const incoming = graph.reverseEdges.get(current);
    if (incoming) {
      for (const next of incoming) {
        if (!distances.has(next)) {
          distances.set(next, dist + 1);
          queue.push({ path: next, dist: dist + 1 });
        }
      }
    }
  }

  return distances;
}

/**
 * Calculates the shortest path distance (BFS) from any source path in sourcePaths to targetPath.
 * Returns 0 if targetPath is in sourcePaths.
 * Returns Infinity if targetPath is disconnected from sourcePaths.
 *
 * NOTE: If you need distances for multiple targets, prefer computeAllDistances() to avoid
 * redundant BFS traversals.
 */
export function getShortestGraphDistance(
  graph: DependencyGraph,
  sourcePaths: ReadonlySet<string>,
  targetPath: string,
): number {
  const distances = computeAllDistances(graph, sourcePaths);
  const normTarget = normalizePath(targetPath);
  return distances.get(normTarget) ?? Infinity;
}

