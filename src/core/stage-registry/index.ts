/**
 * The minimal built-in stage definition used by the frozen MVP registry.
 */
export interface BuiltInStageDefinition {
  readonly stageId: string;
  readonly version: string;
}

/**
 * Returns the built-in stage catalog for Milestone 1.
 */
export function getBuiltInStageCatalog(): ReadonlyArray<BuiltInStageDefinition> {
  return Object.freeze([]);
}
