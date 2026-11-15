import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@nexus/contracts/browser': fileURLToPath(
        new URL('./packages/contracts/src/browser.ts', import.meta.url),
      ),
      '@nexus/contracts/configuration': fileURLToPath(
        new URL('./packages/contracts/src/configuration.ts', import.meta.url),
      ),
      '@nexus/contracts': fileURLToPath(
        new URL('./packages/contracts/src/index.ts', import.meta.url),
      ),
      '@nexus/plugin-sdk/agent': fileURLToPath(
        new URL('./packages/plugin-sdk/src/agent.ts', import.meta.url),
      ),
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
      '@nexus/plugin-contracts/products': fileURLToPath(
        new URL('./packages/plugin-contracts/src/products.ts', import.meta.url),
      ),
      '@nexus/plugin-contracts/vinted-accounts': fileURLToPath(
        new URL('./packages/plugin-contracts/src/vinted-accounts.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'plugins/*/src/**/*.test.ts',
      'plugins/*/src/**/*.test.mjs',
      'apps/desktop/src/**/*.test.ts',
      'apps/license-worker/test/**/*.test.ts',
      'scripts/**/*.test.mjs',
    ],
    environment: 'node',
    testTimeout: 10_000,
    restoreMocks: true,
  },
})
