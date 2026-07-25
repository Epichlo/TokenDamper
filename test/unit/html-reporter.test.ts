import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateHtmlReport } from '../../src/cli/html-reporter';
import { loadConfig } from '../../src/config';
import { parse } from '../../src/adapters/cli';
import { optimize } from '../../src/core/engine';

describe('generateHtmlReport', () => {
  it('generates a self-contained HTML report with dark-mode CSS and gauges', () => {
    const rawInput = `
      # Architecture Specification
      TD_PRESERVE:CRITICAL_SPEC
      function initializeSystem() {
        console.log("system active");
      }
    `;

    const config = loadConfig();
    const request = parse(rawInput, config, { sourceKind: 'text' });
    const result = optimize(request);

    const html = generateHtmlReport(result, request.bundle, {
      title: 'Test Optimization Report',
    });

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Test Optimization Report');
    expect(html).toContain('Optimization Debt (D_k)');
    expect(html).toContain('Semantic Drift (S_k)');
    expect(html).toContain('<svg');
    expect(html).toContain('diff-table');
  });

  it('writes HTML report to disk when outputPath is specified', () => {
    const rawInput = 'const x = 42;';
    const config = loadConfig();
    const request = parse(rawInput, config, { sourceKind: 'text' });
    const result = optimize(request);

    const tmpPath = resolve(process.cwd(), 'test_output_report.html');
    if (existsSync(tmpPath)) {
      rmSync(tmpPath);
    }

    try {
      generateHtmlReport(result, request.bundle, { outputPath: tmpPath });
      expect(existsSync(tmpPath)).toBe(true);
    } finally {
      if (existsSync(tmpPath)) {
        rmSync(tmpPath);
      }
    }
  });
});
