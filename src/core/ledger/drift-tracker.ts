import type { ContentType, ContextBundle, ContextItem } from '../model';

/**
 * Content types for which markdown structural markers (`#` headings, ``` fences, `---`
 * section rules) are genuine structure rather than a coincidence of syntax.
 *
 * Deliberately an allowlist, not a denylist of `code`/`yaml`. A new `ContentType` should
 * default to *not* harvesting these — an absent marker costs a little discrimination, an
 * invented one actively inflates drift, and the second failure is the one that has
 * actually bitten (DECISIONS.md §18, `docs/phase-1d-drift-investigation.md` §7).
 *
 * **`markdown` alone, since Phase 4b.3 (DECISIONS §32).** The list used to also hold `text`,
 * `html`, `logs` and `unknown`, which contradicted the paragraph above: `text` and `unknown`
 * are the two "we could not tell" buckets, and a bucket that means *we do not know what this
 * is* cannot also mean *its `#` lines are headings*. `#`, ``` and `---` are not HTML or log
 * syntax either.
 *
 * Measured over five frozen corpora before the change, the four removed members yielded
 * **zero** gated markers between them — 62 `text` files, one `html`, one `logs`, and
 * `unknown` is only ever returned for empty content. So this is a consistency fix with no
 * measured behavioural change, and it is worth having only because the trap is latent:
 * anything that starts classifying code as `text` gets the fabrication back for free.
 *
 * **Where the fabrication actually lives is `markdown`, and removing it from this list is not
 * the answer** — see DECISIONS §32. `looksLikeMarkdown` fires on a single `#` heading, so
 * every hash-commented shell script is markdown, and its comment lines are harvested as
 * headings by construction. That is recorded, measured and deliberately not fixed here.
 */
const MARKDOWN_MARKER_TYPES: ReadonlySet<ContentType> = new Set<ContentType>(['markdown']);

/**
 * Substitutes the pre-optimization content back in for items elided into a
 * recoverable reference (currently `cleanup:session-dedup`, which stores the full
 * text in the session store keyed by `originalContentHash`).
 *
 * Drift measures irreversible semantic loss. A recoverable reference still resolves
 * to its referent on demand, so scoring its dropped symbols as drift would make the
 * metric fire hardest exactly when deduplication is working best. Lossy elisions
 * (`compression:token-hashing`, `compression:delta-compression`) do not set
 * `recoverable` and are therefore still scored in full.
 */
function resolveRecoverableElisions(
  beforeBundle: ContextBundle,
  afterBundle: ContextBundle,
): ContextBundle {
  const beforeById = new Map<string, ContextItem>();
  for (const item of beforeBundle.items) {
    beforeById.set(item.id, item);
  }

  let substituted = false;
  const effectiveItems = afterBundle.items.map((item) => {
    if (item.metadata.elided !== true || item.metadata.recoverable !== true) {
      return item;
    }
    const original = beforeById.get(item.id);
    if (!original) {
      return item;
    }
    substituted = true;
    return original;
  });

  if (!substituted) {
    return afterBundle;
  }

  return { ...afterBundle, items: Object.freeze(effectiveItems) };
}

/**
 * The bundle as the engine emits it — the same newline join used on the success path, so
 * "content changed" here means the same thing it means to the caller downstream.
 */
function renderBundle(bundle: ContextBundle): string {
  return bundle.items.map((item) => item.content).join('\n');
}

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
  /** Markers derived from content rather than from `item.path` or metadata. */
  readonly contentMarkersBeforeCount: number;
  /**
   * Whether each ratio measured anything, or is reporting its empty-set default of 1.0.
   * `driftScore` alone cannot distinguish "retained everything" from "found nothing to
   * check" — invariant 10 applied to `S_k`.
   */
  readonly astMeasured: boolean;
  readonly structMeasured: boolean;
  readonly measured: boolean;
  readonly contentChanged: boolean;
  /** Items that changed, expected a symbol witness, and produced none. */
  readonly unwitnessedItemIds: ReadonlyArray<string>;
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
    options?: {
      weights?: { ast?: number; struct?: number };
      /**
       * Ids of items an AST validator covers, and therefore ones for which extracted
       * symbols are the expected evidence of retention. Supplied by `validate()` from the
       * coverage it already computed, rather than re-deriving validator selection here —
       * duplicating that precedence (`language` → path → `contentType`) is how the check
       * and the transform came to disagree in Issue 2.
       *
       * Omitted means "caller does not know", which disables the unwitnessed-item rule
       * rather than guessing. `DriftCoverage.symbolBearingItems` reports the count so a
       * caller that forgot shows up as 0 instead of passing silently.
       */
      symbolBearingItemIds?: ReadonlySet<string> | undefined;
    },
  ): DriftReport {
    const wAst = options?.weights?.ast ?? this.weightAst;
    const wStruct = options?.weights?.struct ?? this.weightStruct;
    const symbolBearing = options?.symbolBearingItemIds ?? new Set<string>();

    const totalWeight = wAst + wStruct;
    const normAst = totalWeight > 0 ? wAst / totalWeight : 0.60;
    const normStruct = totalWeight > 0 ? wStruct / totalWeight : 0.40;

    const effectiveAfter = resolveRecoverableElisions(beforeBundle, afterBundle);

    const symbolsBefore = this.extractSymbols(beforeBundle);
    const symbolsAfter = this.extractSymbols(effectiveAfter);

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
    const markersAfter = this.extractMarkers(effectiveAfter);

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

    // Did either ratio actually measure something, or is it just its empty-set default?
    //
    // Both default to 1.0 when their *before* set is empty. Read as a score that says
    // "perfectly retained"; read honestly it says "nothing to compare". The difference is
    // invisible in `driftScore` alone, and it is load-bearing: with no symbols and no
    // content-derived markers, `S_k` is 0.0000 no matter what the stages did to the bytes.
    const contentMarkersBefore = this.extractContentMarkers(beforeBundle);
    const astMeasured = symbolsBefore.size > 0;
    const structMeasured = contentMarkersBefore.size > 0;
    const measured = astMeasured || structMeasured;
    const contentChanged = renderBundle(beforeBundle) !== renderBundle(effectiveAfter);

    // Which items were destroyed without leaving any evidence they were retained?
    //
    // Scoped deliberately to items an AST validator covers, and the distinction is the whole
    // design. For structured content, symbols are the *expected* witness: a TypeScript file
    // that yields none means the extractor found nothing where something should have been —
    // the user's "the extractor failed, so this is not elidable". For prose there was never
    // a witness to lose; `R_AST = 1.0` there is not a failed measurement but an inapplicable
    // one, and enforcing on it would make every prose bundle incompressible, ending
    // `cleanup:session-dedup` on exactly the conversational traffic the Gateway carries.
    //
    // That gap is real and stays open: plain prose is unwitnessed by both components and
    // still passes at `S_k = 0.00`. It is now *reported* (`DriftCoverage`) rather than
    // enforced, because closing it is a product decision about whether TokenDamper may
    // compress prose at all — not a bug fix.
    const unwitnessedItemIds = this.findUnwitnessedItems(beforeBundle, effectiveAfter, symbolBearing);
    const unmeasurable = unwitnessedItemIds.length > 0;

    const shouldFallback = unmeasurable || driftScore > this.maxDriftThreshold;
    const reason = unmeasurable
      ? `Semantic drift is unmeasurable for ${unwitnessedItemIds.length} item(s) [${unwitnessedItemIds.join(', ')}]: content changed, an AST validator covers the item, and it yielded no symbols and no content-derived structural markers — so retention cannot be evidenced (S_k would default to ${driftScore.toFixed(2)}).`
      : driftScore > this.maxDriftThreshold
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
      contentMarkersBeforeCount: contentMarkersBefore.size,
      astMeasured,
      structMeasured,
      measured,
      contentChanged,
      unwitnessedItemIds: Object.freeze(unwitnessedItemIds),
      shouldFallback,
      ...(reason ? { reason } : {}),
    };
  }

  /**
   * Items that changed, are covered by an AST validator, and left no evidence of retention.
   *
   * Per item rather than per bundle on purpose: the bundle-level ratios are set comparisons
   * with no attribution, so a bundle holding one richly-symbolled file and one symbol-free
   * barrel file measures `astMeasured: true` while the barrel is deleted unwitnessed. That
   * is the same granularity mismatch that produced Issue 2 — the transform is per item, so
   * the evidence check has to be too.
   */
  private findUnwitnessedItems(
    beforeBundle: ContextBundle,
    effectiveAfter: ContextBundle,
    symbolBearing: ReadonlySet<string>,
  ): string[] {
    if (symbolBearing.size === 0) {
      return [];
    }

    const afterById = new Map<string, ContextItem>();
    for (const item of effectiveAfter.items) {
      afterById.set(item.id, item);
    }

    const unwitnessed: string[] = [];
    for (const item of beforeBundle.items) {
      if (!symbolBearing.has(item.id)) {
        continue;
      }
      const after = afterById.get(item.id);
      if (!after) {
        // Dropped from the bundle entirely — a selection decision, not an elision. The
        // planner exists to drop items under a budget the caller set, and `R_AST` already
        // scores that loss wherever the item carried symbols. Failing closed here would
        // stop the knapsack pruning any symbol-free file, which is not this fix's argument.
        //
        // The gap is acknowledged: a symbol-free code file the pruner removes is still
        // invisible to drift. That is the planner's half of the same defect and wants its
        // own decision (`DECISIONS` §18 territory), not a silent ride-along here.
        continue;
      }
      if (after.content === item.content) {
        continue; // untouched: retention needs no evidence
      }

      const single: ContextBundle = { ...beforeBundle, items: Object.freeze([item]) };
      if (this.extractSymbols(single).size > 0 || this.extractContentMarkers(single).size > 0) {
        continue; // measurable: the ratios above already scored it
      }
      unwitnessed.push(item.id);
    }
    return unwitnessed;
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
    return this.collectMarkers(bundle, true);
  }

  /**
   * The subset of markers derived from `item.content`, and therefore the only ones an
   * elision can actually destroy.
   *
   * `filepath:` comes from `item.path` and `directive:` may come from
   * `item.metadata.constraintDirectives`; both survive any content transform by
   * construction. They are still counted in `R_struct` — changing that would move every
   * score in the project and is DECISIONS §18's separate argument — but they cannot serve
   * as *evidence* that content was retained, because they are preserved whether it was or
   * not. Used only for `DriftCoverage.structMeasured`.
   */
  public extractContentMarkers(bundle: ContextBundle): Set<string> {
    return this.collectMarkers(bundle, false);
  }

  private collectMarkers(bundle: ContextBundle, includeMetadataDerived: boolean): Set<string> {
    const markers = new Set<string>();

    for (const item of bundle.items) {
      if (includeMetadataDerived && item.path) {
        markers.add(`filepath:${item.path}`);
      }

      // Headings, fences and section delimiters are *markdown* syntax. Harvesting them from
      // content where those characters mean something else invents markers that the next
      // elision then "destroys", inflating drift for no semantic reason.
      //
      // Measured: `#` is a comment leader in Python, and a two-comment Python file scored
      // `R_struct = 0.3333` and `S_k = 0.8667` — above the 0.60 ceiling that applies to code
      // (DECISIONS.md §18), purely because two comments were read as headings. Drift on
      // Python scaled with comment density. `---` is likewise a YAML document separator.
      const harvestMarkdownMarkers = MARKDOWN_MARKER_TYPES.has(item.contentType);

      const lines = item.content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();

        // Markdown headings
        if (harvestMarkdownMarkers && /^#{1,6}\s+/.test(trimmed)) {
          markers.add(`heading:${trimmed}`);
        }

        // Code block fences
        if (harvestMarkdownMarkers && /^```/.test(trimmed)) {
          markers.add(`fence:${trimmed}`);
        }

        // Preserved directives — content-agnostic, harvested from every content type.
        const directiveMatch = /(TD_PRESERVE:[^\s>\n]+)/g;
        let match: RegExpExecArray | null;
        while ((match = directiveMatch.exec(trimmed)) !== null) {
          if (match[1]) markers.add(`directive:${match[1]}`);
        }

        // Section delimiters
        if (harvestMarkdownMarkers && /^(---|===|System:|User:|Assistant:|\[Context\]|\[Instructions\])/i.test(trimmed)) {
          markers.add(`section:${trimmed}`);
        }
      }

      // Metadata constraintDirectives
      if (includeMetadataDerived && typeof item.metadata.constraintDirectives === 'string') {
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
