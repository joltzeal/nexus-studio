import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@nexus/plugin-contracts/proxy-pool',
        replacement: resolve(process.cwd(), 'packages/plugin-contracts/src/proxy-pool.ts'),
      },
      {
        find: /^@proxyshard\/shardx-ui-kit$/,
        replacement: resolve(process.cwd(), 'apps/desktop-v2/ui-kit/src/index.ts'),
      },
      { find: '@', replacement: resolve(process.cwd(), 'apps/desktop-v2/ui-kit/src') },
    ],
  },
  test: {
    include: ['apps/desktop-v2/src/pages/plugins/proxy-pool/*.test.tsx'],
    environment: 'jsdom',
  },
})
