import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@nexus/plugin-contracts/vinted-helper': resolve(
        process.cwd(),
        'packages/plugin-contracts/src/vinted-helper.ts',
      ),
    },
  },
  test: {
    include: ['apps/desktop-v2/src/pages/plugins/address-generator/*.test.tsx'],
    environment: 'jsdom',
    restoreMocks: true,
  },
})
