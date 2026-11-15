import { createBaseConfig, ENUM_SYNTAX } from '@flamboyantengineer/ui-components/tooling/eslint';
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
  // The shared rules (ui-components' specs/TOOLING.md): imports, TypeScript rules TS2 to TS11,
  // named exports, and C1, N3 and N6 in library source.
  ...createBaseConfig({
    name: 'collaboration-tools',
    tsconfigRootDir: import.meta.dirname,
    typedFiles: ['src/**/*.ts', 'test/**/*.ts', '*.config.ts'],
    // Vitest loads its configuration through its default export.
    defaultExportLoaders: ['*.config.ts'],
    sourceFiles: ['src/**/*.ts'],
    nodeFiles: ['scripts/**/*.mjs', '*.config.{js,mjs,ts}', 'eslint.config.js'],
  }),
  {
    // Coding guideline I1 and the host adapter rule (docs/CODING-GUIDELINES.md).
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    rules: {
      'no-restricted-globals': ['error', ...STORAGE_GLOBALS, ...PROCESS_GLOBALS],
      'no-restricted-syntax': ['error', ENUM_SYNTAX, ...CLASS_SYNTAX],
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
);
