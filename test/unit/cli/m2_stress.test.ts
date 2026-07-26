import { describe, it, expect, afterAll } from 'vitest';
import { runCli } from '../../../src/cli/main';
import { readFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

class MemoryStream {
  public content = '';
  write(chunk: string | Uint8Array): boolean {
    this.content += chunk.toString();
    return true;
  }
}

describe('Empirical Challenger M2 - CLI & JSON Exporter Stress Testing Suite', () => {
  const tempReportPath = resolve(process.cwd(), 'temp_test_report_m2.json');
  const tempCorruptFile = resolve(process.cwd(), 'temp_corrupt_dataset.json');

  afterAll(() => {
    if (existsSync(tempReportPath)) unlinkSync(tempReportPath);
    if (existsSync(tempCorruptFile)) unlinkSync(tempCorruptFile);
  });

  it('1. Default directory dataset execution and report schema validation', () => {
    const stdout = new MemoryStream();
    const stderr = new MemoryStream();

    if (existsSync(tempReportPath)) unlinkSync(tempReportPath);

    const exitCode = runCli(
      ['bench', 'test/fixtures/bench', '--report-json', tempReportPath],
      { stdout: stdout as never, stderr: stderr as never },
    );

    expect(exitCode).toBe(0);
    expect(stdout.content).toContain('TokenDamper Benchmark Execution Report');
    expect(existsSync(tempReportPath)).toBe(true);

    const rawJson = readFileSync(tempReportPath, 'utf8');
    const report = JSON.parse(rawJson);

    // Schema assertions for BenchmarkReport
    expect(typeof report.timestamp).toBe('string');
    expect(new Date(report.timestamp).toString()).not.toBe('Invalid Date');
    expect(typeof report.datasetName).toBe('string');
    expect(typeof report.totalFixtures).toBe('number');
    expect(report.totalFixtures).toBeGreaterThan(0);

    // Environment assertions
    expect(report.environment).toBeDefined();
    expect(typeof report.environment.nodeVersion).toBe('string');
    expect(typeof report.environment.platform).toBe('string');
    expect(typeof report.environment.tokendamperVersion).toBe('string');

    // overallSummary assertions
    expect(report.overallSummary).toBeDefined();
    expect(typeof report.overallSummary.totalFixtures).toBe('number');
    expect(typeof report.overallSummary.totalRuns).toBe('number');
    expect(typeof report.overallSummary.avgReductionRatio).toBe('number');
    expect(typeof report.overallSummary.fallbackRate).toBe('number');
    expect(typeof report.overallSummary.avgLatencyMs).toBe('number');
    expect(typeof report.overallSummary.p95LatencyMs).toBe('number');
    expect(typeof report.overallSummary.syntaxPassRate).toBe('number');
    expect(typeof report.overallSummary.totalValidationIssues).toBe('number');

    // sweepResults assertions
    expect(Array.isArray(report.sweepResults)).toBe(true);
    expect(report.sweepResults.length).toBeGreaterThan(0);
    const sweep = report.sweepResults[0];
    expect(typeof sweep.sweepId).toBe('string');
    expect(sweep.budget).toBeDefined();
    expect(sweep.summary).toBeDefined();
    expect(Array.isArray(sweep.itemResults)).toBe(true);

    // itemResults assertions
    const item = sweep.itemResults[0];
    expect(typeof item.fixtureId).toBe('string');
    expect(typeof item.sweepId).toBe('string');
    expect(typeof item.inputTokens).toBe('number');
    expect(typeof item.outputTokens).toBe('number');
    expect(typeof item.tokenReductionRatio).toBe('number');
    expect(typeof item.fallbackUsed).toBe('boolean');
    expect(typeof item.latencyMs).toBe('number');
    expect(typeof item.validationPassed).toBe('boolean');
    expect(Array.isArray(item.validationIssues)).toBe(true);
  });

  it('2. Custom dataset path execution (humaneval-subset.json)', () => {
    const stdout = new MemoryStream();
    const stderr = new MemoryStream();
    const customReportPath = resolve(process.cwd(), 'temp_humaneval_report.json');

    const exitCode = runCli(
      ['bench', 'test/fixtures/bench/humaneval-subset.json', '--report-json', customReportPath],
      { stdout: stdout as never, stderr: stderr as never },
    );

    expect(exitCode).toBe(0);
    expect(existsSync(customReportPath)).toBe(true);

    const report = JSON.parse(readFileSync(customReportPath, 'utf8'));
    expect(report.datasetName).toContain('humaneval');
    expect(report.totalFixtures).toBe(5);

    if (existsSync(customReportPath)) unlinkSync(customReportPath);
  });

  it('3. Custom dataset path execution (codexglue-subset.json)', () => {
    const stdout = new MemoryStream();
    const stderr = new MemoryStream();
    const customReportPath = resolve(process.cwd(), 'temp_codexglue_report.json');

    const exitCode = runCli(
      ['bench', 'test/fixtures/bench/codexglue-subset.json', '--report-json', customReportPath],
      { stdout: stdout as never, stderr: stderr as never },
    );

    expect(exitCode).toBe(0);
    expect(existsSync(customReportPath)).toBe(true);

    const report = JSON.parse(readFileSync(customReportPath, 'utf8'));
    expect(report.datasetName).toContain('codexglue');
    expect(report.totalFixtures).toBe(5);

    if (existsSync(customReportPath)) unlinkSync(customReportPath);
  });

  it('4. Invalid dataset path handling (non-existent file)', () => {
    const stdout = new MemoryStream();
    const stderr = new MemoryStream();

    const exitCode = runCli(
      ['bench', 'test/fixtures/bench/non_existent_dataset.json'],
      { stdout: stdout as never, stderr: stderr as never },
    );

    expect(exitCode).toBe(1);
    expect(stderr.content).toContain('Unknown benchmark dataset path or identifier');
  });

  it('5. Corrupt / invalid JSON dataset file handling', () => {
    const stdout = new MemoryStream();
    const stderr = new MemoryStream();

    writeFileSync(tempCorruptFile, 'INVALID_JSON_CONTENT{{{', 'utf8');

    const exitCode = runCli(
      ['bench', tempCorruptFile],
      { stdout: stdout as never, stderr: stderr as never },
    );

    expect(exitCode).toBe(1);
    expect(stderr.content.length).toBeGreaterThan(0);
  });

  it('6. --quiet flag suppresses terminal table output while preserving report-json export', () => {
    const stdout = new MemoryStream();
    const stderr = new MemoryStream();
    const quietReportPath = resolve(process.cwd(), 'temp_quiet_report.json');

    const exitCode = runCli(
      ['bench', 'test/fixtures/bench', '--quiet', '--report-json', quietReportPath],
      { stdout: stdout as never, stderr: stderr as never },
    );

    expect(exitCode).toBe(0);
    expect(stdout.content.trim()).toBe('');
    expect(existsSync(quietReportPath)).toBe(true);

    const report = JSON.parse(readFileSync(quietReportPath, 'utf8'));
    expect(report.totalFixtures).toBeGreaterThan(0);

    if (existsSync(quietReportPath)) unlinkSync(quietReportPath);
  });

  it('7. Budget override flags parsing & application in benchmark sweep', () => {
    const stdout = new MemoryStream();
    const stderr = new MemoryStream();
    const overrideReportPath = resolve(process.cwd(), 'temp_override_report.json');

    const exitCode = runCli(
      [
        'bench',
        'test/fixtures/bench',
        '--max-input-tokens', '800',
        '--target-reduction-ratio', '0.45',
        '--risk-tolerance', 'low',
        '--report-json', overrideReportPath,
      ],
      { stdout: stdout as never, stderr: stderr as never },
    );

    expect(exitCode).toBe(0);
    expect(existsSync(overrideReportPath)).toBe(true);

    const report = JSON.parse(readFileSync(overrideReportPath, 'utf8'));
    const budget = report.sweepResults[0].budget;

    expect(budget.maxInputTokens).toBe(800);
    expect(budget.targetReductionRatio).toBe(0.45);
    expect(budget.riskTolerance).toBe('low');

    if (existsSync(overrideReportPath)) unlinkSync(overrideReportPath);
  });

  it('8. Invalid budget override flags (risk tolerance, ratio range, non-integer tokens)', () => {
    // Bad risk tolerance
    {
      const stdout = new MemoryStream();
      const stderr = new MemoryStream();
      const exitCode = runCli(
        ['bench', 'test/fixtures/bench', '--risk-tolerance', 'ultra_high'],
        { stdout: stdout as never, stderr: stderr as never },
      );
      expect(exitCode).toBe(1);
      expect(stderr.content).toContain('Invalid value for --risk-tolerance.');
    }

    // Ratio > 1.0
    {
      const stdout = new MemoryStream();
      const stderr = new MemoryStream();
      const exitCode = runCli(
        ['bench', 'test/fixtures/bench', '--target-reduction-ratio', '1.5'],
        { stdout: stdout as never, stderr: stderr as never },
      );
      expect(exitCode).toBe(1);
      expect(stderr.content).toContain('Invalid value for --target-reduction-ratio.');
    }

    // Negative tokens
    {
      const stdout = new MemoryStream();
      const stderr = new MemoryStream();
      const exitCode = runCli(
        ['bench', 'test/fixtures/bench', '--max-input-tokens', '-50'],
        { stdout: stdout as never, stderr: stderr as never },
      );
      expect(exitCode).toBe(1);
      expect(stderr.content).toContain('Invalid value for --max-input-tokens.');
    }
  });

  it('9. Missing flag values error handling (--report-json without path)', () => {
    const stdout = new MemoryStream();
    const stderr = new MemoryStream();

    const exitCode = runCli(
      ['bench', 'test/fixtures/bench', '--report-json'],
      { stdout: stdout as never, stderr: stderr as never },
    );

    expect(exitCode).toBe(1);
    expect(stderr.content).toContain('Missing value for --report-json.');
  });
});
