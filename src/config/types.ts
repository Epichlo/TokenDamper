import type {
  AppMode,
  LogLevel,
  OptimizationBudget,
  OptimizationMode,
  ResolvedConfig,
  TraceOutput,
} from '../core/model';

/**
 * The serialized configuration shape accepted from disk.
 */
export interface ConfigFileShape {
  readonly configSchemaVersion?: string;
  readonly app?: {
    readonly name?: string;
    readonly version?: string;
    readonly mode?: AppMode;
  };
  readonly traceOutput?: TraceOutput;
  readonly planner?: {
    readonly defaultMode?: OptimizationMode;
  };
  readonly budget?: Partial<OptimizationBudget>;
  readonly validation?: {
    readonly minimumConfidence?: number;
  };
  readonly logging?: {
    readonly level?: LogLevel;
  };
}

/**
 * The supported CLI overrides for the frozen MVP configuration loader.
 */
export interface ConfigOverrides {
  appMode?: AppMode;
  traceOutput?: TraceOutput;
  plannerMode?: OptimizationMode;
  minimumConfidence?: number;
  logLevel?: LogLevel;
  budget?: Partial<OptimizationBudget>;
}

/**
 * The options accepted by the configuration loader.
 */
export interface LoadConfigOptions {
  readonly cwd?: string;
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cliOverrides?: Partial<ConfigOverrides>;
}

/**
 * The fully resolved configuration returned by the loader.
 */
export type TokenDamperConfig = ResolvedConfig & {
  readonly configSchemaVersion?: string;
};
