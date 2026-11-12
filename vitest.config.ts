import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./apps/desktop/src', import.meta.url)),
      '@nexus/plugin-sdk/configuration': fileURLToPath(
        new URL('./packages/plugin-sdk/src/configuration.ts', import.meta.url),
      ),
      '@nexus/plugin-sdk/lifecycle': fileURLToPath(
        new URL('./packages/plugin-sdk/src/lifecycle.ts', import.meta.url),
      ),
      '@nexus/plugin-sdk': fileURLToPath(
        new URL('./packages/plugin-sdk/src/index.ts', import.meta.url),
      ),
      '@nexus/plugin-email/manifest': fileURLToPath(
        new URL('./plugins/email/nexus.plugin.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'plugins/*/src/**/*.test.ts',
      'apps/desktop/src/**/*.test.ts',
      'scripts/**/*.test.mjs',
    ],
    environment: 'node',
    testTimeout: 10_000,
    restoreMocks: true,
  },
})
