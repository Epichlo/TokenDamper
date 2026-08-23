import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../../src/cli/main';

/**
 * Dropping a file is not eliding it, and the difference has to reach the user.
 *
 * `pruning:topology-pruner` removes whole items to meet the token budget. Elision leaves a
 * marker naming what it took; pruning leaves nothing. On a directory run the file is simply
 * absent from stdout, and a caller piping that into a model cannot notice — the model will not
 * report a file it was never shown, it will infer the API and be confidently wrong about it.
 *
 * Measured on a real 8-item project at ratio 0.3, two modules vanished with no stdout signal.
 * The count was in the trace; *which* files, and the fact that it happened at all, were nowhere
 * a person reading a terminal would see.
 */
class Capture {
  public text = '';
  public write(chunk: string | Uint8Array): boolean {
    this.text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }
}

const body = (n: number) =>
  Array.from({ length: n }, (_, i) => `    value_${i} = compute(base, ${i}) * factor`).join('\n');

/** Five modules whose bodies elision can shrink. */
const writeElidableModules = (root: string): void => {
  for (const name of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
    const source = [
      `"""Module ${name}."""`,
      '',
      '',
      `def ${name}_one(base, factor):`,
      body(18),
      '    return value_0',
      '',
      '',
      `def ${name}_two(base, factor):`,
      body(18),
      '    return value_1',
      '',
    ].join('\n');
    writeFileSync(join(root, `${name}.py`), source, 'utf8');
  }
};

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'td-prune-'));
  mkdirSync(join(dir, 'mixed'), { recursive: true });
  mkdirSync(join(dir, 'elidable'), { recursive: true });

  writeElidableModules(join(dir, 'mixed'));
  writeElidableModules(join(dir, 'elidable'));

  // The load-bearing fixture, found by measurement rather than assumed: five elidable modules
  // under a tight budget prune **nothing**, because elision alone reaches the ceiling. The
  // knapsack drops whole items only when some item cannot be made smaller any other way. This
  // module has no function bodies, so it is exactly that — and it is the shape that produced
  // the silent loss on a real project: a prompt stored in a string, sitting in `src/`.
  writeFileSync(
    join(dir, 'mixed', 'prose.py'),
    `TEXT = """${'lorem ipsum dolor sit amet '.repeat(400)}"""\n`,
    'utf8',
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (args: string[]) => {
  const stdout = new Capture();
  const stderr = new Capture();
  const code = runCli(
    args,
    {
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
    },
    dir,
  );
  return { code, stdout: stdout.text, stderr: stderr.text };
};

const itemsPruned = (stderr: string): number => {
  const trace = JSON.parse(stderr.slice(stderr.indexOf('{')));
  const stage = trace.stageTraces.find(
    (s: { stageId: string }) => s.stageId === 'pruning:topology-pruner',
  );
  return stage.metrics.itemsPruned;
};

describe('warning when whole files are pruned', () => {
  it('names the dropped files on stderr when the knapsack removes them', () => {
    const { stderr, stdout } = run(['optimize', './mixed', '--target-reduction-ratio', '0.5']);

    // Only meaningful if the pruner actually dropped something. Without this the test would
    // pass on a run where nothing happened, which is the failure this repo has named repeatedly.
    expect(itemsPruned(stderr)).toBeGreaterThan(0);

    expect(stderr).toMatch(/removed entirely to meet the token budget/);

    // The warning has to describe reality: a file it names is genuinely absent from stdout.
    const named = /- (.*\.py)/.exec(stderr)?.[1];
    expect(named).toBeTruthy();
    expect(stdout).not.toContain(named as string);
  });

  it('gives advice that points in one direction', () => {
    // Audit OX-M14. The line read "Raise --target-reduction-ratio's budget (a lower ratio prunes
    // less)" — it names the flag, tells the reader to raise it, then parenthesises the opposite.
    // A user following the verb does the reverse of what the parenthesis intends.
    //
    // Asserted as a property rather than as exact prose: whichever verb the sentence uses about
    // `--target-reduction-ratio`, it must not also be the other one.
    const { stderr } = run(['optimize', './mixed', '--target-reduction-ratio', '0.5']);
    const advice = /^(?:Lower|Raise).*target-reduction-ratio.*$/m.exec(stderr)?.[0];

    expect(advice).toBeTruthy();
    expect(advice).toMatch(/Lower --target-reduction-ratio/);
    expect(advice).not.toMatch(/Raise --target-reduction-ratio/);
  });

  it('stays silent when nothing was dropped', () => {
    // A ceiling the bundle already fits under, so the knapsack has nothing to drop. The
    // warning must not appear — one that fires on every run is one users learn to ignore.
    //
    // An explicit token budget rather than a small ratio, because measuring the ratios showed
    // pruning at *every* one of 0.05 through 0.5 on this fixture: `resolveTokenCeiling` derives
    // the ceiling from the bundle, so a gentler ratio still lands below it. Pruning is far more
    // common than it looks, which is the argument for warning about it at all.
    const { stderr } = run(['optimize', './elidable', '--max-input-tokens', '5000']);

    expect(itemsPruned(stderr)).toBe(0);
    expect(stderr).not.toMatch(/removed entirely to meet the token budget/);
  });
});
