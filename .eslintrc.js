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
      // Typecheck and jsdom tests pass such an import, and only `vite build`
      // fails on it. Tests are left out: they run in Node and reach no browser.
      files: ['packages/vscode/src/views/**/*.ts', 'packages/vscode/src/views/**/*.tsx'],
      excludedFiles: ['**/__tests__/**'],
      rules: {
        '@typescript-eslint/no-restricted-imports': ['error', {
          paths: [{
            name: '@ordewell/core',
            allowTypeImports: true,
            message: 'The root pulls Node modules into the webview bundle: import values from @ordewell/core/plan-utils, and types with `import type`.',
          }],
        }],
      },
    },
  ],
};
