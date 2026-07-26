/**
 * Supported target dataset identifiers.
 */
export type BenchmarkDatasetKind = 'humaneval' | 'codexglue';

/**
 * Raw HumanEval fixture structure as stored in JSON files.
 */
export interface HumanEvalFixtureRaw {
  readonly task_id: string;
  readonly prompt: string;
  readonly canonical_solution: string;
  readonly entry_point: string;
  readonly test: string;
  readonly language?: 'python';
}

/**
 * Raw CodeXGLUE fixture structure as stored in JSON files.
 */
export interface CodeXGLUEFixtureRaw {
  readonly id: string;
  readonly repo: string;
  readonly path: string;
  readonly prompt: string;
  readonly completion: string;
  readonly language: 'python' | 'typescript' | 'javascript';
}

/**
 * Unified, normalized benchmark fixture model used throughout the benchmark harness.
 */
export interface BenchmarkFixture {
  readonly id: string;
  readonly dataset: BenchmarkDatasetKind;
  readonly prompt: string;
  readonly referenceCompletion: string;
  readonly language: 'python' | 'typescript' | 'javascript';
  readonly path: string;
  readonly entryPoint?: string;
  readonly testCode?: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * Collection of loaded benchmark fixtures.
 */
export interface BenchmarkFixtureSet {
  readonly datasetName: string;
  readonly fixtures: ReadonlyArray<BenchmarkFixture>;
  readonly count: number;
}
