import { describe, expect, it } from 'vitest';
import { createMcpServer, MCP_PROTOCOL_VERSION, startMcpServer } from '../../src/index';

describe('Public Exports', () => {
  it('exports MCP adapter functions', () => {
    expect(typeof createMcpServer).toBe('function');
    expect(typeof startMcpServer).toBe('function');
    expect(MCP_PROTOCOL_VERSION).toBe('2024-11-05');
  });
});
