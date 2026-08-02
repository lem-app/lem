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
    // Tunnel proxy spec section 8.4, requirement 1.
    //
    // A service framed at `/app/<deviceId>/<serviceId>/` is same-origin with
    // this dashboard - that is what lets the Service Worker proxy it, and it is
    // not something `sandbox` restrains. Anything the dashboard puts in Web
    // Storage is therefore readable by third-party app code we invited onto the
    // origin. The signaling JWT must not be among it.
    //
    // The ban is on the *stores*, not on the string "token": a rule that only
    // matched `setItem('token', ...)` would be satisfied by renaming the key.
    // Tests are exempt because asserting the stores are empty requires reading
    // them; `src/lib/session.ts` carries the one permitted reference, a
    // `removeItem` that purges the legacy key, behind an explaining disable.
    //
    // This rule is necessary and not sufficient. It cannot see IndexedDB, a
    // cookie, a Cache entry or a URL fragment. `src/lib/token-persistence.test.ts`
    // sweeps all of those behaviourally, and is the criterion that actually
    // holds - see the note there about a green lint rule proving nothing.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.{ts,tsx}', 'src/test/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'localStorage',
          message:
            'The remote dashboard must not persist anything to localStorage: the framed app at /app/<deviceId>/<serviceId>/ shares this origin and can read it (tunnel proxy spec section 8.4). Hold session state in a module-scoped variable.',
        },
        {
          name: 'sessionStorage',
          message:
            'The remote dashboard must not persist anything to sessionStorage: the framed app at /app/<deviceId>/<serviceId>/ shares this origin and can read it (tunnel proxy spec section 8.4). Hold session state in a module-scoped variable.',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'window',
          property: 'localStorage',
          message:
            'Banned for the same reason as the bare `localStorage` global - see tunnel proxy spec section 8.4.',
        },
        {
          object: 'window',
          property: 'sessionStorage',
          message:
            'Banned for the same reason as the bare `sessionStorage` global - see tunnel proxy spec section 8.4.',
        },
        {
          object: 'globalThis',
          property: 'localStorage',
          message:
            'Banned for the same reason as the bare `localStorage` global - see tunnel proxy spec section 8.4.',
        },
        {
          object: 'globalThis',
          property: 'sessionStorage',
          message:
            'Banned for the same reason as the bare `sessionStorage` global - see tunnel proxy spec section 8.4.',
        },
      ],
    },
  },
  {
    // The reachability expander must not be able to express a brand check.
    //
    // Every slot read in the sweep goes through the probe registry in
    // `reachability-probes.ts`, where a probe cannot exist without the
    // `presentsAs` fallback that stops an unreadable wrapper becoming silence.
    // Twice a read shipped without one, and a reviewer then showed that nothing
    // forced a *new* read to join the registry at all - a private-field brand
    // check spliced into `expandObject` type-checked, linted clean, and was
    // invisible to both registry tests.
    //
    // A brand check is, by construction, "attempt an operation that throws
    // unless the brand is present". Banning `try`/`catch`, `.prototype` access
    // and private identifiers in this one file therefore makes brand checks
    // *inexpressible* here rather than merely discouraged, and the captured
    // built-ins it would otherwise reuse are module-private to the probes file.
    // Adding a read now means adding a probe.
    files: ['src/test/reachability.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TryStatement',
          message:
            'No try/catch in the reachability expander: a brand check is "call something that throws unless the brand is present", so this is what keeps slot reads in the probe registry (reachability-probes.ts), where a fallback is mandatory.',
        },
        {
          selector: "MemberExpression[property.name='prototype']",
          message:
            'No built-in prototype capture in the reachability expander. Slot-reading primitives live in reachability-probes.ts and are module-private on purpose.',
        },
        {
          selector: 'PrivateIdentifier',
          message:
            'No private-field brand checks in the reachability expander - add a SlotProbe in reachability-probes.ts instead, which forces a `presentsAs` fallback.',
        },
      ],
    },
  },
  {
    // ESLint's own flat config is plain JS and outside every tsconfig.
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
])
