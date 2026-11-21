import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { SavedProfile } from '../../../raccoon/plugins/address-generator/model'
import type { Account } from '../../../raccoon/plugins/vinted-accounts/model'
import { AccountAddressPicker } from './AccountAddressPicker'

const ports = vi.hoisted(() => ({
  list: vi.fn(),
  saveAddress: vi.fn(),
  generation: 'initial',
}))

vi.mock('../../../raccoon/plugins/address-generator/client', () => ({
  addressApi: { list: ports.list },
}))
vi.mock('../../../raccoon/plugins/vinted-accounts/api', () => ({
  accountsApi: { saveAddress: ports.saveAddress },
}))
vi.mock('../../../raccoon/plugins/ui-session', () => ({
  pluginUiIdentity: (plugin: { runtimeGeneration: string }) => plugin.runtimeGeneration,
}))
vi.mock('../../../raccoon/plugins/catalog', () => ({
  usePluginCatalog: {
    getState: () => ({
      plugins: [
        {
          id: 'studio.address-generator',
          state: 'running',
          enabled: true,
          runtimeGeneration: ports.generation,
          capabilities: ['address.generator'],
          granted: ['address.generator'],
          methods: [
            'address.catalog',
            'address.profile',
            'address.saved.list',
            'address.saved.save',
            'address.saved.remove',
          ],
        },
      ],
    }),
  },
}))

const stamp = '2026-11-20T10:00:00Z'
const address: SavedProfile = {
  id: 'address-next',
  street: 'Test Street',
  houseNumber: '42',
  city: 'Boston',
  state: 'MA',
  county: null,
  postalCode: '02108',
  countryCode: 'US',
  latitude: 42.36,
  longitude: -71.06,
  source: 'map',
  sourceUrl: 'https://www.google.com/maps?q=42.36,-71.06',
  approximate: false,
  firstName: 'Jamie',
  lastName: 'Tester',
  username: 'jamietester',
  savedAt: stamp,
}
const { savedAt, ...profile } = address
const account: Account = {
  id: 'account-one',
  account: 'login@example.test',
  loginMethod: 'email',
  password: '',
  phone: '',
  emailOtpUrl: '',
  smsOtpUrl: '',
  status: 'active',
  note: '',
  homepageUrl: '',
  mailbox: null,
  address: { ...profile, street: 'Old Street', id: 'address-old', linkedAt: savedAt },
  createdAt: stamp,
  updatedAt: stamp,
}

it.each(['unchanged', 'changed address', 'restarted source'] as const)(
  'only links a confirmed address from the same source and snapshot (%s)',
  async (condition) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const onSaved = vi.fn()
    const page = {
      items: [address],
      total: 1,
      page: 1,
      pageSize: 20,
      storageDurable: true,
    }
    ports.generation = 'initial'
    ports.list.mockReset().mockResolvedValueOnce(page)
    ports.list.mockImplementation(async () => {
      if (condition === 'restarted source') ports.generation = 'replacement'
      return condition === 'changed address'
        ? { ...page, items: [{ ...address, street: 'Changed Street' }] }
        : page
    })
    ports.saveAddress.mockReset().mockResolvedValue({ storageDurable: true })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    async function click(label: string) {
      await act(async () => {
        const match = [...document.querySelectorAll('button')].find(
          (button) => button.textContent === label,
        )
        expect(match).toBeDefined()
        match!.click()
      })
    }
    try {
      await act(async () =>
        root.render(
          <AccountAddressPicker
            account={account}
            sourceIdentity="initial"
            onClose={vi.fn()}
            onSaved={onSaved}
          />,
        ),
      )
      await click('选择')
      expect(ports.saveAddress).not.toHaveBeenCalled()
      expect(document.body.textContent).toContain('Old Street')
      expect(document.body.textContent).toContain('Test Street')
      await click('确认关联')
      if (condition === 'unchanged') {
        expect(ports.saveAddress).toHaveBeenCalledExactlyOnceWith(
          account.id,
          profile,
          'address-old',
        )
        expect(onSaved).toHaveBeenCalledExactlyOnceWith(true)
      } else {
        expect(ports.saveAddress).not.toHaveBeenCalled()
        expect(onSaved).not.toHaveBeenCalled()
        expect(document.body.textContent).toContain('已变化')
      }
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  },
)
