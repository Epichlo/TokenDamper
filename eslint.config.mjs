import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

/**
 * Architecture rules, policed rather than described — audit OX-L17.
 *
 * `no-restricted-imports` is used deliberately in place of `eslint-plugin-boundaries` or
 * dependency-cruiser, which is what the audit suggested. Both would express these two rules more
 * elegantly and both cost a new dependency, and the rules this repository actually has are two
 * import bans. DECISIONS §69 deferred L17 on exactly that dependency cost; it does not apply to a
 * rule already in the linter.
 *
 * `allowTypeImports` is the load-bearing option. A `import type` is erased at compile time and
 * creates no runtime coupling, which is what these invariants are about — the engine naming a
 * stage's options type does not wire that stage into the engine.
 */
const restrictStageImports = {
  '@typescript-eslint/no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: ['**/stages/*', '**/stages/**'],
          allowTypeImports: true,
          message:
            'Invariant 4: only src/core/stage-registry may import a concrete stage implementation. ' +
            'The registry is the single place that knows which stages exist, so that adding or ' +
            'removing one touches one file. `import type` is allowed — it is erased and wires nothing.',
        },
      ],
    },
  ],
};

const restrictUpwardImports = {
  '@typescript-eslint/no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: ['**/adapters/**', '**/cli/**', '**/gateway/**'],
          message:
            'Layering: src/core and src/stages are below the entry modes and must not import from ' +
            'them. An adapter depends on the engine; the engine must not depend on an adapter, or ' +
            'the CLI and the Gateway stop being interchangeable front ends. Currently clean — this ' +
            'rule exists to keep it that way.',
        },
      ],
    },
  ],
};

export default [
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },

  // Invariant 4 — stage implementations are the registry's business alone.
  {
    files: ['src/**/*.ts'],
    ignores: [
      // The registry is the exception the invariant is written around.
      'src/core/stage-registry/**',
      // **A known violation, pinned rather than hidden.** `core/validation` value-imports
      // `extractConstraintDirectives` from `stages/cleanup/constraint-preservation`, so the
      // constraint check and the stage that preserves constraints share one extractor. That is a
      // real runtime dependency from core onto a concrete stage, and CLAUDE.md's invariant 4 says
      // flatly that only the registry may have one — the code and the invariant disagree, and the
      // code is what shipped.
      //
      // Exempted rather than refactored because moving the extractor is a change to the optimize
      // route, which this repository requires a corpus measurement for, and a lint rule is not the
      // change that should carry one. Narrow this the day the extractor moves somewhere neutral.
      'src/core/validation/index.ts',
    ],
    rules: restrictStageImports,
  },

  // Layering — nothing below the entry modes may import one.
  {
    files: ['src/core/**/*.ts', 'src/stages/**/*.ts'],
    rules: restrictUpwardImports,
  },
];
