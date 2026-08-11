import type { ContextBundle, OptimizationBudget } from '../model/types';

/**
 * Turns the budget's two ceilings into the one absolute token count the pipeline can act on.
 *
 * `targetReductionRatio` was a dial in name only. The planner read it as `> 0` to choose
 * knapsack mode over pass-through and nothing else read it at all, so `0.01` and `0.99`
 * produced byte-identical output — the audit verified exactly that (H4). It was left in place
 * when the other dead knobs were withdrawn because it is the flag every document and example
 * uses, and making it real is a pipeline change rather than a flag change. This is that change.
 *
 * **The mapping is proportional-to-absolute.** A ratio is a statement about the *input*:
 * "remove 30% of what I gave you" is "keep at most 70% of it". Once resolved against the
 * incoming bundle it is an ordinary token ceiling, which is what `pruning:topology-pruner` and
 * the 0/1 knapsack already solve against. No new selection machinery is needed — the ratio just
 * stops being ignored.
 *
 * **Both ceilings are caps, so the tighter one wins.** Supplying `maxInputTokens: 500` and
 * `targetReductionRatio: 0.9` on a 10,000-token bundle means "at most 500" and "at most 1,000";
 * honouring anything but the smaller would exceed a limit the caller set. Taking the minimum is
 * the only reading that violates neither.
 */
export function resolveTokenCeiling(
  bundle: ContextBundle,
  budget: OptimizationBudget,
): number | undefined {
  const ceilings: number[] = [];

  if (typeof budget.maxInputTokens === 'number' && budget.maxInputTokens > 0) {
    ceilings.push(budget.maxInputTokens);
  }

  const ratio = budget.targetReductionRatio;
  if (typeof ratio === 'number' && ratio > 0) {
    // `floor`, not `round`: a ceiling that rounds up can leave the achieved reduction just under
    // the requested one, which is the reading a caller is least likely to want from a *target*.
    // Clamped at 0 because a ratio of exactly 1.0 asks for everything to go, and a negative
    // ceiling is not a thing the rest of the pipeline can interpret.
    ceilings.push(Math.max(0, Math.floor(bundle.summary.tokenEstimate * (1 - ratio))));
  }

  return ceilings.length === 0 ? undefined : Math.min(...ceilings);
}

/**
 * Whether a bundle has already reached the ceiling, so further elision would overshoot.
 *
 * This is what makes the flag a *target* rather than a floor. Before this, `--target-reduction-ratio
 * 0.3` on a single TypeScript file produced **44.62%**: the stages ran to exhaustion and stopped
 * only when they ran out of things to elide. Overshooting is not free — every additional elision
 * spends semantic fidelity, raises drift and, on the CLI, is irreversible because no `TokenHasher`
 * is wired in. Removing half again as much as the caller asked for is a defect, not a bonus.
 *
 * `undefined` means no ceiling was set, in which case nothing is satisfied and the stages behave
 * exactly as they did.
 */
export function ceilingReached(currentTokens: number, ceiling: number | undefined): boolean {
  return ceiling !== undefined && currentTokens <= ceiling;
}
