import js from '@eslint/js';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const STORAGE_GLOBALS = ['localStorage', 'sessionStorage', 'indexedDB'].map((name) => ({
  name,
  message: 'Persist through a host adapter (COLLAB-HOST-1.1).',
}));

// The host owns configuration and time: library source reads neither the environment nor the
// process (COLLAB-HOST-1.1).
const PROCESS_GLOBALS = [
  {
    name: 'process',
    message: 'Take configuration as an option; the host reads its environment (COLLAB-HOST-1.1).',
  },
];

// TypeScript rules TS2 to TS11 (docs/CODING-GUIDELINES.md). They load the TypeScript program, so
// `npm run lint` gives ESLint a 6 GB heap.
const TYPED_FILES = ['src/**/*.ts', 'test/**/*.ts', '*.config.ts'];
// Vitest loads its configuration through its default export.
const DEFAULT_EXPORT_LOADERS = ['*.config.ts'];
const ENUM_SYNTAX = {
  selector: 'TSEnumDeclaration',
  message: 'Use a string-literal union or an `as const` object instead of `enum` (TS6).',
};
const CLASS_SYNTAX = [
  {
    // A class may extend a third-party class the library must hand back (I1).
    selector: 'ClassDeclaration:not([superClass])',
    message: 'Use factory functions that return plain objects (I1).',
  },
  {
    selector: 'ClassExpression:not([superClass])',
    message: 'Use factory functions that return plain objects (I1).',
  },
];

export default tseslint.config(
  {
    ignores: ['node_modules/', 'dist/', 'coverage/', 'test-results/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: { 'simple-import-sort': simpleImportSort },
    rules: {
      // One import statement per module, sorted: packages first, then relative paths.
      'no-duplicate-imports': 'error',
      'simple-import-sort/imports': ['error', { groups: [['^\\u0000', '^node:', '^@?\\w', '^']] }],
      'simple-import-sort/exports': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    name: 'collaboration-tools/typescript',
    files: TYPED_FILES,
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': 'allow-with-description',
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': false,
          minimumDescriptionLength: 10,
        },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/prefer-promise-reject-errors': [
        'error',
        { allowThrowingAny: true, allowThrowingUnknown: true },
      ],
      'preserve-caught-error': 'error',
      'no-restricted-syntax': ['error', ENUM_SYNTAX],
    },
  },
  {
    name: 'collaboration-tools/typescript/default-exports',
    files: TYPED_FILES,
    ignores: DEFAULT_EXPORT_LOADERS,
    rules: {
      'no-restricted-exports': [
        'error',
        {
          restrictDefaultExports: {
            direct: true,
            named: true,
            defaultFrom: true,
            namedFrom: true,
            namespaceFrom: true,
          },
        },
      ],
    },
  },
  {
    // Coding guidelines C1, I1, N3 and N6 (docs/CODING-GUIDELINES.md).
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    rules: {
      complexity: ['error', 15],
      'max-depth': ['error', 3],
      'max-params': ['error', 3],
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
      'no-restricted-globals': ['error', ...STORAGE_GLOBALS, ...PROCESS_GLOBALS],
      'no-restricted-syntax': ['error', ENUM_SYNTAX, ...CLASS_SYNTAX],
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'typeLike', format: ['PascalCase'] },
        {
          selector: 'variable',
          format: ['camelCase', 'PascalCase', 'UPPER_CASE'],
          leadingUnderscore: 'allow',
        },
        { selector: 'function', format: ['camelCase'] },
        { selector: 'parameter', format: ['camelCase'], leadingUnderscore: 'allow' },
      ],
    },
  },
  {
    files: ['src/**/*.test.ts', 'test/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ENUM_SYNTAX,
        {
          // Tests run in parallel workers; a skipped test hides a failure (T26).
          selector:
            'CallExpression[callee.object.name=/^(it|test|describe)$/][callee.property.name=/^(skip|only|todo)$/]',
          message: 'Do not skip, focus or stub tests (T26).',
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs', '*.config.{js,ts}', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
);
