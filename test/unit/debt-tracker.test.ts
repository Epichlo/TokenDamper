import { describe, expect, it } from 'vitest';
import { ConfidenceLedger } from '../../src/core/ledger/confidence-ledger';
import { DebtTracker } from '../../src/core/ledger/debt-tracker';

describe('DebtTracker', () => {
  it('calculates zero optimization debt when context is fresh with no elisions', () => {
    const tracker = new DebtTracker();
    const breakdown = tracker.calculateDebt({
      currentTurn: 1,
      overallConfidence: 1.0,
      elidedBytes: 0,
      totalBytes: 1000,
    });

    expect(breakdown.debtScore).toBe(0.0);
    expect(breakdown.confidencePenalty).toBe(0.0);
    expect(breakdown.elisionRatioPenalty).toBe(0.0);
    expect(breakdown.turnAgePenalty).toBe(0.0);
    expect(breakdown.shouldRehydrate).toBe(false);
    expect(breakdown.rehydrationReason).toBeUndefined();
  });

  it('calculates debt score accurately based on penalties', () => {
    const tracker = new DebtTracker({
      weightConfidence: 0.5,
      weightElisionRatio: 0.35,
      weightTurnAge: 1.5,
      maxDebtThreshold: 75.0,
    });

    // overallConfidence = 0.8 => confidencePenalty = 0.5 * (1 - 0.8) * 100 = 10.0
    // elidedBytes = 500, totalBytes = 1000 => elisionRatioPenalty = 0.35 * 0.5 * 100 = 17.5
    // oldestElidedTurn = 1, currentTurn = 5 => turnAge = 4 => turnAgePenalty = 1.5 * 4 = 6.0
    // Total debtScore = 10.0 + 17.5 + 6.0 = 33.5

    const breakdown = tracker.calculateDebt({
      currentTurn: 5,
      overallConfidence: 0.8,
      elidedBytes: 500,
      totalBytes: 1000,
      oldestElidedTurn: 1,
    });

    expect(breakdown.debtScore).toBeCloseTo(33.5);
    expect(breakdown.confidencePenalty).toBeCloseTo(10.0);
    expect(breakdown.elisionRatioPenalty).toBeCloseTo(17.5);
    expect(breakdown.turnAgePenalty).toBeCloseTo(6.0);
    expect(breakdown.shouldRehydrate).toBe(false);
  });

  it('triggers shouldRehydrate when D_k > 75.0 threshold', () => {
    const tracker = new DebtTracker({ maxDebtThreshold: 75.0 });

    // overallConfidence = 0.1 => 0.5 * 0.9 * 100 = 45
    // elisionRatio = 1.0 => 0.35 * 1.0 * 100 = 35
    // turnAge = 10 => 1.5 * 10 = 15
    // Total raw debtScore = 45 + 35 + 15 = 95.0 (> 75.0)

    const breakdown = tracker.calculateDebt({
      currentTurn: 11,
      overallConfidence: 0.1,
      elidedBytes: 1000,
      totalBytes: 1000,
      oldestElidedTurn: 1,
    });

    expect(breakdown.debtScore).toBe(95.0);
    expect(breakdown.shouldRehydrate).toBe(true);
    expect(tracker.shouldRehydrate({
      currentTurn: 11,
      overallConfidence: 0.1,
      elidedBytes: 1000,
      totalBytes: 1000,
      oldestElidedTurn: 1,
    })).toBe(true);
    expect(breakdown.rehydrationReason).toContain('exceeds threshold');
  });

  it('clamps debt score to maximum 100.0', () => {
    const tracker = new DebtTracker();

    const breakdown = tracker.calculateDebt({
      currentTurn: 100,
      overallConfidence: 0.0,
      elidedBytes: 10000,
      totalBytes: 10000,
      oldestElidedTurn: 1,
    });

    expect(breakdown.debtScore).toBe(100.0);
    expect(breakdown.shouldRehydrate).toBe(true);
  });

  it('retrieves rehydration candidate item IDs from confidence ledger', () => {
    const tracker = new DebtTracker();
    const ledger = new ConfidenceLedger({ defaultDecayRate: 0.5, defaultThreshold: 0.7 });

    ledger.recordElision({
      itemId: 'stale-1',
      blockHash: 'hash-1',
      turn: 1,
      originalBytes: 500,
    });

    ledger.recordElision({
      itemId: 'fresh-2',
      blockHash: 'hash-2',
      turn: 5,
      originalBytes: 500,
    });

    // At turn 5: stale-1 has decayed confidence 1.0 * 0.5^4 = 0.0625 (< 0.7)
    const candidates = tracker.getRehydrationCandidates(ledger, 5);
    expect(candidates).toContain('stale-1');
    expect(candidates).not.toContain('fresh-2');
  });
});
