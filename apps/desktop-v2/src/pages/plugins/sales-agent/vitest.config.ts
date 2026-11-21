import { defineConfig, mergeConfig } from 'vitest/config'
import base from '../../../../../../vitest.config.ts'

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['apps/desktop-v2/src/pages/plugins/sales-agent/**/*.test.{ts,tsx}'],
    },
  }),
)
