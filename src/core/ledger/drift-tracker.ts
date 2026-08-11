import { extractProseRegions } from '../constraints/directives';
import type { ContentType, ContextBundle, ContextItem } from '../model';

/**
 * Content types for which markdown structural markers (`#` headings, ``` fences, `---`
 * section rules) are genuine structure rather than a coincidence of syntax.
 *
 * Deliberately an allowlist, not a denylist of `code`/`yaml`. A new `ContentType` should
 * default to *not* harvesting these — an absent marker costs a little discrimination, an
 * invented one actively inflates drift, and the second failure is the one that has
 * actually bitten (DECISIONS.md §18, `docs/phase-1d-drift-investigation.md` §7). [retired]
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
  /** Items that changed and produced no witness of any kind. */
  readonly unwitnessedItemIds: ReadonlyArray<string>;
  /**
   * The two gates, separately, because one scalar cannot express both.
   *
   * `S_k = 1 - (0.6·R_AST + 0.4·R_struct)` answers two questions at once — *did anything
   * witness this?* and *did enough of it survive?* — and `0.400` is reachable from two
   * structurally opposite configurations: `R_AST = 1` as an empty-set default with
   * `R_struct = 0` (nothing measured, everything destroyed), and `R_AST = 1/3` with
   * `R_struct = 1` (a third of the symbols retained, structure intact). A single
   * comparison decides both together, so `>` versus `>=` silently arbitrates a question
   * nobody asked. Reported apart, they can be answered apart.
   *
   * `measurement` refuses when an item changed and left no evidence it was retained.
   * `retention` refuses when evidence exists and too little of it survived.
   * `shouldFallback` is their disjunction and is kept for callers that only need the verdict.
   */
  readonly measurementGate: GateVerdict;
  readonly retentionGate: GateVerdict;
  readonly shouldFallback: boolean;
  readonly reason?: string | undefined;
}

export type GateVerdict = 'pass' | 'refuse';

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
    },
  ): DriftReport {
    const wAst = options?.weights?.ast ?? this.weightAst;
    const wStruct = options?.weights?.struct ?? this.weightStruct;

    const totalWeight = wAst + wStruct;
    const normAst = totalWeight > 0 ? wAst / totalWeight : 0.60;
    const normStruct = totalWeight > 0 ? wStruct / totalWeight : 0.40;

    const effectiveAfter = resolveRecoverableElisions(beforeBundle, afterBundle);

    // The ratios score **retained** items only — selection is not elision.
    //
    // `findUnwitnessedItems` has always exempted an item absent from `after`, on the grounds
    // that the planner exists to drop items under a budget the caller set. The ratios did not
    // apply the same rule: they compared whole bundles, so a pruned item's symbols simply
    // vanished from the after set and `R_AST` read the planner doing its job as semantic loss.
    //
    // That was invisible while every shipping route built a one-item bundle — there was nothing
    // to prune (audit H5). Multi-file ingestion makes it live and decisive: on a 31-item bundle
    // at `maxInputTokens: 4000` the knapsack prunes 15 items and saves 20,540 tokens, roughly
    // half the symbols go with them, and the run fell back on drift every time. The knapsack
    // would have been reachable and still unable to emit anything.
    //
    // Scoping to the intersection keeps the gate's actual question intact — *was retained
    // content corrupted?* — and leaves budget-driven selection to the planner, which is the
    // component the caller pointed at it. An item dropped entirely is still covered, by the
    // budget the caller set and by `itemsPruned` in the trace.
    // Guarded on ids actually corresponding between the two bundles.
    //
    // `createContextItem` derives `id` from a content hash, and the transforms preserve it
    // explicitly (`id: item.id` in `elideItem`/`elideRegions`), so in the pipeline an item keeps
    // its identity across stages and "absent from after" really does mean pruned. A caller that
    // builds its `after` bundle independently — several tests do, and any future embedder might —
    // gets fresh ids for changed content, and filtering on them would leave *nothing* to compare
    // and report `S_k = 0` for a bundle that had been gutted.
    //
    // So the exemption applies only when at least one id survives, which is the evidence that ids
    // are being carried rather than regenerated. With no correspondence the whole bundle is
    // compared, exactly as before. Failing open to *more* measurement rather than less is the
    // point: invariant 10 says a check that silently stops looking is worse than one that is
    // merely coarse.
    const retainedIds = new Set(effectiveAfter.items.map((item) => item.id));
    const idsCorrespond = beforeBundle.items.some((item) => retainedIds.has(item.id));
    const retainedBefore: ContextBundle = idsCorrespond
      ? {
          ...beforeBundle,
          items: Object.freeze(beforeBundle.items.filter((item) => retainedIds.has(item.id))),
        }
      : beforeBundle;

    const symbolsBefore = this.extractSymbols(retainedBefore);
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

    // Reported for continuity and diagnostics; the *ratio* below deliberately does not use them.
    const markersBefore = this.extractMarkers(retainedBefore);
    const markersAfter = this.extractMarkers(effectiveAfter);

    // `R_struct` measures content structure, and only content structure — C1b.
    //
    // It used to be computed over `extractMarkers`, which includes `filepath:` (from `item.path`)
    // and `directive:` (from `item.metadata.constraintDirectives`). Neither is destructible by a
    // content transform, so both survive whether content was retained or not. For code, where
    // `filepath:` is usually the *only* marker, that pinned `R_struct` at exactly 1.0.
    // `extractContentMarkers` has existed since §28 for precisely this distinction, and its own
    // doc comment already said these markers "cannot serve as evidence that content was retained".
    const contentMarkersBefore = this.extractContentMarkers(retainedBefore);
    const contentMarkersAfter = this.extractContentMarkers(effectiveAfter);

    let structuralIntegrityRatio = 1.0;
    if (contentMarkersBefore.size > 0) {
      let preservedMarkers = 0;
      for (const marker of contentMarkersBefore) {
        if (contentMarkersAfter.has(marker)) {
          preservedMarkers++;
        }
      }
      structuralIntegrityRatio = preservedMarkers / contentMarkersBefore.size;
    }

    // Did either ratio actually measure something, or is it just its empty-set default?
    //
    // Both default to 1.0 when their *before* set is empty. Read as a score that says
    // "perfectly retained"; read honestly it says "nothing to compare". The difference is
    // invisible in `driftScore` alone, and it is load-bearing: with no symbols and no
    // content-derived markers, `S_k` is 0.0000 no matter what the stages did to the bytes.
    const astMeasured = symbolsBefore.size > 0;
    const structMeasured = contentMarkersBefore.size > 0;
    const measured = astMeasured || structMeasured;

    // A ratio that measured nothing does not get a vote — the second half of C1b, and the half
    // that does the work.
    //
    // Dropping `filepath:` above is necessary but *by itself inert*, which is worth stating
    // because it is not obvious and the audit that prompted this got it wrong: removing the only
    // marker an item had leaves the before-set empty, and an empty set defaults `R_struct` to
    // 1.0 — the identical free 0.40, arriving by a different route. Measured, the marker change
    // alone was byte-identical across all 586 corpus rows.
    //
    // So the weight of an unmeasured ratio is redistributed to the one that did measure, rather
    // than filled in with a default that asserts perfection. This is §33's argument ("`0.0000`
    // means 'retained everything' and 'found nothing to look at' indistinguishably") applied to
    // the score instead of to the gate.
    //
    // For code this makes `S_k = 1 - R_AST`, so the maximum symbol loss that can pass falls from
    // 66.7% to 40%. When neither ratio measured, this returns 1.0 and the retention gate stays
    // silent — that case belongs to the measurement gate (C1a), and having both refuse would
    // attribute the refusal to the wrong question.
    const retentionScore =
      astMeasured && structMeasured
        ? normAst * astSymbolRetentionRatio + normStruct * structuralIntegrityRatio
        : astMeasured
          ? astSymbolRetentionRatio
          : structMeasured
            ? structuralIntegrityRatio
            : 1.0;
    const driftScore = Math.max(0.0, Math.min(1.0, 1.0 - retentionScore));
    // Compared over retained items too: otherwise pruning alone reads as "content changed",
    // which is the same conflation the ratios above just stopped making.
    const contentChanged = renderBundle(retainedBefore) !== renderBundle(effectiveAfter);

    // Which items were destroyed without leaving any evidence they were retained?
    //
    // **No longer scoped to validator-covered items (Phase A).** §28 scoped it that way and
    // gave a reason: for prose `R_AST = 1.0` is an inapplicable metric rather than a failed
    // one, and enforcing there "would make every prose bundle incompressible, ending
    // `cleanup:session-dedup` on exactly the conversational traffic the Gateway carries".
    // Measured on 2026-08-06, that reason is half true and the half that is false was doing
    // all the work:
    //
    //   - Real documents are unaffected. All 25 markdown files in the frozen corpus carry
    //     content markers, so they are witnessed and this rule never reaches them.
    //   - The Gateway keeps within-payload deduplication. `resolveRecoverableElisions` above
    //     substitutes the original content for `recoverable` elisions *before* any of this
    //     runs, so a recoverable elision reads as unchanged and is skipped structurally.
    //     Measured end to end: within-payload dedup saves 44 of 129 tokens with and without
    //     this rule. Only cross-turn sole-copy elision is refused — the case the §9 addendum
    //     already described as sending the model a marker it has no way to resolve.
    //   - What the old scope was actually protecting was uncovered *code*. A 57,037-token
    //     Perl file was elided whole to 19 tokens on the file-argument route, `S_k = 0`,
    //     `measured: false`, no fallback, because no validator covers `.pl` and the rule
    //     therefore never looked. That is the defect, not prose.
    //
    // See `docs/phase-0-measurement-baseline.md` §5 and DECISIONS §33. [retired]
    const unwitnessedItemIds = this.findUnwitnessedItems(beforeBundle, effectiveAfter);

    // The two gates, decided separately. See `DriftReport.measurementGate`.
    const measurementGate: GateVerdict = unwitnessedItemIds.length > 0 ? 'refuse' : 'pass';
    const retentionGate: GateVerdict = driftScore > this.maxDriftThreshold ? 'refuse' : 'pass';
    const shouldFallback = measurementGate === 'refuse' || retentionGate === 'refuse';

    const reason =
      measurementGate === 'refuse'
        ? `Semantic drift is unmeasurable for ${unwitnessedItemIds.length} item(s) [${unwitnessedItemIds.join(', ')}]: content changed and the item yielded no symbols and no content-derived structural markers, so retention cannot be evidenced (S_k would default to ${driftScore.toFixed(2)}).`
        : retentionGate === 'refuse'
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
      measurementGate,
      retentionGate,
      shouldFallback,
      ...(reason ? { reason } : {}),
    };
  }

  /**
   * Items that changed and left no evidence of retention.
   *
   * Per item rather than per bundle on purpose: the bundle-level ratios are set comparisons
   * with no attribution, so a bundle holding one richly-symbolled file and one symbol-free
   * barrel file measures `astMeasured: true` while the barrel is deleted unwitnessed. That
   * is the same granularity mismatch that produced Issue 2 — the transform is per item, so
   * the evidence check has to be too.
   *
   * The witness may be **either** symbols or content-derived markers. Requiring symbols
   * specifically would refuse every document; requiring neither is what let a 57,037-token
   * Perl file be deleted whole. "Some evidence, of either kind" is the line, and the three
   * exemptions below (untouched, pruned, measurable) are what keep it off everything else.
   */
  private findUnwitnessedItems(
    beforeBundle: ContextBundle,
    effectiveAfter: ContextBundle,
  ): string[] {
    const afterById = new Map<string, ContextItem>();
    for (const item of effectiveAfter.items) {
      afterById.set(item.id, item);
    }

    const unwitnessed: string[] = [];
    for (const item of beforeBundle.items) {
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

      const beforeSingle: ContextBundle = { ...beforeBundle, items: Object.freeze([item]) };
      const afterSingle: ContextBundle = { ...beforeBundle, items: Object.freeze([after]) };

      // Symbols present *before* means `R_AST` is measuring this item for real rather than
      // reporting its empty-set default, so retention is evidenced and the retention gate owns
      // the verdict. Whole-item elision of code lands here: `R_AST = 0`, `S_k` pins at 0.60,
      // refused as EXCEEDED — which is the accurate reason. Claiming "unmeasurable" for an
      // item whose loss was measured exactly would be the same conflation the two-gate split
      // exists to undo.
      if (this.extractSymbols(beforeSingle).size > 0) {
        continue;
      }

      // No symbols, so 60% of `S_k` is a free 0.60 from an empty-set default that looked at
      // nothing. Content markers are the only real evidence left — and they must **survive**.
      //
      // This asked `extractContentMarkers(beforeSingle)` until 2026-08-09, i.e. *did evidence
      // exist?* rather than *did any of it survive?*. Measured, that let a markdown document be
      // deleted in its entirety with every gate green: a 233-byte runbook became a 72-byte
      // marker at `fallbackUsed: false`, `S_k = 0.3000`, both gates passing. The arithmetic is
      // closed-form and worth stating, because it shows the old rule could never have caught
      // it: with no symbols `R_AST = 1.0`, and `R_struct = 1/(N+1)` for N headings because
      // `filepath:` is derived from `item.path` and no content transform can destroy it. So
      // `S_k = 0.4·N/(N+1)`, which approaches 0.40 from below and never reaches it, for any N.
      // The retention gate compares with strict `>`. It cannot fire for markdown at all.
      //
      // §33 widened this rule from validator-covered items to every item and was right to;
      // what it did not change was the tense of the question. Refusing on the surviving set is
      // strictly more refusing than refusing on the before set, so every §33 refusal (the
      // symbol-free Perl file elided whole) still refuses — nothing that was caught is now let
      // through. See DECISIONS §37 and max_audit.md C1.
      if (this.extractContentMarkers(afterSingle).size > 0) {
        continue;
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

      // 5. Top-level const/let/var declarations.
      //
      // **Anchored to the start of a line, which excludes function-local bindings.** This used
      // to match anywhere, so every `const i`, `const result`, `const msg` inside a function
      // body counted as a semantic symbol on par with an exported function — and body elision
      // is precisely the transform that removes them. Measured on this repo at
      // `targetReductionRatio: 0.5`, on the two files whose drift scores sit closest to the
      // gate:
      //
      //   src/core/hashing/tokenizer.ts   9 of 17 symbols "lost" — all 9 function-local
      //   src/core/engine/index.ts       42 of 63 symbols "lost" — 41 function-local
      //
      // Not one exported function, type or interface was lost in either case, because
      // `selectElisionRegions` retains signatures by construction. So `R_AST` was reporting
      // 66.7% semantic loss for a file that had lost no API surface at all, and the audit's
      // "you can destroy two-thirds of every symbol in a file and pass" was measuring
      // temporaries inside bodies the caller asked to have elided.
      //
      // Python is the control: its extractor never had a locals rule, its measured symbol loss
      // under the same elision is **0.0%**, and it is unaffected by this change.
      //
      // `^` with the `m` flag rather than an indentation test, because in TS and JS a top-level
      // declaration *is* a column-0 declaration. Indented ones are inside a function, a class or
      // a block, and are body content.
      const constRegex = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/gm;
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

        // Section delimiters
        if (harvestMarkdownMarkers && /^(---|===|System:|User:|Assistant:|\[Context\]|\[Instructions\])/i.test(trimmed)) {
          markers.add(`section:${trimmed}`);
        }
      }

      // Preserved directives, harvested from **prose regions only**.
      //
      // Same reasoning as imperative directives (DECISIONS §42): a preservation directive is an
      // instruction, and instructions live in comments and documents, not in expressions.
      //
      // Scanned over raw content, the pattern matched its own implementation. Measured twice in
      // this repository — `src/core/ledger/drift-tracker.ts` (the regex literal that used to sit
      // in the line loop above) and `src/cli/html-reporter.ts` (the highlighter for the same
      // directive) each acquired a content marker they do not semantically have. Because
      // `R_struct` is a bundle-scoped set, one phantom marker being elided drove it to 0 and took
      // a 16-file batch to `S_k = 0.4053`, on a run whose real symbol retention was **99.1%**.
      // Narrowed to `code` specifically, not to the prose content types generally. `TD_PRESERVE:`
      // is an unambiguous TokenDamper token rather than an English word, so the only way it
      // appears without being a directive is as a literal inside an expression — a regex or a
      // string — and that construct exists only in code. Filtering JSON or logs the same way
      // would drop real directives for no measured benefit, since neither has comments for one
      // to survive in.
      const directiveSource =
        item.contentType === 'code' ? extractProseRegions(item.content, item.contentType) : item.content;
      const directivePattern = /(TD_PRESERVE:[^\s>\n]+)/g;
      let directiveHit: RegExpExecArray | null;
      while ((directiveHit = directivePattern.exec(directiveSource)) !== null) {
        if (directiveHit[1]) markers.add(`directive:${directiveHit[1]}`);
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
