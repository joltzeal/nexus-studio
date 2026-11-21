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
    include: ['apps/desktop-v2/src/raccoon/plugins/ai-image/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    maxWorkers: 4,
  },
})
