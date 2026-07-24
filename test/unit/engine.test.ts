import { describe, expect, it } from 'vitest';
import { parse } from '../../src/adapters/cli';
import { optimize } from '../../src/core/engine';
import { loadConfig } from '../../src/config';

describe('engine', () => {
  it('runs the no-op pipeline end to end', () => {
    const config = loadConfig();
    const request = parse('Hello, TokenDamper.\n', config);
    const result = optimize(request);

    expect(result.emittedOutput).toBe('Hello, TokenDamper.\n');
    expect(result.fallbackUsed).toBe(false);
    expect(result.validation.passed).toBe(true);
    expect(result.trace.requestId).toBe(request.requestId);
    expect(result.trace.planMode).toBe('pass_through');
    expect(result.trace.stageCount).toBe(0);
    expect(result.trace.fallbackUsed).toBe(false);
  });
});
