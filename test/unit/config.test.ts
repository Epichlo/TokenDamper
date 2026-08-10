import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config';
import { TOKENDAMPER_VERSION } from '../../src/version';

describe('config loading', () => {
  it('loads defaults when no overrides exist', () => {
    const config = loadConfig({ cwd: mkdtempSync(join(tmpdir(), 'tokendamper-config-')) });

    expect(config.appName).toBe('TokenDamper');
    expect(config.appVersion).toBe(TOKENDAMPER_VERSION);
    expect(config.planner.defaultMode).toBe('pass_through');
    expect(config.validation.minimumConfidence).toBe(1);
  });

  it('merges file, environment, and CLI overrides in precedence order', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tokendamper-config-'));
    const configPath = join(cwd, 'tokendamper.config.json');

    writeFileSync(
      configPath,
      JSON.stringify({
        app: {
          name: 'FromFile',
          version: '9.9.9',
          mode: 'explain',
        },
        traceOutput: 'stdout',
        planner: {
          defaultMode: 'pass_through',
        },
        validation: {
          minimumConfidence: 0.5,
        },
        logging: {
          level: 'debug',
        },
      }),
      'utf8',
    );

    const config = loadConfig({
      cwd,
      configPath,
      env: {
        TOKENDAMPER_APP_MODE: 'bench',
        TOKENDAMPER_TRACE_OUTPUT: 'stderr',
        TOKENDAMPER_PLANNER_MODE: 'pass_through',
        TOKENDAMPER_MINIMUM_CONFIDENCE: '0.9',
        TOKENDAMPER_LOG_LEVEL: 'warn',
      },
      cliOverrides: {
        appMode: 'optimize',
        traceOutput: 'stderr',
        plannerMode: 'pass_through',
        minimumConfidence: 1,
        logLevel: 'info',
      },
    });

    expect(config.appName).toBe('FromFile');
    expect(config.appVersion).toBe('9.9.9');
    expect(config.appMode).toBe('optimize');
    expect(config.traceOutput).toBe('stderr');
    expect(config.validation.minimumConfidence).toBe(1);
    expect(config.logging.level).toBe('info');
  });

  it('resolves budget overrides from file, environment, and CLI', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tokendamper-budget-'));
    const configPath = join(cwd, 'tokendamper.config.json');

    writeFileSync(
      configPath,
      JSON.stringify({
        budget: {
          maxInputTokens: 500,
          riskTolerance: 'medium',
        },
      }),
      'utf8',
    );

    const config = loadConfig({
      cwd,
      configPath,
      env: {
        TOKENDAMPER_TARGET_REDUCTION_RATIO: '0.2',
        // Withdrawn by audit H4, and asserted below to have no effect. It set a budget field
        // that nothing in the pipeline reads, so offering it as an environment variable
        // advertised a control that did not exist.
        TOKENDAMPER_MAX_OUTPUT_TOKENS: '200',
        TOKENDAMPER_MAX_LATENCY_MS: '900',
        TOKENDAMPER_RISK_TOLERANCE: 'high',
      },
      cliOverrides: {
        budget: {
          maxInputTokens: 1000,
          preserveKinds: ['prompt', 'file'],
        },
      },
    });

    expect(config.budget.maxInputTokens).toBe(1000);
    expect(config.budget.targetReductionRatio).toBe(0.2);
    expect(config.budget.preserveKinds).toEqual(['prompt', 'file']);

    // The three withdrawn variables are ignored: the file's `riskTolerance: 'medium'` stands
    // rather than being overridden to 'high', and the two numeric fields stay unset.
    expect(config.budget.riskTolerance).toBe('medium');
    expect(config.budget.maxOutputTokens).toBeUndefined();
    expect(config.budget.maxLatencyMs).toBeUndefined();
  });

  it('throws a clear message on invalid JSON syntax in config file', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tokendamper-config-err-'));
    const configPath = join(cwd, 'tokendamper.config.json');

    writeFileSync(configPath, '{ invalid json }', 'utf8');

    expect(() => loadConfig({ cwd, configPath })).toThrow(/Failed to parse TokenDamper config file at ".*": /);
  });

  it('migrates legacy config to schema version 1.1', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tokendamper-legacy-'));
    const configPath = join(cwd, 'tokendamper.config.json');

    writeFileSync(
      configPath,
      JSON.stringify({
        app: {
          name: 'LegacyApp',
          version: '0.1.0',
        },
      }),
      'utf8',
    );

    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const config = loadConfig({ cwd, configPath });

    expect(config.configSchemaVersion).toBe('1.1');
    expect(config.appVersion).toBe('0.1.0');
    expect(config.appName).toBe('LegacyApp');
    expect(config.planner.defaultMode).toBe('pass_through');
    expect(config.budget.targetReductionRatio).toBe(0);
    expect(config.budget.riskTolerance).toBe('low');
    expect(debugSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it('rejects unsupported future config schema versions', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tokendamper-future-schema-'));
    const configPath = join(cwd, 'tokendamper.config.json');

    writeFileSync(
      configPath,
      JSON.stringify({
        configSchemaVersion: '2.0',
      }),
      'utf8',
    );

    expect(() => loadConfig({ cwd, configPath })).toThrow(/Invalid TokenDamper config file/);
  });
});
