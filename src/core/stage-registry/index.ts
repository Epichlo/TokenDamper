import type { ContextBundle, OptimizationBudget, StageResult } from '../model/types';
import { runSessionDedupStage, type SessionDedupContext } from '../../stages/cleanup/session-dedup';
import { runConstraintPreservationStage } from '../../stages/cleanup/constraint-preservation';
import { runTopologyPrunerStage } from '../../stages/pruning/topology-pruner';
import { runTokenHashingStage, type TokenHashingStageOptions } from '../../stages/compression/token-hashing';
import { runDeltaCompressionStage, type DeltaCompressionOptions } from '../../stages/compression/delta-compression';
import { createStageResult } from '../model/constructors';

/**
 * The minimal built-in stage definition used by the registry.
 */
export interface BuiltInStageDefinition {
  readonly stageId: string;
  readonly version: string;
}

/**
 * Optional contextual parameters passed during stage execution.
 */
export interface CompressionStageContext {
  readonly sessionContext?: SessionDedupContext;
  readonly tokenHashingOptions?: TokenHashingStageOptions;
  readonly deltaOptions?: DeltaCompressionOptions;
}

/**
 * Returns the built-in stage catalog for Milestone 6.
 */
export function getBuiltInStageCatalog(): ReadonlyArray<BuiltInStageDefinition> {
  return Object.freeze([
    {
      stageId: 'cleanup:session-dedup',
      version: '0.1.0',
    },
    {
      stageId: 'cleanup:constraint-preservation',
      version: '0.1.0',
    },
    {
      stageId: 'pruning:topology-pruner',
      version: '0.1.0',
    },
    {
      stageId: 'compression:token-hashing',
      version: '0.1.0',
    },
    {
      stageId: 'compression:delta-compression',
      version: '0.1.0',
    },
  ]);
}

/**
 * Executes a built-in stage by stage ID.
 */
export function executeBuiltInStage(
  stageId: string,
  bundle: ContextBundle,
  budget: OptimizationBudget,
  sessionContext?: SessionDedupContext,
  compressionContext?: CompressionStageContext,
): StageResult {
  switch (stageId) {
    case 'cleanup:session-dedup':
      return runSessionDedupStage(bundle, budget, sessionContext ?? compressionContext?.sessionContext);
    case 'cleanup:constraint-preservation':
      return runConstraintPreservationStage(bundle, budget);
    case 'pruning:topology-pruner':
      return runTopologyPrunerStage(bundle, budget);
    case 'compression:token-hashing':
      return runTokenHashingStage(bundle, budget, compressionContext?.tokenHashingOptions);
    case 'compression:delta-compression':
      return runDeltaCompressionStage(bundle, budget, compressionContext?.deltaOptions);
    default:
      return createStageResult({
        stageId,
        status: 'skipped',
        bundle,
        changed: false,
        metrics: {},
        notes: `Unknown stage ID '${stageId}'.`,
      });
  }
}
