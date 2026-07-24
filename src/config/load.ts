import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_CONFIG, isConfigFileShape } from './schema';
import type { ConfigFileShape, LoadConfigOptions, TokenDamperConfig } from './types';

/**
 * Loads and resolves the frozen configuration contract.
 */
export function loadConfig(options: LoadConfigOptions = {}): TokenDamperConfig {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const filePath = options.configPath ?? resolve(cwd, 'tokendamper.config.json');

  const fileConfig = loadConfigFile(filePath);

  return mergeConfig(DEFAULT_CONFIG, fileConfig, env, options.cliOverrides);
}

function loadConfigFile(filePath: string): ConfigFileShape | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }

  const raw = readFileSync(filePath, 'utf8');
  const parsed: unknown = JSON.parse(raw);

  if (!isConfigFileShape(parsed)) {
    throw new Error(`Invalid TokenDamper config file: ${filePath}`);
  }

  return parsed;
}

function mergeConfig(
  base: TokenDamperConfig,
  fileConfig: ConfigFileShape | undefined,
  env: NodeJS.ProcessEnv,
  cliOverrides: LoadConfigOptions['cliOverrides'],
): TokenDamperConfig {
  const configFromFile = applyFileConfig(base, fileConfig);
  const configFromEnv = applyEnvOverrides(configFromFile, env);
  return applyCliOverrides(configFromEnv, cliOverrides);
}

function applyFileConfig(base: TokenDamperConfig, fileConfig: ConfigFileShape | undefined): TokenDamperConfig {
  if (!fileConfig) {
    return base;
  }

  return {
    ...base,
    appName: fileConfig.app?.name ?? base.appName,
    appVersion: fileConfig.app?.version ?? base.appVersion,
    appMode: fileConfig.app?.mode ?? base.appMode,
    traceOutput: fileConfig.traceOutput ?? base.traceOutput,
    planner: {
      defaultMode: fileConfig.planner?.defaultMode ?? base.planner.defaultMode,
    },
    budget: {
      ...base.budget,
      ...fileConfig.budget,
    },
    validation: {
      minimumConfidence: fileConfig.validation?.minimumConfidence ?? base.validation.minimumConfidence,
    },
    logging: {
      level: fileConfig.logging?.level ?? base.logging.level,
    },
  };
}

function applyEnvOverrides(base: TokenDamperConfig, env: NodeJS.ProcessEnv): TokenDamperConfig {
  return {
    ...base,
    appMode: parseAppMode(env.TOKENDAMPER_APP_MODE) ?? base.appMode,
    traceOutput: parseTraceOutput(env.TOKENDAMPER_TRACE_OUTPUT) ?? base.traceOutput,
    planner: {
      defaultMode: parsePlannerMode(env.TOKENDAMPER_PLANNER_MODE) ?? base.planner.defaultMode,
    },
    validation: {
      minimumConfidence:
        parseNumber(env.TOKENDAMPER_MINIMUM_CONFIDENCE) ?? base.validation.minimumConfidence,
    },
    logging: {
      level: parseLogLevel(env.TOKENDAMPER_LOG_LEVEL) ?? base.logging.level,
    },
  };
}

function applyCliOverrides(base: TokenDamperConfig, cliOverrides: LoadConfigOptions['cliOverrides']): TokenDamperConfig {
  if (!cliOverrides) {
    return base;
  }

  return {
    ...base,
    appMode: cliOverrides.appMode ?? base.appMode,
    traceOutput: cliOverrides.traceOutput ?? base.traceOutput,
    planner: {
      defaultMode: cliOverrides.plannerMode ?? base.planner.defaultMode,
    },
    budget: {
      ...base.budget,
      ...cliOverrides.budget,
    },
    validation: {
      minimumConfidence: cliOverrides.minimumConfidence ?? base.validation.minimumConfidence,
    },
    logging: {
      level: cliOverrides.logLevel ?? base.logging.level,
    },
  };
}

function parseAppMode(value: string | undefined): TokenDamperConfig['appMode'] | undefined {
  return value === 'optimize' || value === 'explain' || value === 'bench' ? value : undefined;
}

function parsePlannerMode(value: string | undefined): TokenDamperConfig['planner']['defaultMode'] | undefined {
  return value === 'pass_through' ? value : undefined;
}

function parseTraceOutput(value: string | undefined): TokenDamperConfig['traceOutput'] | undefined {
  return value === 'stderr' || value === 'stdout' ? value : undefined;
}

function parseLogLevel(value: string | undefined): TokenDamperConfig['logging']['level'] | undefined {
  return value === 'silent' || value === 'error' || value === 'warn' || value === 'info' || value === 'debug'
    ? value
    : undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
