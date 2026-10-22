import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/target/**',
    '**/src-tauri/gen/**',
    '**/coverage/**',
  ]),
  {
    files: ['**/*.{ts,tsx,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended],
  },
  {
    files: ['apps/desktop/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      'react-refresh/only-export-components': ['error', { allowConstantExport: true }],
    },
  },
  {
    files: ['apps/desktop/src/components/ui/**/*.{ts,tsx}'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  {
    files: [
      'apps/desktop/src/components/**/*.{ts,tsx}',
      'apps/desktop/src/features/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@tauri-apps/*', 'node:*'],
              message:
                'Use the platform adapter; UI components must not call native APIs.',
            },
          ],
        },
      ],
    },
  },
])
