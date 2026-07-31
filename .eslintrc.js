module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  env: {
    node: true,
    browser: true,
    es2021: true,
  },
  ignorePatterns: ['dist', 'node_modules', '*.js', 'out', 'reference_projects'],
  rules: {
    // Strict typescript rules to enforce code quality
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'error',
    'no-empty': 'error',
  },
  overrides: [
    {
      // Test doubles legitimately need `any`: a stub standing in for one method
      // of a wide interface should not have to satisfy the whole thing, and a
      // fixture asserting on malformed input has to be able to express it.
      files: ['**/__tests__/**/*.ts', '**/*.test.ts', '**/*.test.tsx'],
      rules: { '@typescript-eslint/no-explicit-any': 'off' },
    },
    {
      // LEGACY, BEING BURNED DOWN — do not add files to this list.
      //
      // These are the CLI's HTTP-boundary types: JSON coming back from the
      // local API server, typed as `any` because the shapes were never
      // imported from core. The fix is to type them against `SerializedPlan`,
      // `DiscoveredModel` and `SessionMeta`, which already exist and are
      // already used elsewhere in this package. It is a real refactor across
      // the TUI effects layer, so it is tracked separately rather than
      // bundled into an unrelated change.
      //
      // The rule stays ON everywhere else, including the rest of these two
      // packages, so no new `any` can land while this is outstanding.
      files: [
        'packages/cli/src/apiClient.ts',
        'packages/cli/src/catalog.ts',
        'packages/cli/src/commands/allowlist.ts',
        'packages/cli/src/tui/effects.ts',
        'packages/cli/src/tui/reducer.ts',
        'packages/web/server/routes/sessions.ts',
      ],
      rules: { '@typescript-eslint/no-explicit-any': 'warn' },
    },
  ],
};
