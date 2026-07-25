import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';

describe('config loading', () => {
  it('loads defaults when no overrides exist', () => {
    const config = loadConfig({ cwd: mkdtempSync(join(tmpdir(), 'tokendamper-config-')) });

    expect(config.appName).toBe('TokenDamper');
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
        TOKENDAMPER_MAX_OUTPUT_TOKENS: '200',
        TOKENDAMPER_TARGET_REDUCTION_RATIO: '0.2',
      },
      cliOverrides: {
        budget: {
          maxInputTokens: 1000,
          preserveKinds: ['prompt', 'file'],
        },
      },
    });

    expect(config.budget.maxInputTokens).toBe(1000);
    expect(config.budget.maxOutputTokens).toBe(200);
    expect(config.budget.targetReductionRatio).toBe(0.2);
    expect(config.budget.riskTolerance).toBe('medium');
    expect(config.budget.preserveKinds).toEqual(['prompt', 'file']);
  });
});
