import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@nexus/plugin-contracts/mail-style': resolve(process.cwd(), 'packages/plugin-contracts/src/mail-style.ts'),
    },
  },
  test: {
    include: ['apps/desktop-v2/src/pages/plugins/email/*.test.tsx'],
    environment: 'jsdom',
  },
})
