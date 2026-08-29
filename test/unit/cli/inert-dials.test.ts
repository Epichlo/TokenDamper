import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArguments, runCli } from '../../../src/cli/main';

/**
 * Audit OX-M13, paired with DECISIONS §64's finding about `--max-debt`.
 *
 * **This is a characterization test, not a regression test.** It passes against the tree that
 * prompted it, because M13 is a documentation item: the two dials below are accepted, validated,
 * and threaded all the way to `optimize()` — and then cannot change a CLI run's output. Pinning
 * that here means a future change which makes either dial live fails this test on purpose, and
 * the README paragraph it documents has to be rewritten in the same commit rather than silently
 * outliving the behaviour it describes.
 *
 * Why each is inert on the CLI, read out of source rather than inferred:
 *
 *   --minimum-confidence  `validate()` sets `confidence = passed ? 1 : 0`
 *                         (`src/core/validation/index.ts`). Both engine gates read
 *                         `validation.confidence < minimumConfidence`, which for a passing run
 *                         is `1 < x` — false for every value the config schema admits, since it
 *                         validates into [0, 1] (audit OX-M10). For a failing run it is `0 < x`,
 *                         true, but `!validation.passed` has already fired on the same line, so
 *                         the clause decides nothing. The other arm, `finalLedgerConfidence`,
 *                         is a literal `1.0` when no `confidenceLedger` is supplied — and the
 *                         CLI supplies none.
 *
 *   --max-debt            sets `maxDebtThreshold`, which can flip `shouldRehydrate` and enter
 *                         the rehydration branch. `attemptAutomatedRehydration` then returns
 *                         `undefined` on its first line when there is neither a hasher nor a
 *                         ledger, and the CLI supplies neither. Note this reason is stronger
 *                         than §64's ("the elision term caps at 35, the threshold is 75"):
 *                         that explains the *default*, but `--max-debt` is precisely the flag
 *                         that lowers the threshold, so the default is not what makes it inert.
 */
describe('two dials that reach the engine and change nothing on a CLI run (audit OX-M13)', () => {
  const SOURCE = [
    'def compute_totals(rows):',
    '    """Sum the amounts, skipping anything that will not coerce."""',
    '    total = 0',
    '    for row in rows:',
    '        try:',
    '            total += float(row["amount"])',
    '        except (KeyError, TypeError, ValueError):',
    '            continue',
    '    return total',
    '',
    'def describe(rows):',
    '    parts = []',
    '    for row in rows:',
    '        parts.append(f"{row.get(\'name\', \'?\')}={row.get(\'amount\', 0)}")',
    '    return ", ".join(parts)',
    '',
  ].join('\n');

  const runArgv = (argv: readonly string[]): { code: number; out: string; err: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'td-ox-m13-'));
    const file = join(dir, 'sample.py');
    writeFileSync(file, SOURCE, 'utf8');
    const out: string[] = [];
    const err: string[] = [];
    const mockIo = {
      stdout: { write: (c: unknown) => (out.push(String(c)), true) } as never,
      stderr: { write: (c: unknown) => (err.push(String(c)), true) } as never,
    };
    try {
      const code = runCli(['optimize', file, ...argv], mockIo, process.cwd());
      return { code: code as number, out: out.join(''), err: err.join('') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const run = (extra: readonly string[]): { code: number; out: string; err: string } =>
    runArgv(['--target-reduction-ratio', '0.3', ...extra]);

  it('the flags really are parsed and carried — the run below is not a no-op by accident', () => {
    // Invariant 10: without this, every assertion further down would pass just as well if the
    // parser had silently dropped both flags, and the test would be pinning nothing.
    expect(parseArguments(['optimize', 'x.py', '--minimum-confidence', '0.05'], process.cwd()).configOverrides)
      .toMatchObject({ minimumConfidence: 0.05 });
    expect(parseArguments(['optimize', 'x.py', '--max-debt', '1'], process.cwd()).maxDebt).toBe(1);
  });

  it('produces reducing output at all, so the comparisons below are not comparing two no-ops', () => {
    const baseline = run([]);
    expect(baseline.code).toBe(0);
    expect(baseline.out.length).toBeGreaterThan(0);
    expect(baseline.out.length).toBeLessThan(SOURCE.length);
  });

  it('--minimum-confidence changes nothing across its whole admissible range', () => {
    const baseline = run([]);
    for (const value of ['0', '0.01', '0.5', '0.99', '1']) {
      const withDial = run(['--minimum-confidence', value]);
      expect(withDial.code, `exit code at --minimum-confidence ${value}`).toBe(baseline.code);
      expect(withDial.out, `stdout at --minimum-confidence ${value}`).toBe(baseline.out);
    }
  });

  it('--max-debt changes nothing, including below the 35-point elision ceiling', () => {
    const baseline = run([]);
    for (const value of ['0', '1', '10', '34', '75', '100']) {
      const withDial = run(['--max-debt', value]);
      expect(withDial.code, `exit code at --max-debt ${value}`).toBe(baseline.code);
      expect(withDial.out, `stdout at --max-debt ${value}`).toBe(baseline.out);
    }
  });

  it('a budget flag, by contrast, is live — the control that keeps the above from meaning "this harness sees nothing"', () => {
    // Without this the two assertions above would pass equally well on a harness that could not
    // observe any flag at all, which is invariant 10's failure mode: a green result from a check
    // that never looked.
    //
    // The control is a budget flag rather than `--max-drift`, and the first attempt at this test
    // used `--max-drift 0` vs `--max-drift 1` and *failed* — they emit identical bytes, because
    // drift on this fixture is already 0.0000 and the gate asks whether drift exceeds the
    // threshold, not whether it reaches it. That is CLAUDE.md's note that 86% of elided Python
    // function bodies contribute no symbols, showing up as a control that does not control.
    // A budget flag has no such escape: with none, the planner returns `pass_through` with an
    // empty `stageIds` and reduction is guaranteed 0%.
    const noBudget = runArgv([]);
    const withBudget = run([]);
    expect(noBudget.code).toBe(0);
    expect(withBudget.out).not.toBe(noBudget.out);
  });
});
