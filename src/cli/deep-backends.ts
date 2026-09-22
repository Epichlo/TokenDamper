import { registerParserBackend } from '../core/parser/registry';
import type { ParserAdapter } from '../core/parser/types';

interface DeepModule {
  createDeepBackends(): Promise<ReadonlyArray<ParserAdapter>>;
}

/**
 * Loads `tokendamper-deep` and registers every backend it carries.
 *
 * **Two resolution paths, and the order is the migration.** The bare specifier is the R4
 * shape, once the package is published or linked. The repo-relative path is the R3 shape: the
 * package is `private: true` and the workspace is not linked into `node_modules`, and linking
 * it means an `npm install` that reaches the main checkout. `deep-parity.js` resolves it
 * exactly this way and prints the same build instruction.
 *
 * **An empty registry is an error, not a fall-through.** `--engine-mode deep` that silently
 * ran Fast is invariant 10 in its purest form — a green result from a path that never
 * executed. DECISIONS §54 set the precedent when an unrecognised `TOKENDAMPER_*` enum value
 * became a hard error rather than a silent default.
 */
export async function registerDeepBackends(): Promise<number> {
  const mod = await loadDeepModule();
  const backends = await mod.createDeepBackends();

  let registered = 0;
  for (const backend of backends) {
    // JavaScript is deliberately not registered: no Fast validator ever returns the language
    // `javascript` — `.js` resolves to the TypeScript validator, whose `language` is
    // `typescript` — so a backend registered under that key could never be resolved. Putting
    // it in the registry anyway would make `registeredLanguages` claim coverage that nothing
    // can reach. DECISIONS §81.
    if (backend.language === 'javascript') continue;
    registerParserBackend(backend);
    registered += 1;
  }

  if (registered === 0) {
    throw new Error(
      'tokendamper: --engine-mode deep registered no parser backends. Refusing to run, because ' +
        'falling back to the fast path here would report a deep run that never happened.',
    );
  }
  return registered;
}

async function loadDeepModule(): Promise<DeepModule> {
  const candidates = ['tokendamper-deep', '../../packages/deep/dist/index.js'];
  const failures: string[] = [];

  for (const specifier of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require(specifier) as DeepModule;
    } catch (err) {
      failures.push(`${specifier}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(
    'tokendamper: --engine-mode deep could not load tokendamper-deep. It is unpublished in R3, ' +
      'so build it first:\n  npx tsc -p packages/deep/tsconfig.json\nTried:\n  ' +
      failures.join('\n  '),
  );
}
