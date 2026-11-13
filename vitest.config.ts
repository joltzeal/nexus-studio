import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
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
      '@nexus/plugin-email/manifest': fileURLToPath(
        new URL('./plugins/email/nexus.plugin.ts', import.meta.url),
      ),
      '@nexus/plugin-products/contracts': fileURLToPath(
        new URL('./plugins/products/src/contracts.ts', import.meta.url),
      ),
      '@nexus/plugin-products/manifest': fileURLToPath(
        new URL('./plugins/products/nexus.plugin.ts', import.meta.url),
      ),
      '@nexus/plugin-sales-agent/manifest': fileURLToPath(
        new URL('./plugins/sales-agent/nexus.plugin.ts', import.meta.url),
      ),
      '@nexus/plugin-vinted-accounts/agent-contracts': fileURLToPath(
        new URL('./plugins/vinted-accounts/src/agent-contracts.ts', import.meta.url),
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
