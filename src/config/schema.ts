import { createOptimizationBudget, freeze } from '../core/model/constructors';
import type { ConfigFileShape, TokenDamperConfig } from './types';
import { TOKENDAMPER_VERSION } from '../version';

export const CURRENT_CONFIG_SCHEMA_VERSION = '1.1';
export const LEGACY_CONFIG_SCHEMA_VERSION = '1.0';

/**
 * The default resolved configuration used when no overrides are present.
 */
export const DEFAULT_CONFIG: TokenDamperConfig = {
  configSchemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
  appName: 'TokenDamper',
  appVersion: TOKENDAMPER_VERSION,
  appMode: 'optimize',
  traceOutput: 'stderr',
  planner: {
    defaultMode: 'pass_through',
  },
  budget: createOptimizationBudget({
    targetReductionRatio: 0,
    riskTolerance: 'low',
    preserveKinds: [],
  }),
  validation: {
    minimumConfidence: 1,
  },
  logging: {
    level: 'info',
  },
} as const;

freeze(DEFAULT_CONFIG);

/**
 * Returns true when the provided value looks like a config file shape.
 */
export function isConfigFileShape(value: unknown): value is ConfigFileShape {
  if (!isPlainObject(value)) {
    return false;
  }

  const file = value as ConfigFileShape;
  return (
    (file.configSchemaVersion === undefined ||
      file.configSchemaVersion === LEGACY_CONFIG_SCHEMA_VERSION ||
      file.configSchemaVersion === CURRENT_CONFIG_SCHEMA_VERSION) &&
    (file.app === undefined ||
      (isPlainObject(file.app) &&
        (file.app.name === undefined || typeof file.app.name === 'string') &&
        (file.app.version === undefined || typeof file.app.version === 'string') &&
        (file.app.mode === undefined || isAppMode(file.app.mode)))) &&
    (file.traceOutput === undefined || isTraceOutput(file.traceOutput)) &&
    (file.planner === undefined ||
      (isPlainObject(file.planner) &&
        (file.planner.defaultMode === undefined || isOptimizationMode(file.planner.defaultMode)))) &&
    (file.budget === undefined || isBudgetShape(file.budget)) &&
    (file.validation === undefined ||
      (isPlainObject(file.validation) &&
        (file.validation.minimumConfidence === undefined ||
          typeof file.validation.minimumConfidence === 'number'))) &&
    (file.logging === undefined ||
      (isPlainObject(file.logging) &&
        (file.logging.level === undefined || isLogLevel(file.logging.level))))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBudgetShape(value: unknown): boolean {
  if (!isPlainObject(value)) {
    return false;
  }

  return (
    (value.maxInputTokens === undefined || typeof value.maxInputTokens === 'number') &&
    (value.maxOutputTokens === undefined || typeof value.maxOutputTokens === 'number') &&
    (value.targetReductionRatio === undefined || typeof value.targetReductionRatio === 'number') &&
    (value.maxLatencyMs === undefined || typeof value.maxLatencyMs === 'number') &&
    (value.riskTolerance === undefined ||
      value.riskTolerance === 'low' ||
      value.riskTolerance === 'medium' ||
      value.riskTolerance === 'high') &&
    (value.preserveKinds === undefined ||
      (Array.isArray(value.preserveKinds) &&
        value.preserveKinds.every((kind) => typeof kind === 'string')))
  );
}

function isAppMode(value: unknown): value is TokenDamperConfig['appMode'] {
  return value === 'optimize' || value === 'explain' || value === 'bench';
}

function isOptimizationMode(value: unknown): boolean {
  return value === 'pass_through';
}

function isTraceOutput(value: unknown): boolean {
  return value === 'stderr' || value === 'stdout';
}

function isLogLevel(value: unknown): boolean {
  return value === 'silent' || value === 'error' || value === 'warn' || value === 'info' || value === 'debug';
}
