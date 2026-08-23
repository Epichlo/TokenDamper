import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/main';

/**
 * `tokendamper exec` must exit with the code its child exited with — audit OX-H1.
 *
 * `runExecCommand` always resolved the real code; `runCli` threw it away. The `exec` branch fired
 * the promise, attached a `.catch`, and returned a synchronous `0`, which `main()` had already
 * assigned to `process.exitCode` long before the child finished. The process stayed alive only
 * because the spawned child holds the inherited stdio, so the code arrived — into nothing.
 *
 * The consequence is a shell one: `tokendamper exec -- aider … && next-step` runs `next-step`
 * after a failed tool, and any CI step wrapping a build in `exec` reports green regardless. This
 * is invariant 10 at the process boundary — a result that looks clean whatever happened.
 *
 * `test/integration/gateway-exec.test.ts` already pinned `runExecCommand`'s own return value, and
 * it passed the whole time. That is the interesting part: both components were correct and the
 * defect lived in the handoff, so the test has to cross the same seam the bug did — the CLI entry
 * point, not the exec helper.
 */
describe('tokendamper exec exit-code propagation', () => {
  let tempDir: string;
  let exiterPath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tokendamper-exit-'));
    exiterPath = join(tempDir, 'exiter.cjs');
    // A script file rather than `node -e`: `exec` spawns with `shell: true`, and an inline
    // payload would have to survive one round of shell quoting whose rules differ between cmd.exe
    // and sh. The existing gateway-exec test writes a child script for the same reason.
    writeFileSync(exiterPath, 'process.exit(Number(process.argv[2]));\n', 'utf8');
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const io = () => ({ stdout: new PassThrough(), stderr: new PassThrough() });
  const exiting = (code: number) => ['exec', '--', 'node', JSON.stringify(exiterPath), String(code)];

  it('returns a non-zero child exit code rather than 0', async () => {
    expect(await runCli(exiting(3), io())).toBe(3);
  }, 30_000);

  it('still returns 0 when the child succeeds', async () => {
    expect(await runCli(exiting(0), io())).toBe(0);
  }, 30_000);

  it('distinguishes one failing code from another', async () => {
    // A fixed non-zero would pass just as well against a hardcoded 1. The code has to be carried,
    // not merely detected.
    expect(await runCli(exiting(42), io())).toBe(42);
  }, 30_000);

  it('reports a non-zero code when the command cannot be executed at all', async () => {
    const code = await runCli(['exec', '--', 'tokendamper-no-such-command-xyz'], io());

    // Not asserting a specific value: a missing command is diagnosed by the shell, which reports
    // 127 on sh and 1 on cmd.exe. What must hold is that the failure is not reported as success.
    expect(code).not.toBe(0);
  }, 30_000);

  it('routes the shipped entry point through main() instead of repeating it', () => {
    // The tests above exercise `runCli`, and `main()` is what turns its result into
    // `process.exitCode` — but neither is what the installed command runs. `package.json`'s
    // `bin` points at `dist/src/cli/main.js`, so the `require.main === module` block at the foot
    // of the file is the real entry point, and it held its own copy of the assignment.
    //
    // That copy guarded on `typeof exitCode === 'number'`, which was dead code while `runCli`
    // always returned a number and became a silent drop the moment `exec` returned a promise:
    // the shipped binary would have kept exiting 0 with this whole suite green behind it. One
    // delegating call is the fix; this pins it, because the defect is duplication rather than
    // any particular line.
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'cli', 'main.ts'), 'utf8');
    const entry = /if \(require\.main === module\) \{([\s\S]*?)\n\}/.exec(source);

    expect(entry?.[1]).toBeDefined();
    expect(entry?.[1]).toMatch(/\bmain\(\)/);
    expect(entry?.[1]).not.toMatch(/process\.exitCode/);
  });
});
