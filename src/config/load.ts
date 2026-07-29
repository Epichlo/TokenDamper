import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createOptimizationBudget, freeze } from '../core/model/constructors';
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
  const configFromFile = applyFileConfig(DEFAULT_CONFIG, fileConfig);
  const configFromEnv = applyEnvOverrides(configFromFile, env);
  const configFromCli = applyCliOverrides(configFromEnv, options.cliOverrides);

  return freeze(configFromCli) as TokenDamperConfig;
}

function loadConfigFile(filePath: string): ConfigFileShape | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }

  const raw = readFileSync(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse TokenDamper config file at "${filePath}": ${msg}`);
  }

  if (!isConfigFileShape(parsed)) {
    throw new Error(`Invalid TokenDamper config file: ${filePath}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = parsed as any;
  if (!p.configSchemaVersion || p.configSchemaVersion === '1.0') {
    p.configSchemaVersion = '1.1';
    p.planner = p.planner || {};
    p.planner.defaultMode = p.planner.defaultMode ?? 'pass_through';
    p.budget = p.budget || {};
    p.budget.targetReductionRatio = p.budget.targetReductionRatio ?? 0;
    p.budget.riskTolerance = p.budget.riskTolerance ?? 'low';
    p.budget.preserveKinds = p.budget.preserveKinds ?? [];
    
    console.debug('[Config] Migrated configSchemaVersion from legacy to 1.1.');
  }

  return parsed as ConfigFileShape;
}

function applyFileConfig(base: TokenDamperConfig, fileConfig: ConfigFileShape | undefined): TokenDamperConfig {
  if (!fileConfig) {
    return base;
  }

  return freeze({
    ...base,
    configSchemaVersion: fileConfig.configSchemaVersion ?? base.configSchemaVersion,
    appName: fileConfig.app?.name ?? base.appName,
    appVersion: fileConfig.app?.version ?? base.appVersion,
    appMode: fileConfig.app?.mode ?? base.appMode,
    traceOutput: fileConfig.traceOutput ?? base.traceOutput,
    planner: {
      defaultMode: fileConfig.planner?.defaultMode ?? base.planner.defaultMode,
    },
    budget: mergeBudget(base.budget, fileConfig.budget),
    validation: {
      minimumConfidence: fileConfig.validation?.minimumConfidence ?? base.validation.minimumConfidence,
    },
    logging: {
      level: fileConfig.logging?.level ?? base.logging.level,
    },
  }) as TokenDamperConfig;
}

function applyEnvOverrides(base: TokenDamperConfig, env: NodeJS.ProcessEnv): TokenDamperConfig {
  return freeze({
    ...base,
    appMode: parseAppMode(env.TOKENDAMPER_APP_MODE) ?? base.appMode,
    traceOutput: parseTraceOutput(env.TOKENDAMPER_TRACE_OUTPUT) ?? base.traceOutput,
    planner: {
      defaultMode: parsePlannerMode(env.TOKENDAMPER_PLANNER_MODE) ?? base.planner.defaultMode,
    },
    budget: mergeBudget(base.budget, buildBudgetOverridesFromEnv(env)),
    validation: {
      minimumConfidence:
        parseNumber(env.TOKENDAMPER_MINIMUM_CONFIDENCE) ?? base.validation.minimumConfidence,
    },
    logging: {
      level: parseLogLevel(env.TOKENDAMPER_LOG_LEVEL) ?? base.logging.level,
    },
  }) as TokenDamperConfig;
}

function applyCliOverrides(
  base: TokenDamperConfig,
  cliOverrides: LoadConfigOptions['cliOverrides'],
): TokenDamperConfig {
  if (!cliOverrides) {
    return base;
  }

  return freeze({
    ...base,
    appMode: cliOverrides.appMode ?? base.appMode,
    traceOutput: cliOverrides.traceOutput ?? base.traceOutput,
    planner: {
      defaultMode: cliOverrides.plannerMode ?? base.planner.defaultMode,
    },
    budget: mergeBudget(base.budget, cliOverrides.budget),
    validation: {
      minimumConfidence: cliOverrides.minimumConfidence ?? base.validation.minimumConfidence,
    },
    logging: {
      level: cliOverrides.logLevel ?? base.logging.level,
    },
  }) as TokenDamperConfig;
}

function mergeBudget(
  base: TokenDamperConfig['budget'],
  override: Partial<TokenDamperConfig['budget']> | undefined,
): TokenDamperConfig['budget'] {
  if (!override) {
    return base;
  }

  return createOptimizationBudget({
    ...base,
    ...override,
    preserveKinds: override.preserveKinds ?? base.preserveKinds,
  });
}

function buildBudgetOverridesFromEnv(env: NodeJS.ProcessEnv): Partial<TokenDamperConfig['budget']> {
  const override: Record<string, unknown> = {};

  const maxInputTokens = parseNumber(env.TOKENDAMPER_MAX_INPUT_TOKENS);
  if (maxInputTokens !== undefined) {
    override.maxInputTokens = maxInputTokens;
  }

  const maxOutputTokens = parseNumber(env.TOKENDAMPER_MAX_OUTPUT_TOKENS);
  if (maxOutputTokens !== undefined) {
    override.maxOutputTokens = maxOutputTokens;
  }

  const targetReductionRatio = parseNumber(env.TOKENDAMPER_TARGET_REDUCTION_RATIO);
  if (targetReductionRatio !== undefined) {
    override.targetReductionRatio = targetReductionRatio;
  }

  const maxLatencyMs = parseNumber(env.TOKENDAMPER_MAX_LATENCY_MS);
  if (maxLatencyMs !== undefined) {
    override.maxLatencyMs = maxLatencyMs;
  }

  const riskTolerance = parseRiskTolerance(env.TOKENDAMPER_RISK_TOLERANCE);
  if (riskTolerance !== undefined) {
    override.riskTolerance = riskTolerance;
  }

  const preserveKinds = parsePreserveKinds(env.TOKENDAMPER_PRESERVE_KINDS);
  if (preserveKinds.length > 0) {
    override.preserveKinds = preserveKinds;
  }

  return override as Partial<TokenDamperConfig['budget']>;
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

function parsePreserveKinds(value: string | undefined): TokenDamperConfig['budget']['preserveKinds'] {
  if (!value) {
    return [];
  }

  const allowedKinds: TokenDamperConfig['budget']['preserveKinds'][number][] = [
    'prompt',
    'file',
    'diff',
    'conversation',
    'note',
  ];

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry): entry is TokenDamperConfig['budget']['preserveKinds'][number] =>
      allowedKinds.includes(entry as TokenDamperConfig['budget']['preserveKinds'][number]),
    );
}

function parseRiskTolerance(value: string | undefined): TokenDamperConfig['budget']['riskTolerance'] | undefined {
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }

  return undefined;
}
