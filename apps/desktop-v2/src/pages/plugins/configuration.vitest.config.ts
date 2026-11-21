import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@nexus/contracts/configuration': fileURLToPath(
        new URL(
          '../../../../../packages/contracts/src/configuration.ts',
          import.meta.url,
        ),
      ),
    },
  },
  test: {
    include: [
      'apps/desktop-v2/src/raccoon/plugins/configuration.test.ts',
      'apps/desktop-v2/src/pages/plugins/PluginConfigurationDialog.test.tsx',
    ],
    environment: 'jsdom',
  },
})
