import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./apps/desktop/src', import.meta.url)),
    },
  },
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'plugins/*/src/**/*.test.ts',
      'apps/desktop/src/**/*.test.ts',
    ],
    environment: 'node',
    testTimeout: 10_000,
    restoreMocks: true,
  },
})
