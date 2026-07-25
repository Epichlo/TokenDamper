export interface RecordElisionParams {
  readonly itemId: string;
  readonly blockHash: string;
  readonly turn: number;
  readonly elisionType?: 'session-dedup' | 'token-hashing' | 'delta-compression' | string;
  readonly originalBytes: number;
  readonly path?: string;
  readonly kind?: string;
  readonly initialConfidence?: number;
}

export interface ElisionRecord {
  readonly itemId: string;
  readonly blockHash: string;
  readonly elisionTurn: number;
  readonly lastAccessedTurn: number;
  readonly elisionType: string;
  readonly originalBytes: number;
  readonly path?: string;
  readonly kind?: string;
  readonly referenceCount: number;
  readonly initialConfidence: number;
  readonly confidence: number;
}

export interface ConfidenceLedgerOptions {
  readonly defaultDecayRate?: number;
  readonly accessBoost?: number;
  readonly defaultThreshold?: number;
}

/**
 * Stateful ledger tracking context elisions across conversation turns.
 * Calculates mathematical restoration safety scores (C_elision) and identifies
 * candidates for re-hydration when confidence drops below safety thresholds.
 */
export class ConfidenceLedger {
  private readonly records = new Map<string, ElisionRecord>();
  private readonly decayRate: number;
  private readonly accessBoost: number;
  private readonly defaultThreshold: number;

  constructor(options: ConfidenceLedgerOptions = {}) {
    this.decayRate = options.defaultDecayRate ?? 0.9;
    this.accessBoost = options.accessBoost ?? 0.15;
    this.defaultThreshold = options.defaultThreshold ?? 0.7;
  }

  /**
   * Records a new context item elision into the ledger.
   */
  public recordElision(params: RecordElisionParams): ElisionRecord {
    const initialConfidence = params.initialConfidence ?? 1.0;
    const record: ElisionRecord = {
      itemId: params.itemId,
      blockHash: params.blockHash,
      elisionTurn: params.turn,
      lastAccessedTurn: params.turn,
      elisionType: params.elisionType ?? 'token-hashing',
      originalBytes: params.originalBytes,
      ...(params.path ? { path: params.path } : {}),
      ...(params.kind ? { kind: params.kind } : {}),
      referenceCount: 1,
      initialConfidence,
      confidence: initialConfidence,
    };

    // Key by itemId and blockHash for dual lookup
    this.records.set(params.itemId, record);
    this.records.set(params.blockHash, record);

    return record;
  }

  /**
   * Updates access turn and reference count for an elided item, refreshing its confidence score.
   */
  public updateAccess(itemIdOrHash: string, turn: number): ElisionRecord | undefined {
    const record = this.records.get(itemIdOrHash);
    if (!record) {
      return undefined;
    }

    const updated: ElisionRecord = {
      ...record,
      lastAccessedTurn: Math.max(record.lastAccessedTurn, turn),
      referenceCount: record.referenceCount + 1,
      confidence: this.computeConfidenceScore(record, turn, record.referenceCount + 1),
    };

    this.records.set(record.itemId, updated);
    this.records.set(record.blockHash, updated);

    return updated;
  }

  /**
   * Calculates the restoration safety score (C_elision) for an elided item at the given turn.
   */
  public calculateConfidence(itemIdOrHash: string, currentTurn: number): number {
    const record = this.records.get(itemIdOrHash);
    if (!record) {
      return 1.0; // Untracked items have full confidence
    }
    return this.computeConfidenceScore(record, currentTurn, record.referenceCount);
  }

  /**
   * Computes the aggregated overall restoration safety confidence across all active elisions.
   * Returns 1.0 if no elisions are currently tracked.
   */
  public getOverallConfidence(currentTurn: number): number {
    const unique = this.getUniqueRecords(currentTurn);
    if (unique.length === 0) {
      return 1.0;
    }

    let minConfidence = 1.0;
    for (const record of unique) {
      if (record.confidence < minConfidence) {
        minConfidence = record.confidence;
      }
    }

    return minConfidence;
  }

  /**
   * Identifies all elision records whose restoration safety score C_elision at currentTurn
   * falls below the specified confidence threshold.
   */
  public getRehydrationCandidates(currentTurn: number, threshold?: number): ReadonlyArray<ElisionRecord> {
    const targetThreshold = threshold ?? this.defaultThreshold;
    const unique = this.getUniqueRecords(currentTurn);

    return unique.filter((record) => record.confidence < targetThreshold);
  }

  /**
   * Removes an elision from the ledger when it is re-hydrated back to full text.
   */
  public removeElision(itemIdOrHash: string): boolean {
    const record = this.records.get(itemIdOrHash);
    if (!record) {
      return false;
    }

    this.records.delete(record.itemId);
    this.records.delete(record.blockHash);
    return true;
  }

  /**
   * Retrieves an elision record by itemId or blockHash.
   */
  public getElision(itemIdOrHash: string): ElisionRecord | undefined {
    return this.records.get(itemIdOrHash);
  }

  /**
   * Returns all unique tracked elision records updated to currentTurn.
   */
  public getAllElisions(currentTurn = 1): ReadonlyArray<ElisionRecord> {
    return this.getUniqueRecords(currentTurn);
  }

  /**
   * Returns total count of unique tracked elisions.
   */
  public get size(): number {
    return new Set(this.records.values()).size;
  }

  /**
   * Clears all stored records in the ledger.
   */
  public clear(): void {
    this.records.clear();
  }

  private computeConfidenceScore(record: ElisionRecord, currentTurn: number, refCount: number): number {
    const deltaT = Math.max(0, currentTurn - record.lastAccessedTurn);
    const decayMultiplier = Math.pow(this.decayRate, deltaT);
    const decayedConfidence = record.initialConfidence * decayMultiplier;

    const boost = Math.min(0.3, (refCount - 1) * this.accessBoost);
    const rawScore = decayedConfidence + boost;

    return Math.max(0.0, Math.min(1.0, rawScore));
  }

  private getUniqueRecords(currentTurn: number): ElisionRecord[] {
    const set = new Set<ElisionRecord>();
    for (const record of this.records.values()) {
      set.add(record);
    }

    return Array.from(set).map((rec) => {
      const confidence = this.computeConfidenceScore(rec, currentTurn, rec.referenceCount);
      return { ...rec, confidence };
    });
  }
}
