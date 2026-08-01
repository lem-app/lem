import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'coverage']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      // Type-aware linting: `no-floating-promises` and `no-misused-promises`
      // catch the unhandled-rejection class of bug that this codebase had
      // several of, and the `no-unsafe-*` rules catch untyped `response.json()`.
      tseslint.configs.recommendedTypeChecked,
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `_options` in the WebSocket-API shims is required by the interface but
      // genuinely unused.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // shadcn/ui components export their `cva` variants next to the component.
      'react-refresh/only-export-components': ['error', { allowConstantExport: true }],
    },
  },
  {
    // ESLint's own flat config is plain JS and outside every tsconfig.
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
])
