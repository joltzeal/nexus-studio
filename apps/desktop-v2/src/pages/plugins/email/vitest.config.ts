import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['apps/desktop-v2/src/pages/plugins/email/*.test.tsx'],
    environment: 'jsdom',
  },
})
