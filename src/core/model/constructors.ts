import { createHash } from 'node:crypto';
import type {
  BundleStatistics,
  ContextBundle,
  ContextItem,
  ContextItemKind,
  ContextSource,
  ContentType,
  OptimizationBudget,
  OptimizationPlan,
  OptimizationRequest,
  OptimizationResult,
  OptimizationTrace,
  ResolvedConfig,
  StageResult,
  ValidationReport,
} from './types';
import {
  DEFAULT_TOKENIZER,
  estimateBundleTokens,
  estimateTokens,
  type TokenizerAdapter,
} from '../hashing/tokenizer';

/**
 * The normalized source kind used when parsing CLI input.
 */
export type NormalizedInputSource = 'text' | 'stdin' | 'file';

/**
 * The options used to create a normalized optimization request.
 */
export interface CreateRequestOptions {
  readonly requestId: string;
  readonly adapterName: string;
  readonly adapterVersion: string;
  readonly source: NormalizedInputSource;
  readonly sourcePath?: string;
  /**
   * A language declared by the caller. See `createContextBundle` — this is a declaration,
   * not a probe, and it outranks both the filename extension and the content heuristics.
   */
  readonly language?: string;
}

/**
 * Creates an immutable optimization request from raw adapter input.
 */
export function createOptimizationRequest(
  rawInput: string,
  config: ResolvedConfig,
  options: CreateRequestOptions,
  tokenizer: TokenizerAdapter = DEFAULT_TOKENIZER,
): OptimizationRequest {
  const bundle = createContextBundle(
    rawInput,
    options.source,
    options.sourcePath,
    tokenizer,
    options.language,
  );

  return freeze({
    requestId: options.requestId,
    rawInput,
    bundle,
    budget: createOptimizationBudget(config.budget),
    config,
    adapterName: options.adapterName,
    adapterVersion: options.adapterVersion,
  });
}

/**
 * Creates an immutable normalized context bundle from raw adapter input.
 *
 * `declaredLanguage` is the caller saying what this content *is*. Two of the three entry
 * modes are pathless by construction — `optimize -` has no filename, and an MCP
 * `optimize_context` call is a string in a JSON-RPC frame — so without a declaration the
 * only signal left is the content probe, and §17 removed content-only code detection on
 * purpose. See `docs/phase-4b-pathless-code-scope.md`.
 *
 * **It sets `language` and `contentType` together, never one without the other.** Setting
 * only `language` leaves `contentType` at whatever the probe guessed — `text` for most
 * pathless code — and `text` is in `DriftTracker`'s `MARKDOWN_MARKER_TYPES`, so a declared
 * Python file would still have its `#` comments harvested as markdown headings and then
 * "destroyed" by the elision that follows. Setting only `contentType: 'code'` is worse:
 * `CONTENT_TYPE_VALIDATORS.code` maps to the **TypeScript** validator, so declared Python
 * would be checked by the wrong checker. The two fields answer to different consumers and
 * have to agree.
 *
 * **Precedence: declaration > extension > probe.** A `--language` flag is a per-invocation
 * statement by whoever is running the tool; an extension is a statement by whoever named the
 * file, which may be neither the same person nor still true of a piped fragment. §22
 * established that a declaration outranks a probe; this is the same rule one step further.
 */
export function createContextBundle(
  rawInput: string,
  source: NormalizedInputSource,
  sourcePath?: string,
  tokenizer: TokenizerAdapter = DEFAULT_TOKENIZER,
  declaredLanguage?: string,
): ContextBundle {
  const language = normalizeLanguage(declaredLanguage);
  const contentType =
    (language ? contentTypeForLanguage(language) : undefined) ??
    classifyContent(rawInput, source, sourcePath);
  const kind: ContextItemKind = source === 'file' ? 'file' : 'prompt';
  const metadata: Readonly<Record<string, string | number | boolean | null>> = freeze({
    source,
    ...(sourcePath ? { sourcePath } : {}),
  });
  const contentHash = hashContent({
    source,
    sourcePath: sourcePath ?? null,
    content: rawInput,
    kind,
    contentType,
    metadata,
    // Spread, not `language: language ?? null`: an undeclared item must hash exactly as it
    // did before this parameter existed, or every pinned id in the suite moves for nothing.
    ...(language ? { language } : {}),
  });
  const item = createContextItem({
    id: contentHash,
    kind,
    contentType,
    content: rawInput,
    origin: sourcePath ?? source,
    contentHash,
    ...(sourcePath ? { path: sourcePath } : {}),
    ...(language ? { language } : {}),
    metadata,
  });
  const items = freeze([item]);
  const statistics = createBundleStatistics(items);
  const bundleHash = hashContent({
    source,
    sourcePath: sourcePath ?? null,
    items: items.map((entry) => entry.contentHash),
    statistics,
  });
  const preview = rawInput.slice(0, 80);

  return freeze({
    id: bundleHash,
    bundleId: bundleHash,
    source,
    items,
    summary: {
      itemCount: items.length,
      tokenEstimate: estimateTokens(rawInput, tokenizer),
      preview,
    },
    statistics,
    contentHash: bundleHash,
  });
}

/**
 * Creates an immutable normalized context bundle from an array of context items.
 */
export function createBundleFromItems(
  items: ReadonlyArray<ContextItem>,
  source: ContextSource = 'text',
  tokenizer: TokenizerAdapter = DEFAULT_TOKENIZER,
): ContextBundle {
  const statistics = createBundleStatistics(items);
  const bundleHash = hashContent({
    source,
    items: items.map((entry) => entry.contentHash),
    statistics,
  });
  const rawCombined = items.map((i) => i.content).join('\n');
  const tokenEstimate = estimateBundleTokens(items, tokenizer);

  return freeze({
    id: bundleHash,
    bundleId: bundleHash,
    source,
    items: freeze(items),
    summary: freeze({
      itemCount: items.length,
      tokenEstimate,
      preview: rawCombined.slice(0, 80),
    }),
    statistics,
    contentHash: bundleHash,
  });
}


/**
 * Normalizes a budget into a frozen immutable value.
 */
export function createOptimizationBudget(input: Partial<OptimizationBudget> | undefined): OptimizationBudget {
  const rawBudget: Record<string, unknown> = {
    riskTolerance: input?.riskTolerance ?? 'low',
    preserveKinds: input?.preserveKinds ?? [],
  };

  if (input?.maxInputTokens !== undefined) {
    rawBudget.maxInputTokens = input.maxInputTokens;
  }
  if (input?.maxOutputTokens !== undefined) {
    rawBudget.maxOutputTokens = input.maxOutputTokens;
  }
  if (input?.targetReductionRatio !== undefined) {
    rawBudget.targetReductionRatio = input.targetReductionRatio;
  }
  if (input?.maxLatencyMs !== undefined) {
    rawBudget.maxLatencyMs = input.maxLatencyMs;
  }

  const normalized = validateBudget(rawBudget as unknown as OptimizationBudget);

  const result: Record<string, unknown> = {
    riskTolerance: normalized.riskTolerance,
    preserveKinds: freeze([...normalized.preserveKinds]),
  };

  if (normalized.maxInputTokens !== undefined) {
    result.maxInputTokens = normalized.maxInputTokens;
  }
  if (normalized.maxOutputTokens !== undefined) {
    result.maxOutputTokens = normalized.maxOutputTokens;
  }
  if (normalized.targetReductionRatio !== undefined) {
    result.targetReductionRatio = normalized.targetReductionRatio;
  }
  if (normalized.maxLatencyMs !== undefined) {
    result.maxLatencyMs = normalized.maxLatencyMs;
  }

  return freeze(result as unknown as OptimizationBudget);
}

/**
 * Merges multiple partial budget sources into a normalized immutable budget.
 */
export function mergeOptimizationBudget(
  base: Partial<OptimizationBudget> | undefined,
  ...overrides: Array<Partial<OptimizationBudget> | undefined>
): OptimizationBudget {
  const merged: Partial<OptimizationBudget> = {
    ...base,
  };

  for (const override of overrides) {
    if (!override) {
      continue;
    }

    Object.assign(merged, override);
  }

  return createOptimizationBudget(merged);
}

/**
 * Creates an immutable context item.
 */
export function createContextItem(input: {
  readonly id: string;
  readonly kind: ContextItemKind;
  readonly contentType?: ContentType;
  readonly content: string;
  readonly origin?: string;
  readonly contentHash?: string;
  readonly role?: string;
  readonly path?: string;
  readonly language?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}): ContextItem {
  const contentType = input.contentType ?? 'text';
  const origin = input.origin ?? input.path ?? 'cli';
  const metadata = input.metadata ?? freeze({});
  const contentHash = input.contentHash ?? hashContent(input.content);

  return freeze({
    id: input.id,
    itemId: input.id,
    kind: input.kind,
    contentType,
    content: input.content,
    origin,
    contentHash,
    ...(input.role ? { role: input.role } : {}),
    ...(input.path ? { path: input.path } : {}),
    ...(input.language ? { language: input.language } : {}),
    metadata,
  });
}

/**
 * Creates normalized bundle statistics.
 */
export function createBundleStatistics(items: ReadonlyArray<ContextItem>): BundleStatistics {
  const contentTypeCounts: Record<ContentType, number> = {
    text: 0,
    markdown: 0,
    code: 0,
    html: 0,
    json: 0,
    yaml: 0,
    logs: 0,
    unknown: 0,
  };

  const kindCounts: Record<ContextItemKind, number> = {
    prompt: 0,
    file: 0,
    diff: 0,
    conversation: 0,
    note: 0,
  };

  let totalCharacters = 0;

  for (const item of items) {
    contentTypeCounts[item.contentType] += 1;
    kindCounts[item.kind] += 1;
    totalCharacters += item.content.length;
  }

  return freeze({
    itemCount: items.length,
    contentTypeCounts: freeze(contentTypeCounts),
    kindCounts: freeze(kindCounts),
    totalCharacters,
  });
}

/**
 * Creates an immutable optimization plan.
 */
export function createOptimizationPlan(plan: OptimizationPlan): OptimizationPlan {
  return freeze({
    planId: plan.planId,
    mode: plan.mode,
    stageIds: freeze([...plan.stageIds]),
    revalidationPoints: freeze([...plan.revalidationPoints]),
    fallbackPolicy: plan.fallbackPolicy,
    ...(plan.expectedSavings === undefined ? {} : { expectedSavings: plan.expectedSavings }),
  });
}

/**
 * Creates an immutable stage result.
 */
export function createStageResult(result: StageResult): StageResult {
  return freeze({
    stageId: result.stageId,
    status: result.status,
    bundle: result.bundle,
    changed: result.changed,
    metrics: freeze({ ...result.metrics }),
    ...(result.notes === undefined ? {} : { notes: result.notes }),
  });
}

/**
 * Creates an immutable validation report.
 */
export function createValidationReport(report: ValidationReport): ValidationReport {
  return freeze({
    passed: report.passed,
    confidence: report.confidence,
    issues: freeze(report.issues.map((issue) => freeze({ ...issue }))),
    shouldFallback: report.shouldFallback,
    ...(report.reason === undefined ? {} : { reason: report.reason }),
    ...(report.driftReport === undefined ? {} : { driftReport: report.driftReport }),
    ...(report.astCoverage === undefined ? {} : { astCoverage: report.astCoverage }),
    ...(report.driftCoverage === undefined ? {} : { driftCoverage: report.driftCoverage }),
  });
}

/**
 * Creates an immutable optimization trace.
 */
export function createOptimizationTrace(trace: OptimizationTrace): OptimizationTrace {
  return freeze({
    requestId: trace.requestId,
    bundleId: trace.bundleId,
    bundleContentHash: trace.bundleContentHash,
    planMode: trace.planMode,
    stageCount: trace.stageCount,
    stageTraces: freeze(trace.stageTraces.map((entry) => freeze({ ...entry }))),
    inputTokenEstimate: trace.inputTokenEstimate,
    outputTokenEstimate: trace.outputTokenEstimate,
    tokenBefore: trace.tokenBefore,
    tokenAfter: trace.tokenAfter,
    bundleStatistics: trace.bundleStatistics,
    fallbackUsed: trace.fallbackUsed,
    ...(trace.fallbackReason === undefined ? {} : { fallbackReason: trace.fallbackReason }),
    ...(trace.debtScore === undefined ? {} : { debtScore: trace.debtScore }),
    ...(trace.driftScore === undefined ? {} : { driftScore: trace.driftScore }),
    ...(trace.astCoverage === undefined ? {} : { astCoverage: trace.astCoverage }),
    ...(trace.driftCoverage === undefined ? {} : { driftCoverage: trace.driftCoverage }),
  });
}

/**
 * Creates an immutable optimization result.
 */
export function createOptimizationResult(result: OptimizationResult): OptimizationResult {
  return freeze({
    finalBundle: result.finalBundle,
    emittedOutput: result.emittedOutput,
    validation: result.validation,
    trace: result.trace,
    fallbackUsed: result.fallbackUsed,
  });
}

/**
 * Freezes a value shallowly after recursively freezing arrays and plain objects.
 */
export function freeze<T>(value: T): Readonly<T> {
  if (Array.isArray(value)) {
    for (const entry of value) {
      freeze(entry);
    }
    return Object.freeze(value) as Readonly<T>;
  }

  if (isPlainObject(value)) {
    for (const nested of Object.values(value)) {
      freeze(nested);
    }
    return Object.freeze(value) as Readonly<T>;
  }

  return value as Readonly<T>;
}

/**
 * Classifies raw content deterministically.
 *
 * **Extension first, content probes second.** The two used to be interleaved, with each
 * probe tried before the extension it competed with and `isCodeExtension` consulted fifth,
 * after json/yaml/html/logs. Measured on this repository, that ordering classified 46 of its
 * 57 TypeScript sources as `html` and every markdown document as `html` or `yaml` — because
 * a probe that fires early wins over an extension that would have decided correctly.
 *
 * A filename extension is a declaration by whoever named the file; a probe is a guess about
 * bytes. When both are available the declaration wins. Probes run only when the extension is
 * absent or unrecognized, which is the Gateway/MCP case: a provider message has no filename.
 *
 * See `test/unit/content-classification.test.ts`, which pins this against the repository's
 * own sources rather than synthetic strings.
 */
export function classifyContent(
  rawInput: string,
  _source: NormalizedInputSource,
  sourcePath?: string,
): ContentType {
  const text = rawInput.trim();
  const extension = sourcePath ? sourcePath.split('.').pop()?.toLowerCase() ?? '' : '';

  if (extension === 'json') {
    return 'json';
  }

  if (extension === 'yml' || extension === 'yaml') {
    return 'yaml';
  }

  if (extension === 'html' || extension === 'htm') {
    return 'html';
  }

  if (extension === 'log') {
    return 'logs';
  }

  if (extension === 'md' || extension === 'markdown') {
    return 'markdown';
  }

  if (isCodeExtension(extension)) {
    return 'code';
  }

  if (looksLikeJson(text)) {
    return 'json';
  }

  if (looksLikeYaml(text)) {
    return 'yaml';
  }

  if (looksLikeHtml(text)) {
    return 'html';
  }

  if (looksLikeLogs(text)) {
    return 'logs';
  }

  if (looksLikeMarkdown(text)) {
    return 'markdown';
  }

  if (text.length > 0) {
    return 'text';
  }

  return 'unknown';
}

/**
 * The canonical spellings a caller may declare.
 *
 * The set is not arbitrary: it is exactly the languages the *filename* route already
 * recognizes (`isCodeExtension` plus the document extensions above). Declaration parity is
 * the point — `--language python` and a `.py` filename must reach the same validator with
 * the same content type, or the two routes become two behaviours to reason about. Adding a
 * language here without adding its extension there would create a declaration that no file
 * can make, which is how the routes drift apart.
 */
export type DeclaredLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'c'
  | 'cpp'
  | 'shell'
  | 'powershell'
  | 'css'
  | 'scss'
  | 'sql'
  | 'json'
  | 'yaml'
  | 'html'
  | 'markdown'
  | 'logs'
  | 'text';

const LANGUAGE_ALIASES: Readonly<Record<string, DeclaredLanguage>> = {
  ts: 'typescript',
  tsx: 'typescript',
  typescript: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  cjs: 'javascript',
  mjs: 'javascript',
  javascript: 'javascript',
  py: 'python',
  python: 'python',
  python3: 'python',
  go: 'go',
  golang: 'go',
  rs: 'rust',
  rust: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  ps1: 'powershell',
  powershell: 'powershell',
  css: 'css',
  scss: 'scss',
  sql: 'sql',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  htm: 'html',
  html: 'html',
  md: 'markdown',
  markdown: 'markdown',
  log: 'logs',
  logs: 'logs',
  txt: 'text',
  text: 'text',
  plaintext: 'text',
};

/**
 * The content type a declared language implies.
 *
 * `Record<DeclaredLanguage, …>` for the same reason `CONTENT_TYPE_VALIDATORS` is total:
 * adding a language without deciding what content type it is becomes a compile error rather
 * than a silent `undefined` that falls back to a probe.
 *
 * Every programming language maps to `code`, including the ones the AST-lite suite has no
 * validator for. That is not an oversight, and it is the same answer the filename route
 * gives today: `foo.rs` classifies as `code` and `CONTENT_TYPE_VALIDATORS.code` is the
 * TypeScript validator, so Rust is bracket-checked as TypeScript either way. Declaring the
 * language does not make that better; it makes it *reachable from stdin*, and it is pinned
 * in `test/unit/declared-language.test.ts` so the next person meets it as a recorded
 * decision rather than as a surprise.
 */
const CONTENT_TYPE_BY_LANGUAGE: Readonly<Record<DeclaredLanguage, ContentType>> = {
  typescript: 'code',
  javascript: 'code',
  python: 'code',
  go: 'code',
  rust: 'code',
  java: 'code',
  c: 'code',
  cpp: 'code',
  shell: 'code',
  powershell: 'code',
  css: 'code',
  scss: 'code',
  sql: 'code',
  json: 'json',
  yaml: 'yaml',
  html: 'html',
  markdown: 'markdown',
  logs: 'logs',
  text: 'text',
};

/**
 * Resolves a caller-supplied language string to its canonical spelling.
 *
 * Returns `undefined` for anything unrecognized, and the caller is expected to *reject*
 * that rather than proceed: an adapter that quietly drops `--language pyton` hands back a
 * clean-looking run in which nothing was declared and nothing was validated, which is
 * invariant 10's failure shape. `src/cli/main.ts` and the MCP `optimize_context` handler
 * both error on `undefined`.
 *
 * Normalizing (rather than storing the caller's spelling) means `item.language` has one
 * value per language, so downstream comparisons — `selectValidator`, `detectLanguage`,
 * `selectElisionRegions` — cannot disagree about whether `py` and `Python` are the same
 * thing.
 */
export function normalizeLanguage(language?: string): DeclaredLanguage | undefined {
  if (!language) {
    return undefined;
  }

  return LANGUAGE_ALIASES[language.trim().toLowerCase()];
}

/**
 * The content type implied by a canonical language. See `CONTENT_TYPE_BY_LANGUAGE`.
 */
export function contentTypeForLanguage(language: DeclaredLanguage): ContentType {
  return CONTENT_TYPE_BY_LANGUAGE[language];
}

/**
 * Every spelling `normalizeLanguage` accepts, sorted — for CLI and MCP error messages, so
 * the accepted set is derived from the table rather than restated next to it.
 */
export function declarableLanguages(): ReadonlyArray<string> {
  return Object.keys(LANGUAGE_ALIASES).sort();
}

/**
 * Computes a deterministic content hash for domain objects.
 */
export function hashContent(value: unknown): string {
  const serialized = stableSerialize(value);
  return createHash('sha256').update(serialized).digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }

  return JSON.stringify(value) ?? 'null';
}

function looksLikeJson(text: string): boolean {
  if (!(text.startsWith('{') || text.startsWith('['))) {
    return false;
  }

  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** `---` / `...`: a YAML document boundary, and nothing else's syntax. */
const YAML_DOC_MARKER = /^(?:---|\.\.\.)\s*$/;
/** A mapping entry, optionally as the first key of a sequence element (`- name: web`). */
const YAML_MAPPING = /^\s*(?:-\s+)?(?:[\w.\-/]+|"[^"]+"|'[^']+')\s*:(?:\s+\S.*|\s*)$/;
/** A sequence entry. Legal YAML *and* an ordinary markdown bullet — see `looksLikeYaml`. */
const YAML_SEQUENCE = /^\s*-(?:\s+\S.*)?$/;
/** A comment. Legal YAML *and* an ordinary markdown heading. */
const YAML_COMMENT = /^\s*#/;
/** A mapping whose value is a block scalar: everything indented under it is free text. */
const YAML_BLOCK_SCALAR = /:\s*[|>][-+]?\d*\s*$/;

/**
 * Detects YAML by asking whether the input is *predominantly* YAML, the same shape as
 * `looksLikeLogs`.
 *
 * The previous probe was `/^(---\s*$)?([\w.-]+:\s+.+)$/m`. The leading group is optional and
 * cannot span a line, so what it actually tested was "some line looks like `word: text`" —
 * a shape English prose uses constantly. Measured **pathless**, which is the Gateway and MCP
 * shape and therefore live provider traffic, it claimed `yaml` for **12 of this repository's
 * 22 markdown documents**, on lines like `Responsibilities:`,
 * `Consequence: A private, written warning`, and `Note: the AST validators run in CLI mode`.
 *
 * That verdict is not inert. `DriftTracker`'s `MARKDOWN_MARKER_TYPES` allowlist does not
 * include `yaml`, so a prose message mistagged this way contributes **no structural markers**
 * and `R_struct` stops being able to see heading loss on the one content type where it does
 * real work.
 *
 * The load-bearing decision is what counts as evidence. A `#` line and a bare `- ` line are
 * legal YAML *and* ordinary markdown, so they are evidence of nothing and are skipped rather
 * than counted on either side; the ratio is taken over the lines that discriminate. The body
 * of a block scalar is skipped for the same reason — it is free text by definition, and
 * counting it against YAML would penalise a config file for documenting itself.
 *
 * Measured over this repository's 27 prose documents against real YAML (its own CI workflow,
 * a compose file, a Kubernetes manifest, front matter, a block scalar), the two sets do not
 * overlap: every YAML sample scores **1.000**, the highest-scoring prose document scores
 * **0.455**. The threshold sits near the middle of that empty band rather than against either
 * edge, so it is not tuned to a single sample on either side.
 */
function looksLikeYaml(text: string): boolean {
  let decisive = 0;
  let yamlish = 0;
  let mappings = 0;
  let markers = 0;
  let blockIndent: number | null = null;

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim().length === 0) {
      continue;
    }

    const indent = line.length - line.trimStart().length;
    if (blockIndent !== null) {
      if (indent > blockIndent) {
        continue;
      }
      blockIndent = null;
    }

    if (YAML_MAPPING.test(line)) {
      mappings += 1;
      yamlish += 1;
      decisive += 1;
      if (YAML_BLOCK_SCALAR.test(line)) {
        blockIndent = indent;
      }
    } else if (YAML_DOC_MARKER.test(line)) {
      markers += 1;
      yamlish += 1;
      decisive += 1;
    } else if (YAML_COMMENT.test(line) || YAML_SEQUENCE.test(line)) {
      // Ambiguous with markdown. Counted on neither side.
    } else {
      decisive += 1;
    }
  }

  // Enough structure to be a document: two mappings, or a document marker plus one. A single
  // `Note: ...` sentence cannot carry a whole classification on its own.
  const enoughStructure = mappings >= 2 || (markers >= 1 && mappings >= 1);
  return enoughStructure && decisive > 0 && yamlish / decisive >= 0.75;
}

const HTML_CLOSING_TAG = /<\/([a-z][a-z0-9-]*)\s*>/gi;
const HTML_OPENING_TAG = /<([a-z][a-z0-9-]*)(?:\s[^<>]*)?\/?>/gi;

/**
 * Detects markup by a matched open/close tag pair, not by the presence of angle brackets.
 *
 * The previous probe was `/<\/?[a-z][\s\S]*>/i`. `[\s\S]*` is greedy and unanchored, so the
 * match ran from the first `<letter` to the **last** `>` anywhere in the input — one generic
 * parameter plus any later `>` was sufficient, and TypeScript guarantees both. It reported
 * `html` for 46 of this repository's 57 TypeScript sources.
 *
 * Requiring a closing tag whose element name also appears as an opening tag costs nothing on
 * real markup (a document without a single matched pair is not a document) and rejects
 * `Array<string>`, `a <b && c> d`, and a bare `<placeholder>`, none of which have one.
 */
function looksLikeHtml(text: string): boolean {
  if (/<!doctype\s+html/i.test(text)) {
    return true;
  }

  const closing = new Set<string>();
  for (const match of text.matchAll(HTML_CLOSING_TAG)) {
    closing.add(match[1]!.toLowerCase());
  }
  if (closing.size === 0) {
    return false;
  }

  for (const match of text.matchAll(HTML_OPENING_TAG)) {
    if (closing.has(match[1]!.toLowerCase())) {
      return true;
    }
  }

  return false;
}

/** A clock time, not preceded by a digit/colon/dot so it cannot start mid-number. */
const LOG_CLOCK = /(?<![\d:.])\d{1,2}:\d{2}:\d{2}(?!\d)/;
/** A severity token, delimited so `ERRORS` or `information` do not match. Uppercase only. */
const LOG_LEVEL = /(?:^|[\s[(<|])(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL|NOTICE)(?:$|[\s\])>:,|])/;
/** A line that opens with its timestamp, with or without a leading date. */
const LOG_TIMESTAMP_PREFIX = /^\s*\[?(?:\d{4}[-/]\d{2}[-/]\d{2}[T ])?\d{1,2}:\d{2}:\d{2}/;

/**
 * Detects log output by asking whether the input is *predominantly* log lines.
 *
 * Both previous alternatives failed on ISO-8601, which is what every structured logger
 * emits, for independent reasons:
 *
 *  - `/(?:\bINFO\b|...).*\d{4}-\d{2}-\d{2}/m` required the level **before** the date. Real
 *    lines are `2026-07-30T19:00:01.012Z [DEBUG] ...` — date first.
 *  - `/\b\d{2}:\d{2}:\d{2}\b/` cannot match `T19:00:01`, because `T` and `1` are both word
 *    characters and there is therefore no word boundary before the hour.
 *
 * The consequence was that `tokendamper-benchmark/test_data/sample_logs.txt` — 75 lines of
 * nothing but log output — classified as `text`.
 *
 * The replacement is a per-line predicate (a clock time, plus either a severity token or a
 * timestamp in leading position) applied across the whole input. The majority requirement is
 * what keeps a prose document that mentions one timestamp from being read as logs; the old
 * second alternative had no such requirement and fired on any single `hh:mm:ss` anywhere.
 */
function looksLikeLogs(text: string): boolean {
  if (!LOG_CLOCK.test(text)) {
    return false;
  }

  let nonEmpty = 0;
  let logLines = 0;

  for (const line of text.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    nonEmpty += 1;
    if (LOG_CLOCK.test(line) && (LOG_LEVEL.test(line) || LOG_TIMESTAMP_PREFIX.test(line))) {
      logLines += 1;
    }
  }

  return nonEmpty > 0 && logLines / nonEmpty >= 0.5;
}

function looksLikeMarkdown(text: string): boolean {
  return (
    // A fenced block is a markdown construct. It used to be read as evidence of `code`,
    // which is backwards — see `isCodeExtension`.
    /```[\s\S]*```/.test(text) ||
    /(^|\n)#{1,6}\s+\S/.test(text) ||
    /(^|\n)(- |\* |\d+\.)\s+\S/.test(text) ||
    /\[[^\]]+\]\([^)]+\)/.test(text)
  );
}

/**
 * Code is detected by file extension only. There is deliberately no content signal.
 *
 * The one this function used to have was a triple-backtick fence, and a fence is markdown
 * syntax, not code: a code file does not contain fences, a document that quotes code does.
 * That rule classified every "here's the fix: ```ts ... ```" message as `code`, and because
 * `selectValidator` maps `contentType: 'code'` to the **TypeScript** validator, ordinary
 * prose was then parsed as TypeScript.
 *
 * Measured, the outcome was decided by apostrophe parity in the surrounding prose:
 * "Here's ... it's ... that's" leaves an odd number of quote characters open and the
 * message is rejected with `AST_UNTERMINATED_STRING`, while the same message with an even
 * count passes. A check whose verdict flips on whether the author wrote one more
 * contraction is not validating anything — and since a whole-document language validator
 * cannot know what a mixed prose/code document *should* parse as, a false positive is its
 * only possible finding. It is removed rather than tuned.
 *
 * This costs no detection of real code: every path that carries actual source files (CLI
 * `optimize <file>`, bench fixtures) supplies an extension, which is what the list below
 * matches. Content-only code arriving without an extension classified as `text` before this
 * change too — the fence rule never covered it. See DECISIONS.md §17.
 */
function isCodeExtension(extension: string): boolean {
  return ['ts', 'tsx', 'js', 'jsx', 'cjs', 'mjs', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'sh', 'ps1', 'css', 'scss', 'sql'].includes(extension);
}

function validateBudget(budget: OptimizationBudget): OptimizationBudget {
  if (
    budget.maxInputTokens !== undefined &&
    (!Number.isInteger(budget.maxInputTokens) || budget.maxInputTokens < 0)
  ) {
    throw new Error('Invalid optimization budget: maxInputTokens must be a non-negative integer.');
  }

  if (
    budget.maxOutputTokens !== undefined &&
    (!Number.isInteger(budget.maxOutputTokens) || budget.maxOutputTokens < 0)
  ) {
    throw new Error('Invalid optimization budget: maxOutputTokens must be a non-negative integer.');
  }

  if (
    budget.targetReductionRatio !== undefined &&
    (typeof budget.targetReductionRatio !== 'number' ||
      Number.isNaN(budget.targetReductionRatio) ||
      budget.targetReductionRatio < 0 ||
      budget.targetReductionRatio > 1)
  ) {
    throw new Error('Invalid optimization budget: targetReductionRatio must be between 0 and 1.');
  }

  if (
    budget.maxLatencyMs !== undefined &&
    (!Number.isInteger(budget.maxLatencyMs) || budget.maxLatencyMs < 0)
  ) {
    throw new Error('Invalid optimization budget: maxLatencyMs must be a non-negative integer.');
  }

  if (!['low', 'medium', 'high'].includes(budget.riskTolerance)) {
    throw new Error('Invalid optimization budget: riskTolerance must be low, medium, or high.');
  }

  const seen = new Set<ContextItemKind>();
  for (const kind of budget.preserveKinds) {
    if (seen.has(kind)) {
      continue;
    }
    seen.add(kind);
  }

  return {
    ...budget,
    preserveKinds: [...seen],
  };
}
