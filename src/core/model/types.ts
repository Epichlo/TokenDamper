/**
 * The supported optimization mode for the frozen MVP planner.
 */
export type OptimizationMode = 'pass_through';

/**
 * The supported source classification for a normalized context bundle.
 */
export type ContextSource = 'cli';

/**
 * The supported item kinds inside a context bundle.
 */
export type ContextItemKind = 'prompt' | 'file' | 'diff' | 'conversation' | 'note';

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
  readonly itemId: string;
  readonly kind: ContextItemKind;
  readonly content: string;
  readonly origin: string;
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
  readonly bundleId: string;
  readonly source: ContextSource;
  readonly items: ReadonlyArray<ContextItem>;
  readonly summary: ContextSummary;
  readonly contentHash: string;
}

/**
 * The immutable optimization constraint model.
 */
export interface OptimizationBudget {
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly targetReductionRatio?: number;
  readonly maxLatencyMs?: number;
  readonly riskTolerance: 'low' | 'medium' | 'high';
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

/**
 * A validation issue emitted by a validator.
 */
export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly severity: ValidationIssueSeverity;
}

/**
 * The immutable validation outcome for an optimization attempt.
 */
export interface ValidationReport {
  readonly passed: boolean;
  readonly confidence: number;
  readonly issues: ReadonlyArray<ValidationIssue>;
  readonly shouldFallback: boolean;
  readonly reason?: string;
}

/**
 * A stage-level trace entry included in the final optimization trace.
 */
export interface StageTrace {
  readonly stageId: string;
  readonly status: StageStatus;
  readonly durationMs: number;
  readonly changed: boolean;
}

/**
 * The lightweight execution trace produced for every request.
 */
export interface OptimizationTrace {
  readonly requestId: string;
  readonly planMode: OptimizationMode;
  readonly stageCount: number;
  readonly stageTraces: ReadonlyArray<StageTrace>;
  readonly tokenBefore: number;
  readonly tokenAfter: number;
  readonly fallbackUsed: boolean;
  readonly fallbackReason?: string;
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
