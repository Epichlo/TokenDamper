/**
 * The supported optimization mode for the frozen MVP planner.
 */
export type OptimizationMode = 'pass_through' | 'topology_knapsack' | 'session_dedup';

/**
 * The supported source classification for a normalized context bundle.
 */
export type ContextSource = 'cli' | 'stdin' | 'file' | 'text';

/**
 * The supported item kinds inside a context bundle.
 */
export type ContextItemKind = 'prompt' | 'file' | 'diff' | 'conversation' | 'note';

/**
 * The supported deterministic content classifications.
 */
export type ContentType = 'text' | 'markdown' | 'code' | 'html' | 'json' | 'yaml' | 'logs' | 'unknown';

/**
 * The supported runtime modes for configuration.
 */
export type AppMode = 'optimize' | 'explain' | 'bench';

/**
 * The supported log levels for configuration.
 */
export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

/**
 * The supported trace output destinations for configuration.
 */
export type TraceOutput = 'stderr' | 'stdout';

/**
 * The supported fallback policy for the MVP.
 */
export type FallbackPolicy = 'original_input';

/**
 * The supported validation issue severities.
 */
export type ValidationIssueSeverity = 'info' | 'warning' | 'error';

/**
 * A single immutable item inside a normalized context bundle.
 */
export interface ContextItem {
  readonly id: string;
  readonly itemId: string;
  readonly kind: ContextItemKind;
  readonly contentType: ContentType;
  readonly content: string;
  readonly origin: string;
  readonly contentHash: string;
  readonly role?: string;
  readonly path?: string;
  readonly language?: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * A lightweight summary for a normalized context bundle.
 */
export interface ContextSummary {
  readonly itemCount: number;
  readonly tokenEstimate: number;
  readonly preview: string;
}

/**
 * The immutable normalized input bundle that flows through the engine.
 */
export interface ContextBundle {
  readonly id: string;
  readonly bundleId: string;
  readonly source: ContextSource;
  readonly items: ReadonlyArray<ContextItem>;
  readonly summary: ContextSummary;
  readonly statistics: BundleStatistics;
  readonly contentHash: string;
}

/**
 * Aggregated bundle statistics used by the trace and validation layers.
 */
export interface BundleStatistics {
  readonly itemCount: number;
  readonly contentTypeCounts: Readonly<Record<ContentType, number>>;
  readonly kindCounts: Readonly<Record<ContextItemKind, number>>;
  readonly totalCharacters: number;
}

/**
 * The immutable optimization constraint model.
 *
 * Three of these fields are **declared but unconsumed**, and saying so here is the point —
 * audit H4 found them wired end to end through the CLI, the environment and the MCP schema
 * while no stage, validator or planner read them. The command-line and environment surfaces
 * were withdrawn; the fields remain because `ARCHITECTURE.md` pins this model as frozen and a
 * field awaiting an implementation is not the same defect as a dial that reports success.
 *
 * Anything added here should be readable from somewhere in `src/core/` before it is offered
 * to a user.
 */
export interface OptimizationBudget {
  /** Read by `planner.plan` — any value `> 0` selects knapsack mode over pass-through. */
  readonly maxInputTokens?: number;
  /** Unconsumed. No stage, validator or planner reads this. */
  readonly maxOutputTokens?: number;
  /**
   * Read by `planner.plan`, but **only as `> 0`** — it selects knapsack mode and is never used
   * as a proportional target. Making it one is a planner change, tracked separately.
   */
  readonly targetReductionRatio?: number;
  /** Unconsumed. No stage, validator or planner reads this. */
  readonly maxLatencyMs?: number;
  /** Unconsumed by the pipeline; `cli/bench-table-renderer` prints it in a column. */
  readonly riskTolerance: 'low' | 'medium' | 'high';
  /** Read by `cleanup:session-dedup` and `compression:delta-compression`. */
  readonly preserveKinds: ReadonlyArray<ContextItemKind>;
}

/**
 * The immutable resolved runtime configuration used by the engine.
 */
export interface ResolvedConfig {
  readonly appName: string;
  readonly appVersion: string;
  readonly appMode: AppMode;
  readonly traceOutput: TraceOutput;
  readonly planner: {
    readonly defaultMode: OptimizationMode;
  };
  readonly budget: OptimizationBudget;
  readonly validation: {
    readonly minimumConfidence: number;
  };
  readonly logging: {
    readonly level: LogLevel;
  };
}

/**
 * The normalized request accepted by the engine after adapter parsing.
 */
export interface OptimizationRequest {
  readonly requestId: string;
  readonly rawInput: string;
  readonly bundle: ContextBundle;
  readonly budget: OptimizationBudget;
  readonly config: ResolvedConfig;
  readonly adapterName: string;
  readonly adapterVersion: string;
}

/**
 * A checkpoint for a selected optimization plan.
 */
export type PlanCheckpoint = 'end';

/**
 * The frozen plan chosen by the stateless planner.
 */
export interface OptimizationPlan {
  readonly planId: string;
  readonly mode: OptimizationMode;
  readonly stageIds: ReadonlyArray<string>;
  readonly revalidationPoints: ReadonlyArray<PlanCheckpoint>;
  readonly fallbackPolicy: FallbackPolicy;
  readonly expectedSavings?: number;
}

/**
 * The execution status reported by a stage.
 */
export type StageStatus = 'ok' | 'skipped' | 'failed';

/**
 * The immutable result returned by a built-in stage.
 */
export interface StageResult {
  readonly stageId: string;
  readonly status: StageStatus;
  readonly bundle: ContextBundle;
  readonly changed: boolean;
  readonly metrics: Readonly<Record<string, number>>;
  readonly notes?: string;
}

import type { DriftReport } from '../ledger/drift-tracker';

/**
 * A validation issue emitted by a validator.
 */
export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly severity: ValidationIssueSeverity;
}

/**
 * How much of a bundle the AST validators actually examined.
 *
 * Reported so that "no syntax errors" cannot be read as "every item was checked". There is
 * no validator for prose, markup, YAML or log output, so `unchecked > 0` is the normal case
 * on conversational traffic — it is a statement of coverage, not a warning.
 */
export interface AstCoverage {
  readonly checked: number;
  readonly unchecked: number;
  readonly uncheckedContentTypes: ReadonlyArray<ContentType>;
}

/**
 * Whether the drift metric had anything to measure — the same distinction `AstCoverage`
 * draws for syntax, applied to `S_k`.
 *
 * `R_AST` and `R_struct` each default to `1.0` when their *pre-optimization* set is empty,
 * so an item the extractors found nothing in scored as perfectly retained. That is "nothing
 * to measure" reported as "measured and clean", and it approved deleting content outright:
 * `src/index.ts` is fourteen `export * from './x';` lines, yields no symbols, and was elided
 * whole — 420 bytes to a 67-byte marker, 86.15% of its tokens — at `S_k = 0.0000` with no
 * fallback.
 *
 * `filepath:` deserves separate mention. It is derived from `item.path`, not from content,
 * so no content transform can destroy it: it makes `markersBefore` non-empty for every item
 * that has a path while witnessing nothing about what the item contains. It is counted in
 * `R_struct` (unchanged — see DECISIONS §18 for that separate defect) but must not count as
 * evidence here, or every pathed item would look measured.
 */
export interface DriftCoverage {
  readonly astMeasured: boolean;
  readonly structMeasured: boolean;
  readonly measured: boolean;
  readonly contentChanged: boolean;
  readonly symbolsBefore: number;
  readonly contentMarkersBefore: number;
  /** Items an AST validator covers, for which symbols are the expected witness. */
  readonly symbolBearingItems: number;
  /** Of those, the ones changed without leaving any evidence of retention. */
  readonly unwitnessedItems: ReadonlyArray<string>;
}

/**
 * The immutable validation outcome for an optimization attempt.
 */
export interface ValidationReport {
  readonly passed: boolean;
  readonly confidence: number;
  readonly issues: ReadonlyArray<ValidationIssue>;
  readonly shouldFallback: boolean;
  readonly reason?: string | undefined;
  readonly driftReport?: DriftReport | undefined;
  readonly astCoverage?: AstCoverage | undefined;
  readonly driftCoverage?: DriftCoverage | undefined;
}

/**
 * A stage-level trace entry included in the final optimization trace.
 */
export interface StageTrace {
  readonly stageId: string;
  readonly status: StageStatus;
  /**
   * Wall time for this stage, measured by the engine.
   *
   * Measured by the engine and not by the stage: a stage that read a clock would no longer be
   * a pure function of its input (invariant 1). Timing an opaque call from outside is an
   * observation *about* the stage, not an input to it, and cannot change what it returns.
   */
  readonly durationMs: number;
  readonly changed: boolean;
  /**
   * The stage's own counters — `itemsHashed`, `bytesSaved`, `regionsHashed`,
   * `irreversibleElisions`, `skippedPostConditionRejected`, and so on.
   *
   * Discarded entirely until 2026-08-09, along with `notes`. The stages compute this telemetry
   * carefully and the trace threw all of it away, so a reader could see *that* a stage ran and
   * changed something but not what it did, how much it removed, or whether the elisions were
   * reversible — on a product whose thesis is auditability. (audit M6)
   */
  readonly metrics: Readonly<Record<string, number>>;
  readonly notes?: string | undefined;
}

/**
 * The lightweight execution trace produced for every request.
 */
export interface OptimizationTrace {
  readonly requestId: string;
  readonly bundleId: string;
  readonly bundleContentHash: string;
  readonly planMode: OptimizationMode;
  readonly stageCount: number;
  readonly stageTraces: ReadonlyArray<StageTrace>;
  readonly inputTokenEstimate: number;
  readonly outputTokenEstimate: number;
  readonly tokenBefore: number;
  readonly tokenAfter: number;
  readonly bundleStatistics: BundleStatistics;
  readonly fallbackUsed: boolean;
  readonly fallbackReason?: string | undefined;
  readonly debtScore?: number | undefined;
  readonly driftScore?: number | undefined;
  readonly astCoverage?: AstCoverage | undefined;
  readonly driftCoverage?: DriftCoverage | undefined;
}

/**
 * The final output returned by the engine.
 */
export interface OptimizationResult {
  readonly finalBundle: ContextBundle;
  readonly emittedOutput: string;
  readonly validation: ValidationReport;
  readonly trace: OptimizationTrace;
  readonly fallbackUsed: boolean;
}
