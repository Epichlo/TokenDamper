import { describe, expect, it } from 'vitest';
import { parse } from '../../src/adapters/cli';
import { loadConfig } from '../../src/config';

describe('CLI adapter parsing', () => {
  it('parses direct text input into OptimizationRequest', () => {
    const config = loadConfig();
    const request = parse('Hello direct text', config, { sourceKind: 'text' });

    expect(request.adapterName).toBe('cli');
    expect(request.bundle.source).toBe('text');
    expect(request.bundle.items).toHaveLength(1);
    expect(request.bundle.items[0]!.content).toBe('Hello direct text');
    expect(request.bundle.items[0]!.contentType).toBe('text');
  });

  it('parses stdin input into OptimizationRequest', () => {
    const config = loadConfig();
    const request = parse('stdin content', config, { sourceKind: 'stdin' });

    expect(request.bundle.source).toBe('stdin');
    expect(request.bundle.items[0]!.origin).toBe('stdin');
  });

  it('parses file input into OptimizationRequest', () => {
    const config = loadConfig();
    const request = parse('file content', config, { sourceKind: 'file', sourcePath: '/path/to/file.txt' });

    expect(request.bundle.source).toBe('file');
    expect(request.bundle.items[0]!.path).toBe('/path/to/file.txt');
    expect(request.bundle.items[0]!.kind).toBe('file');
  });
});
