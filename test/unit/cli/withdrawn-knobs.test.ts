import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runCli, SUPPORTED_FLAGS } from '../../../src/cli/main';
import { loadConfig } from '../../../src/config/load';

/**
 * `--trace-output` and `--mode explain` are withdrawn — audit OX-H5.
 *
 * Both were parsed, validated, stored on `ResolvedConfig`, and read by **nothing**. The trace is
 * written with a literal `io.stderr.write(...)`, so `--trace-output stdout` reported success and
 * changed nothing; a caller redirecting to capture a trace in a pipe got stderr anyway and
 * concluded the tool had ignored them, which it had. Nothing branches on `appMode === 'explain'`
 * either — it stored a string.
 *
 * This is the defect audit H4 already removed three flags for (`--max-output-tokens`,
 * `--max-latency-ms`, `--risk-tolerance`, README "removed in 1.2.0"). These two survived that
 * sweep. Withdrawn on the same terms and for the same reason: **the surfaces go, the model fields
 * stay**, because `ARCHITECTURE.md` pins the model as frozen and a field awaiting an
 * implementation is not the same thing as a dial that reports success.
 *
 * The two halves that are *not* withdrawn are pinned here as well, because they are what makes
 * this a withdrawal rather than a deletion.
 */
describe('withdrawn dead knobs', () => {
  const io = () => {
    const err: string[] = [];
    const streams = {
      stdout: new PassThrough(),
      stderr: { write: (c: unknown) => { err.push(String(c)); return true; } } as never,
    };
    streams.stdout.resume();
    return { err, io: streams };
  };

  // A real file rather than `-`. Stdin blocks on `readFileSync(0)` in a test runner, and it
  // blocks precisely on the path where the flag is still *accepted* — so a stdin-based test
  // hangs instead of failing, which is the least useful way for a red test to be red.
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), 'tokendamper-withdrawn-'));
    writeFileSync(join(d, 'a.ts'), 'export const alpha = 1;\n', 'utf8');
    return d;
  };
  const input = (d: string) => join(d, 'a.ts');

  describe('--trace-output', () => {
    it('is no longer an accepted flag', () => {
      const { err, io: streams } = io();
      const cwd = dir();
      const code = runCli(['optimize', input(cwd), '--trace-output', 'stderr'], streams, cwd);

      expect(code).toBe(1);
      expect(err.join('')).toContain('--trace-output');
    });

    it('is absent from every command in the flag table', () => {
      for (const command of ['optimize', 'bench', 'mcp'] as const) {
        expect(SUPPORTED_FLAGS[command].has('--trace-output')).toBe(false);
      }
    });

    it('leaves an existing config file that still sets traceOutput loadable', () => {
      // Withdrawing a key must not turn a file that loaded yesterday into a hard error. The key
      // is no longer read or validated; an unrecognised key is ignored, as it always was.
      const cwd = dir();
      const configPath = join(cwd, 'tokendamper.config.json');
      writeFileSync(configPath, JSON.stringify({ traceOutput: 'stdout' }), 'utf8');

      expect(() => loadConfig({ cwd, configPath })).not.toThrow();
    });
  });

  describe('--mode explain', () => {
    it('rejects explain', () => {
      const { err, io: streams } = io();
      const cwd = dir();
      const code = runCli(['optimize', input(cwd), '--mode', 'explain'], streams, cwd);

      expect(code).toBe(1);
      expect(err.join('')).toContain('--mode');
    });

    it('rejects TOKENDAMPER_APP_MODE=explain rather than ignoring it', () => {
      // v1.6.0 established this direction for the `TOKENDAMPER_*` enums: an unrecognised value is
      // a hard error, and nothing that worked stops working, because the setting never took
      // effect in the first place.
      expect(() => loadConfig({ cwd: dir(), env: { TOKENDAMPER_APP_MODE: 'explain' } })).toThrow(
        /TOKENDAMPER_APP_MODE/,
      );
    });

    it('rejects app.mode: explain in a config file', () => {
      const cwd = dir();
      const configPath = join(cwd, 'tokendamper.config.json');
      writeFileSync(configPath, JSON.stringify({ app: { mode: 'explain' } }), 'utf8');

      expect(() => loadConfig({ cwd, configPath })).toThrow(/Invalid TokenDamper config file/);
    });
  });

  describe('what is deliberately kept', () => {
    it('keeps --mode bench, which is the half that does something', () => {
      // `--mode bench` sets `command = 'bench'`. That is a live effect, so `--mode` is withdrawn
      // by *value* rather than removed — the audit named `explain`, and only `explain`.
      //
      // Asserting the *parse*, not the run: `bench` shells out to `python` to evaluate fixture
      // code (audit OX-M15, still open), so whether it exits 0 depends on the machine. What this
      // pins is that `bench` is still an accepted value and still routes there.
      const { err, io: streams } = io();
      expect(SUPPORTED_FLAGS.optimize.has('--mode')).toBe(true);

      runCli(['--mode', 'bench', '--quiet'], streams, dir());
      expect(err.join('')).not.toContain('Invalid value for --mode');
    });

    it('still accepts --mode optimize', () => {
      const { err, io: streams } = io();
      const cwd = dir();
      runCli(['optimize', input(cwd), '--mode', 'optimize'], streams, cwd);

      expect(err.join('')).not.toContain('Invalid value for --mode');
    });

    it('keeps TOKENDAMPER_APP_MODE=bench and =optimize', () => {
      for (const mode of ['optimize', 'bench']) {
        expect(() => loadConfig({ cwd: dir(), env: { TOKENDAMPER_APP_MODE: mode } })).not.toThrow();
      }
    });
  });
});
