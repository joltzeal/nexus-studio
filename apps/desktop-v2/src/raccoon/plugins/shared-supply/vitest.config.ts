import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['apps/desktop-v2/src/raccoon/plugins/shared-supply/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    maxWorkers: 4,
  },
})
