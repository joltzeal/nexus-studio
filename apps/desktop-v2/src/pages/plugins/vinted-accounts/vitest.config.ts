import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'apps/desktop-v2/src/pages/plugins/vinted-accounts/AccountPager.test.tsx',
      'apps/desktop-v2/src/pages/plugins/vinted-accounts/AccountCells.test.tsx',
      'apps/desktop-v2/src/pages/plugins/vinted-accounts/AccountAddressPicker.test.tsx',
      'apps/desktop-v2/src/pages/plugins/vinted-accounts/Sim8NumberPicker.vitest.ts',
      'apps/desktop-v2/src/pages/plugins/vinted-accounts/AccountForm.vitest.ts',
    ],
    environment: 'jsdom',
  },
})
