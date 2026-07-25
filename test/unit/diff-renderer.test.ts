import { describe, expect, it } from 'vitest';
import { createContextBundle } from '../../src/core/model/constructors';
import { renderTerminalDiff } from '../../src/cli/diff-renderer';

describe('renderTerminalDiff', () => {
  it('renders unified diff banner and line diffs with color enabled', () => {
    const beforeText = 'line 1\nline 2\nTD_PRESERVE:KEEP_ME\nline 4';
    const afterText = 'line 1\n<BLOCK_HASH:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef>\nTD_PRESERVE:KEEP_ME\nline 4 added';

    const diff = renderTerminalDiff(beforeText, afterText, { color: true, mode: 'unified' });

    expect(diff).toContain('TokenDamper Optimization Visual Diff');
    expect(diff).toContain('BLOCK_HASH');
    expect(diff).toContain('✓ TD_PRESERVE:KEEP_ME');
  });

  it('renders plain text diff without ANSI codes when color is false', () => {
    const beforeText = 'function foo() {\n  return 1;\n}';
    const afterText = 'function foo() {\n  return 2;\n}';

    const diff = renderTerminalDiff(beforeText, afterText, { color: false, mode: 'unified' });

    expect(diff).not.toContain('\x1b[');
    expect(diff).toContain('-   return 1;');
    expect(diff).toContain('+   return 2;');
  });

  it('renders side-by-side diff mode', () => {
    const beforeText = 'hello world';
    const afterText = 'hello token damper world';

    const diff = renderTerminalDiff(beforeText, afterText, { color: false, mode: 'side-by-side' });

    expect(diff).toContain('BEFORE (Original)');
    expect(diff).toContain('AFTER (Optimized)');
    expect(diff).toContain('|');
  });

  it('accepts ContextBundle instances as before and after arguments', () => {
    const beforeBundle = createContextBundle('const x = 10;', 'text', 'test.ts');
    const afterBundle = createContextBundle('[TokenDamper Elided]', 'text', 'test.ts');

    const diff = renderTerminalDiff(beforeBundle, afterBundle, { color: false });

    expect(diff).toContain('- const x = 10;');
    expect(diff).toContain('+ [TokenDamper Elided]');
  });
});
