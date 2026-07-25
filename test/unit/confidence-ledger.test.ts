import { describe, expect, it } from 'vitest';
import { ConfidenceLedger } from '../../src/core/ledger/confidence-ledger';

describe('ConfidenceLedger', () => {
  it('records elision and computes initial confidence at creation turn', () => {
    const ledger = new ConfidenceLedger({ defaultDecayRate: 0.9 });
    const record = ledger.recordElision({
      itemId: 'item-100',
      blockHash: 'hash-abc-123',
      turn: 1,
      originalBytes: 500,
      path: 'src/core/ledger.ts',
      elisionType: 'token-hashing',
    });

    expect(record.itemId).toBe('item-100');
    expect(record.confidence).toBe(1.0);
    expect(ledger.size).toBe(1);
    expect(ledger.calculateConfidence('item-100', 1)).toBe(1.0);
    expect(ledger.calculateConfidence('hash-abc-123', 1)).toBe(1.0);
  });

  it('decays confidence exponentially across turns without access', () => {
    const ledger = new ConfidenceLedger({ defaultDecayRate: 0.9 });
    ledger.recordElision({
      itemId: 'item-decay',
      blockHash: 'hash-decay',
      turn: 1,
      originalBytes: 1000,
    });

    // Turn 1: 1.0
    expect(ledger.calculateConfidence('item-decay', 1)).toBe(1.0);

    // Turn 2: 1.0 * 0.9^1 = 0.9
    expect(ledger.calculateConfidence('item-decay', 2)).toBeCloseTo(0.9);

    // Turn 3: 1.0 * 0.9^2 = 0.81
    expect(ledger.calculateConfidence('item-decay', 3)).toBeCloseTo(0.81);

    // Turn 5: 1.0 * 0.9^4 = 0.6561
    expect(ledger.calculateConfidence('item-decay', 5)).toBeCloseTo(0.6561);
  });

  it('updates access turn and applies boost to restore confidence', () => {
    const ledger = new ConfidenceLedger({ defaultDecayRate: 0.9, accessBoost: 0.1 });
    ledger.recordElision({
      itemId: 'item-accessed',
      blockHash: 'hash-accessed',
      turn: 1,
      originalBytes: 800,
    });

    // Fast-forward to turn 4 without access -> 1.0 * 0.9^3 = 0.729
    expect(ledger.calculateConfidence('item-accessed', 4)).toBeCloseTo(0.729);

    // Update access at turn 4
    const updated = ledger.updateAccess('item-accessed', 4);
    expect(updated?.referenceCount).toBe(2);
    expect(updated?.lastAccessedTurn).toBe(4);

    // At turn 4 right after access: decayed = 1.0 * 0.9^0 = 1.0, plus boost (1 * 0.1) clamped to 1.0 -> 1.0
    expect(ledger.calculateConfidence('item-accessed', 4)).toBe(1.0);

    // At turn 5 (1 turn after access): 1.0 * 0.9^1 + 0.1 = 0.9 + 0.1 = 1.0
    expect(ledger.calculateConfidence('item-accessed', 5)).toBe(1.0);
  });

  it('identifies re-hydration candidates when confidence falls below threshold', () => {
    const ledger = new ConfidenceLedger({ defaultDecayRate: 0.8, defaultThreshold: 0.7 });

    ledger.recordElision({
      itemId: 'fresh-item',
      blockHash: 'hash-fresh',
      turn: 3,
      originalBytes: 400,
    });

    ledger.recordElision({
      itemId: 'stale-item',
      blockHash: 'hash-stale',
      turn: 1,
      originalBytes: 1200,
    });

    // At turn 3:
    // fresh-item: turn 3 -> turn 3 (delta 0) => 1.0 (>= 0.7)
    // stale-item: turn 1 -> turn 3 (delta 2) => 1.0 * 0.8^2 = 0.64 (< 0.7)

    const candidates = ledger.getRehydrationCandidates(3);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.itemId).toBe('stale-item');
  });

  it('computes overall minimum confidence across active elisions', () => {
    const ledger = new ConfidenceLedger({ defaultDecayRate: 0.9 });
    expect(ledger.getOverallConfidence(1)).toBe(1.0);

    ledger.recordElision({
      itemId: 'item-a',
      blockHash: 'hash-a',
      turn: 1,
      originalBytes: 200,
    });

    ledger.recordElision({
      itemId: 'item-b',
      blockHash: 'hash-b',
      turn: 1,
      originalBytes: 300,
    });

    // At turn 3: 1.0 * 0.9^2 = 0.81
    expect(ledger.getOverallConfidence(3)).toBeCloseTo(0.81);
  });

  it('removes elision when re-hydrated back into full text', () => {
    const ledger = new ConfidenceLedger();
    ledger.recordElision({
      itemId: 'item-to-rehydrate',
      blockHash: 'hash-rehydrate',
      turn: 1,
      originalBytes: 600,
    });

    expect(ledger.size).toBe(1);
    const removed = ledger.removeElision('item-to-rehydrate');
    expect(removed).toBe(true);
    expect(ledger.size).toBe(0);
    expect(ledger.getElision('item-to-rehydrate')).toBeUndefined();
  });
});
