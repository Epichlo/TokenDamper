import type { ContextBundle } from '../model';

export interface DriftMetricParams {
  readonly beforeBundle: ContextBundle;
  readonly afterBundle: ContextBundle;
  readonly weights?:
    | {
        readonly ast?: number | undefined;
        readonly struct?: number | undefined;
      }
    | undefined;
}

export interface DriftReport {
  readonly driftScore: number; // S_k in [0.0, 1.0]
  readonly astSymbolRetentionRatio: number; // R_AST in [0.0, 1.0]
  readonly structuralIntegrityRatio: number; // R_struct in [0.0, 1.0]
  readonly symbolsBeforeCount: number;
  readonly symbolsAfterCount: number;
  readonly markersBeforeCount: number;
  readonly markersAfterCount: number;
  readonly shouldFallback: boolean;
  readonly reason?: string | undefined;
}

export interface DriftTrackerOptions {
  readonly maxDriftThreshold?: number | undefined; // Default: 0.40
  readonly weightAst?: number | undefined; // Default: 0.60
  readonly weightStruct?: number | undefined; // Default: 0.40
}

/**
 * Semantic Drift Tracker evaluating AST symbol retention (R_AST)
 * and structural marker integrity (R_struct) to compute S_k in [0.0, 1.0].
 * Triggers fallback to original input when S_k > 0.40.
 */
export class DriftTracker {
  private readonly maxDriftThreshold: number;
  private readonly weightAst: number;
  private readonly weightStruct: number;

  constructor(options: DriftTrackerOptions = {}) {
    this.maxDriftThreshold = options.maxDriftThreshold ?? 0.40;
    this.weightAst = options.weightAst ?? 0.60;
    this.weightStruct = options.weightStruct ?? 0.40;
  }

  /**
   * Evaluates the semantic drift metric S_k between pre- and post-optimization bundles.
   */
  public calculateDrift(
    beforeBundle: ContextBundle,
    afterBundle: ContextBundle,
    options?: { weights?: { ast?: number; struct?: number } },
  ): DriftReport {
    const wAst = options?.weights?.ast ?? this.weightAst;
    const wStruct = options?.weights?.struct ?? this.weightStruct;

    const totalWeight = wAst + wStruct;
    const normAst = totalWeight > 0 ? wAst / totalWeight : 0.60;
    const normStruct = totalWeight > 0 ? wStruct / totalWeight : 0.40;

    const symbolsBefore = this.extractSymbols(beforeBundle);
    const symbolsAfter = this.extractSymbols(afterBundle);

    let astSymbolRetentionRatio = 1.0;
    if (symbolsBefore.size > 0) {
      let preservedSymbols = 0;
      for (const sym of symbolsBefore) {
        if (symbolsAfter.has(sym)) {
          preservedSymbols++;
        }
      }
      astSymbolRetentionRatio = preservedSymbols / symbolsBefore.size;
    }

    const markersBefore = this.extractMarkers(beforeBundle);
    const markersAfter = this.extractMarkers(afterBundle);

    let structuralIntegrityRatio = 1.0;
    if (markersBefore.size > 0) {
      let preservedMarkers = 0;
      for (const marker of markersBefore) {
        if (markersAfter.has(marker)) {
          preservedMarkers++;
        }
      }
      structuralIntegrityRatio = preservedMarkers / markersBefore.size;
    }

    const retentionScore = normAst * astSymbolRetentionRatio + normStruct * structuralIntegrityRatio;
    const driftScore = Math.max(0.0, Math.min(1.0, 1.0 - retentionScore));
    const shouldFallback = driftScore > this.maxDriftThreshold;
    const reason = shouldFallback
      ? `Semantic drift metric (${driftScore.toFixed(2)}) exceeds maximum threshold (${this.maxDriftThreshold.toFixed(2)}).`
      : undefined;

    return {
      driftScore,
      astSymbolRetentionRatio,
      structuralIntegrityRatio,
      symbolsBeforeCount: symbolsBefore.size,
      symbolsAfterCount: symbolsAfter.size,
      markersBeforeCount: markersBefore.size,
      markersAfterCount: markersAfter.size,
      shouldFallback,
      ...(reason ? { reason } : {}),
    };
  }

  /**
   * Extracts AST symbol identifiers across TypeScript, JavaScript, Python, JSON, and generic code.
   */
  public extractSymbols(bundle: ContextBundle): Set<string> {
    const symbols = new Set<string>();

    for (const item of bundle.items) {
      const content = item.content;
      const fnNames = new Set<string>();

      // 1. JS/TS functions
      const fnRegex = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
      let match: RegExpExecArray | null;
      while ((match = fnRegex.exec(content)) !== null) {
        if (match[1]) {
          symbols.add(`fn:${match[1]}`);
          fnNames.add(match[1]);
        }
      }

      // 2. Python functions
      const pyFnRegex = /def\s+([A-Za-z_][A-Za-z0-9_]*)/g;
      while ((match = pyFnRegex.exec(content)) !== null) {
        if (match[1]) {
          symbols.add(`fn:${match[1]}`);
          fnNames.add(match[1]);
        }
      }

      // 3. JS/TS Classes / Interfaces / Types / Enums / Structs
      const classRegex = /(?:export\s+)?(?:class|interface|type|enum|struct)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
      while ((match = classRegex.exec(content)) !== null) {
        if (match[1]) symbols.add(`type:${match[1]}`);
      }

      // 4. Python classes
      const pyClassRegex = /class\s+([A-Za-z_][A-Za-z0-9_]*)/g;
      while ((match = pyClassRegex.exec(content)) !== null) {
        if (match[1]) symbols.add(`type:${match[1]}`);
      }

      // 5. Const/let/var declarations
      const constRegex = /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g;
      while ((match = constRegex.exec(content)) !== null) {
        if (match[1]) symbols.add(`var:${match[1]}`);
      }

      // 6. Imports (JS/TS & Python)
      const jsImportRegex = /(?:import\s+(?:[\w$*{}min\s,]+from\s+)?['"]([^'"]+)['"])/g;
      while ((match = jsImportRegex.exec(content)) !== null) {
        if (match[1]) symbols.add(`import:${match[1]}`);
      }

      const pyImportRegex = /(?:^|\n)\s*(?:import\s+([A-Za-z0-9_.]+)|from\s+([A-Za-z0-9_.]+)\s+import)/g;
      while ((match = pyImportRegex.exec(content)) !== null) {
        const mod = match[1] || match[2];
        if (mod) symbols.add(`import:${mod}`);
      }

      // 7. Methods inside classes
      const methodRegex = /(?:public|private|protected|async|static|get|set)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
      const reservedKeywords = new Set([
        'if',
        'while',
        'for',
        'switch',
        'catch',
        'function',
        'constructor',
        'return',
        'import',
        'export',
        'class',
        'interface',
        'type',
        'enum',
        'def',
        'typeof',
        'instanceof',
      ]);
      while ((match = methodRegex.exec(content)) !== null) {
        if (match[1] && !reservedKeywords.has(match[1]) && !fnNames.has(match[1])) {
          symbols.add(`method:${match[1]}`);
        }
      }

      // 8. JSON keys / entity identifiers if JSON
      if (item.contentType === 'json') {
        const jsonKeyRegex = /"([^"\\]+)":/g;
        while ((match = jsonKeyRegex.exec(content)) !== null) {
          if (match[1]) symbols.add(`jsonkey:${match[1]}`);
        }
      }
    }

    return symbols;
  }

  /**
   * Extracts structural markers including headings, block fences, directives, and section delimiters.
   */
  public extractMarkers(bundle: ContextBundle): Set<string> {
    const markers = new Set<string>();

    for (const item of bundle.items) {
      if (item.path) {
        markers.add(`filepath:${item.path}`);
      }

      const lines = item.content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();

        // Markdown headings
        if (/^#{1,6}\s+/.test(trimmed)) {
          markers.add(`heading:${trimmed}`);
        }

        // Code block fences
        if (/^```/.test(trimmed)) {
          markers.add(`fence:${trimmed}`);
        }

        // Preserved directives
        const directiveMatch = /(TD_PRESERVE:[^\s>\n]+)/g;
        let match: RegExpExecArray | null;
        while ((match = directiveMatch.exec(trimmed)) !== null) {
          if (match[1]) markers.add(`directive:${match[1]}`);
        }

        // Section delimiters
        if (/^(---|===|System:|User:|Assistant:|\[Context\]|\[Instructions\])/i.test(trimmed)) {
          markers.add(`section:${trimmed}`);
        }
      }

      // Metadata constraintDirectives
      if (typeof item.metadata.constraintDirectives === 'string') {
        try {
          const parsed = JSON.parse(item.metadata.constraintDirectives);
          if (Array.isArray(parsed)) {
            for (const directive of parsed) {
              if (typeof directive === 'string') markers.add(`directive:${directive}`);
            }
          }
        } catch {
          // ignore
        }
      }
    }

    return markers;
  }
}
