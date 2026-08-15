import { describe, expect, it } from 'vitest';
import { selectElisionRegions } from '../../src/core/elision';
import { createContextItem } from '../../src/core/model/constructors';
import { loadConfig } from '../../src/config/load';
import { TypeScriptValidator } from '../../src/core/validation/ast/ts-validator';

/**
 * The `max_audit.md` LOW table, which entered no wave and was therefore never scheduled.
 *
 * That is the same failure mode the project named for M7 in `docs/audit-remediation-status.md`
 * §6 — an item in no table reads as done, exactly like a check that never ran reads as a pass —
 * and it happened again one severity band down. L2 and L3 were closed incidentally by the C2
 * Buffer work; the rest were open when this file was written.
 *
 * Each case below was run against the unfixed engine first. L7 and L1 fail there; L8's
 * assertion fails there too. L4, L5 and L9 are recorded at their sites rather than changed,
 * with the reasoning in `DECISIONS.md`, so they are deliberately not pinned here.
 */
describe('audit LOW findings', () => {
  describe('L7 — a blank first body line loses the whole region', () => {
    const body = Array.from({ length: 14 }, (_, i) => `    step_${i} = compute(x, ${i})`).join('\n');

    const pythonItem = (content: string) =>
      createContextItem({
        id: 'py',
        kind: 'file',
        contentType: 'code',
        content,
        path: 'a.py',
        language: 'python',
      });

    it('starts the region at the first non-blank body line, not at `def` + 1', () => {
      const src = `def alpha(x):\n\n${body}\n    return step_0\n`;
      const regions = selectElisionRegions(pythonItem(src));

      expect(regions).toHaveLength(1);

      // The pre-fix engine read the indent off the blank line, got 0, and began the region at
      // column 0 — so the region text started with a newline and the marker inherited column 0.
      const text = src.slice(regions[0]!.start, regions[0]!.end);
      expect(text.startsWith('step_0')).toBe(true);
    });

    it('picks the same body text with or without the blank line', () => {
      const withBlank = `def alpha(x):\n\n${body}\n    return step_0\n`;
      const without = `def alpha(x):\n${body}\n    return step_0\n`;

      const a = selectElisionRegions(pythonItem(withBlank));
      const b = selectElisionRegions(pythonItem(without));

      expect(withBlank.slice(a[0]!.start, a[0]!.end)).toBe(without.slice(b[0]!.start, b[0]!.end));
    });

    it('still starts at the body indent when the blank line is absent', () => {
      const src = `def alpha(x):\n${body}\n    return step_0\n`;
      const regions = selectElisionRegions(pythonItem(src));

      expect(src.slice(regions[0]!.start, regions[0]!.end).startsWith('step_0')).toBe(true);
    });
  });

  describe('L1 — an unrecognized environment value is rejected, not dropped', () => {
    it('rejects TOKENDAMPER_PLANNER_MODE=session_dedup instead of silently defaulting', () => {
      // The audit's own case, and the worst shape of it: `session_dedup` is a real member of
      // `OptimizationMode`, so a user setting it has every reason to think it took effect. The
      // equivalent `--planner-mode` flag has always thrown on the same input.
      expect(() => loadConfig({ env: { TOKENDAMPER_PLANNER_MODE: 'session_dedup' } })).toThrow(
        /TOKENDAMPER_PLANNER_MODE/,
      );
    });

    it('names the accepted values in the error', () => {
      expect(() => loadConfig({ env: { TOKENDAMPER_LOG_LEVEL: 'verbose' } })).toThrow(/silent, error, warn, info, debug/);
    });

    it('still accepts every documented value, and an unset variable', () => {
      expect(() => loadConfig({ env: {} })).not.toThrow();
      expect(loadConfig({ env: { TOKENDAMPER_PLANNER_MODE: 'pass_through' } }).planner.defaultMode).toBe(
        'pass_through',
      );
      expect(loadConfig({ env: { TOKENDAMPER_LOG_LEVEL: 'debug' } }).logging.level).toBe('debug');
      expect(loadConfig({ env: { TOKENDAMPER_TRACE_OUTPUT: 'stdout' } }).traceOutput).toBe('stdout');
      expect(loadConfig({ env: { TOKENDAMPER_APP_MODE: 'bench' } }).appMode).toBe('bench');
    });
  });

  describe('L8 — an escaped newline still ends a line', () => {
    it('reports the true line number after a string line continuation', () => {
      // Line 1 opens a string and continues it over the newline; the unbalanced `(` on line 4 is
      // what the validator reports. Pre-fix, `i += 2` skipped the newline without counting it
      // and every position after it read one line short.
      const src = ['const a = "one\\', 'two";', 'const b = 1;', 'function f( {'].join('\n');
      const result = new TypeScriptValidator().validate(src);

      expect(result.valid).toBe(false);
      expect(result.issues[0]?.line).toBe(4);
    });
  });
});
