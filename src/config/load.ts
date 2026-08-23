import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createOptimizationBudget, freeze } from '../core/model/constructors';
import { CURRENT_CONFIG_SCHEMA_VERSION, DEFAULT_CONFIG, LEGACY_CONFIG_SCHEMA_VERSION, isConfigFileShape } from './schema';
import type { ConfigFileShape, LoadConfigOptions, TokenDamperConfig } from './types';

type MutableBudget = {
  -readonly [Key in keyof TokenDamperConfig['budget']]?: TokenDamperConfig['budget'][Key];
};

type MutableConfigFileShape = Omit<ConfigFileShape, 'budget' | 'configSchemaVersion' | 'planner'> & {
  configSchemaVersion?: string;
  planner?: {
    defaultMode?: TokenDamperConfig['planner']['defaultMode'];
  };
  budget?: MutableBudget;
};

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

  const p = parsed as MutableConfigFileShape;
  if (!p.configSchemaVersion || p.configSchemaVersion === LEGACY_CONFIG_SCHEMA_VERSION) {
    p.configSchemaVersion = CURRENT_CONFIG_SCHEMA_VERSION;
    p.planner = p.planner || {};
    p.planner.defaultMode = p.planner.defaultMode ?? 'pass_through';
    p.budget = p.budget || {};
    p.budget.targetReductionRatio = p.budget.targetReductionRatio ?? 0;
    p.budget.riskTolerance = p.budget.riskTolerance ?? 'low';
    p.budget.preserveKinds = p.budget.preserveKinds ?? [];
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
    planner: {
      defaultMode: fileConfig.planner?.defaultMode ?? base.planner.defaultMode,
    },
    budget: mergeBudget(base.budget, fileConfig.budget),
    validation: {
      minimumConfidence:
        assertConfidence('minimumConfidence in the config file', fileConfig.validation?.minimumConfidence) ??
        base.validation.minimumConfidence,
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
    planner: {
      defaultMode: parsePlannerMode(env.TOKENDAMPER_PLANNER_MODE) ?? base.planner.defaultMode,
    },
    budget: mergeBudget(base.budget, buildBudgetOverridesFromEnv(env)),
    validation: {
      minimumConfidence:
        parseConfidence('TOKENDAMPER_MINIMUM_CONFIDENCE', env.TOKENDAMPER_MINIMUM_CONFIDENCE) ??
        base.validation.minimumConfidence,
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
    planner: {
      defaultMode: cliOverrides.plannerMode ?? base.planner.defaultMode,
    },
    budget: mergeBudget(base.budget, cliOverrides.budget),
    validation: {
      minimumConfidence:
        assertConfidence('--minimum-confidence', cliOverrides.minimumConfidence) ?? base.validation.minimumConfidence,
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

/**
 * `TOKENDAMPER_MAX_OUTPUT_TOKENS`, `TOKENDAMPER_MAX_LATENCY_MS` and
 * `TOKENDAMPER_RISK_TOLERANCE` are gone from here alongside their command-line counterparts
 * (audit H4). All three set a budget field that no stage, validator or planner reads, so the
 * only thing they ever changed was the contents of the config object — and, for risk
 * tolerance, one column of the benchmark table.
 *
 * A config *file* may still carry the fields, because `OptimizationBudget` still declares them
 * and `ARCHITECTURE.md` is frozen. What is withdrawn is the claim, implicit in offering an
 * environment variable, that setting one does something.
 */
function buildBudgetOverridesFromEnv(env: NodeJS.ProcessEnv): Partial<TokenDamperConfig['budget']> {
  const override: Record<string, unknown> = {};

  const maxInputTokens = parseNumber(env.TOKENDAMPER_MAX_INPUT_TOKENS);
  if (maxInputTokens !== undefined) {
    override.maxInputTokens = maxInputTokens;
  }

  const targetReductionRatio = parseNumber(env.TOKENDAMPER_TARGET_REDUCTION_RATIO);
  if (targetReductionRatio !== undefined) {
    override.targetReductionRatio = targetReductionRatio;
  }

  const preserveKinds = parsePreserveKinds(env.TOKENDAMPER_PRESERVE_KINDS);
  if (preserveKinds.length > 0) {
    override.preserveKinds = preserveKinds;
  }

  return override as Partial<TokenDamperConfig['budget']>;
}

/**
 * Reads an enumerated environment variable, and **rejects** an unrecognized value rather than
 * dropping it — audit L1.
 *
 * Each of the four parsers below used to return `undefined` for anything off its list, which
 * `?? base.x` then turned into "the default, silently". `TOKENDAMPER_PLANNER_MODE=session_dedup`
 * is the case the audit names, and it is the worst shape of it: `session_dedup` is a real
 * member of `OptimizationMode`, so a user setting it has every reason to think it took effect.
 * The equivalent `--planner-mode` flag throws on the same input.
 *
 * That asymmetry is DECISIONS §30 with the sides swapped. §30 established that a flag the
 * command does not consume is a parse error naming where it *does* apply, on the reasoning that
 * a setting which reports success and changes nothing is worse than one that fails. An
 * environment variable is the same setting arriving by a different door.
 *
 * The accepted set is unchanged. Widening `defaultMode` past `pass_through` is a separate
 * question — `session_dedup` is pinned by the Gateway (invariant 8) and `topology_knapsack` is
 * budget-derived — and this fix deliberately does not answer it. It only stops the door from
 * swallowing the answer.
 */
function parseEnvEnum<T extends string>(
  variable: string,
  value: string | undefined,
  accepted: ReadonlyArray<T>,
): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  if ((accepted as ReadonlyArray<string>).includes(value)) {
    return value as T;
  }
  throw new Error(
    `Invalid value for ${variable}: ${JSON.stringify(value)}. Accepted values: ${accepted.join(', ')}.`,
  );
}

function parseAppMode(value: string | undefined): TokenDamperConfig['appMode'] | undefined {
  // `explain` withdrawn — audit OX-H5. Nothing branched on it, so an unrecognised value here
  // is a hard error by the rule v1.6.0 set for the `TOKENDAMPER_*` enums, and nothing that
  // worked stops working because the setting never took effect.
  return parseEnvEnum('TOKENDAMPER_APP_MODE', value, ['optimize', 'bench'] as const);
}

function parsePlannerMode(value: string | undefined): TokenDamperConfig['planner']['defaultMode'] | undefined {
  return parseEnvEnum('TOKENDAMPER_PLANNER_MODE', value, ['pass_through'] as const);
}

function parseLogLevel(value: string | undefined): TokenDamperConfig['logging']['level'] | undefined {
  return parseEnvEnum('TOKENDAMPER_LOG_LEVEL', value, [
    'silent',
    'error',
    'warn',
    'info',
    'debug',
  ] as const);
}

/**
 * `minimumConfidence` is a probability, so it lives in [0, 1] — audit OX-M10.
 *
 * It reached `TokenDamperConfig` through a bare finite-number check from all three doors. A value
 * above 1 is unreachable by any confidence the pipeline computes, so it forces a fallback on
 * **every** run — full output, 0% reduction, permanently, and with no diagnostic naming the
 * cause. Negative values are simply meaningless.
 *
 * The audit named only the environment variable. The CLI flag carried the identical check and the
 * config file was type-checked as `number`, so all three validate here — enumerate the doors, not
 * the one that got reported.
 *
 * Rejecting rather than clamping, in the message style v1.6.0 gave the `TOKENDAMPER_*` enums: a
 * setting that cannot do what it says is a mistake to report, not one to quietly reinterpret.
 */
function assertConfidence(source: string, value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `Invalid value for ${source}: ${JSON.stringify(value)}. Expected a confidence between 0 and 1 inclusive.`,
    );
  }
  return value;
}

function parseConfidence(variable: string, value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    // Unparseable input used to yield `undefined` and fall silently back to the default, which is
    // the shape v1.6.0 turned into a hard error for the enums.
    throw new Error(
      `Invalid value for ${variable}: ${JSON.stringify(value)}. Expected a confidence between 0 and 1 inclusive.`,
    );
  }
  return assertConfidence(variable, parsed);
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

