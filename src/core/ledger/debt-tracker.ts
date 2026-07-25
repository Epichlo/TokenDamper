import type { ConfidenceLedger } from './confidence-ledger';

export interface DebtScoreParams {
  readonly currentTurn: number;
  readonly overallConfidence: number;
  readonly elidedBytes: number;
  readonly totalBytes: number;
  readonly oldestElidedTurn?: number | undefined;
}

export interface DebtBreakdown {
  readonly debtScore: number;
  readonly confidencePenalty: number;
  readonly elisionRatioPenalty: number;
  readonly turnAgePenalty: number;
  readonly shouldRehydrate: boolean;
  readonly rehydrationReason?: string | undefined;
}

export interface DebtTrackerOptions {
  readonly maxDebtThreshold?: number | undefined;
  readonly weightConfidence?: number | undefined;
  readonly weightElisionRatio?: number | undefined;
  readonly weightTurnAge?: number | undefined;
}

/**
 * Optimization Debt Tracker tracking multi-turn context elision accumulation,
 * decay rates, and triggering context re-hydration when debt score D_k > 75.0.
 */
export class DebtTracker {
  private readonly maxDebtThreshold: number;
  private readonly weightConfidence: number;
  private readonly weightElisionRatio: number;
  private readonly weightTurnAge: number;

  constructor(options: DebtTrackerOptions = {}) {
    this.maxDebtThreshold = options.maxDebtThreshold ?? 75.0;
    this.weightConfidence = options.weightConfidence ?? 0.50;
    this.weightElisionRatio = options.weightElisionRatio ?? 0.35;
    this.weightTurnAge = options.weightTurnAge ?? 1.50;
  }

  /**
   * Calculates the Optimization Debt Score D_k in [0.0, 100.0].
   */
  public calculateDebt(params: DebtScoreParams): DebtBreakdown {
    const clampedConfidence = Math.max(0.0, Math.min(1.0, params.overallConfidence));
    const confidencePenalty = this.weightConfidence * (1.0 - clampedConfidence) * 100;

    const elisionRatio =
      params.totalBytes > 0 ? Math.max(0.0, Math.min(1.0, params.elidedBytes / params.totalBytes)) : 0;
    const elisionRatioPenalty = this.weightElisionRatio * elisionRatio * 100;

    const turnAge =
      params.oldestElidedTurn !== undefined && params.oldestElidedTurn > 0
        ? Math.max(0, params.currentTurn - params.oldestElidedTurn)
        : 0;
    const turnAgePenalty = this.weightTurnAge * turnAge;

    const rawScore = confidencePenalty + elisionRatioPenalty + turnAgePenalty;
    const debtScore = Math.min(100.0, Math.max(0.0, rawScore));
    const shouldRehydrate = debtScore > this.maxDebtThreshold;
    const rehydrationReason = shouldRehydrate
      ? `Optimization debt score (${debtScore.toFixed(2)}) exceeds threshold (${this.maxDebtThreshold.toFixed(2)}).`
      : undefined;

    return {
      debtScore,
      confidencePenalty,
      elisionRatioPenalty,
      turnAgePenalty,
      shouldRehydrate,
      ...(rehydrationReason ? { rehydrationReason } : {}),
    };
  }

  /**
   * Determines if automated context re-hydration should be triggered.
   */
  public shouldRehydrate(params: DebtScoreParams): boolean {
    return this.calculateDebt(params).shouldRehydrate;
  }

  /**
   * Identifies candidate item IDs from the confidence ledger that require re-hydration.
   */
  public getRehydrationCandidates(ledger: ConfidenceLedger, turn: number): ReadonlyArray<string> {
    const candidates = ledger.getRehydrationCandidates(turn);
    const itemIds = new Set<string>();
    for (const candidate of candidates) {
      itemIds.add(candidate.itemId);
    }
    return Array.from(itemIds);
  }
}
