import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@nexus/plugin-contracts/products': resolve(
        process.cwd(),
        'packages/plugin-contracts/src/products.ts',
      ),
    },
  },
  test: {
    include: [
      'apps/desktop-v2/src/raccoon/plugins/products/**/*.test.ts',
      'apps/desktop-v2/src/pages/plugins/products/**/*.test.tsx',
      'packages/plugin-contracts/src/products.test.ts',
    ],
    environment: 'node',
  },
})
