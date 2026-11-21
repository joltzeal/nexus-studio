import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@nexus/plugin-contracts/proxy-pool': resolve(
        process.cwd(),
        'packages/plugin-contracts/src/proxy-pool.ts',
      ),
    },
  },
  test: {
    include: ['apps/desktop-v2/src/pages/plugins/proxy-pool/*.test.tsx'],
    environment: 'jsdom',
  },
})
