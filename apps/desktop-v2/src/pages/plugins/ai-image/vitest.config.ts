import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@nexus/plugin-contracts/products': resolve(
        process.cwd(),
        'packages/plugin-contracts/src/products.ts',
      ),
      '@nexus/plugin-sdk/ui': resolve(process.cwd(), 'packages/plugin-sdk/src/ui.ts'),
    },
  },
  test: {
    include: ['apps/desktop-v2/src/pages/plugins/ai-image/**/*.test.{ts,tsx}'],
    environment: 'node',
    restoreMocks: true,
  },
})
