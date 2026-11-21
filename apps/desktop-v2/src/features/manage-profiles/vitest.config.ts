import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['apps/desktop-v2/src/features/manage-profiles/ui/ProxyChoiceList.test.tsx'],
  },
})
