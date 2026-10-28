import { describe, expect, it } from 'vitest'

import { imageExportDirectory } from './export-directory.js'

describe('system Downloads export location', () => {
  it('uses the macOS Downloads folder returned by the system', async () => {
    expect(
      await imageExportDirectory({
        platform: 'darwin',
        homeDirectory: '/Users/seller',
        query: async () => '/Volumes/Photos/Downloads/\n',
      }),
    ).toBe('/Volumes/Photos/Downloads/Nexus AI')
  })

  it('respects a relocated Windows Downloads folder with spaces and non-ASCII characters', async () => {
    expect(
      await imageExportDirectory({
        platform: 'win32',
        homeDirectory: 'C:\\Users\\seller',
        query: async () => 'D:\\商品图片\\My Downloads\r\n',
      }),
    ).toBe('D:\\商品图片\\My Downloads\\Nexus AI')
  })

  it('accepts a Windows network Downloads folder', async () => {
    expect(
      await imageExportDirectory({
        platform: 'win32',
        homeDirectory: 'C:\\Users\\seller',
        query: async () => '\\\\server\\seller\\Downloads\r\n',
      }),
    ).toBe('\\\\server\\seller\\Downloads\\Nexus AI')
  })

  it.each([
    ['darwin', '/Users/seller', '/Users/seller/Downloads/Nexus AI'],
    ['win32', 'C:\\Users\\seller', 'C:\\Users\\seller\\Downloads\\Nexus AI'],
    ['linux', '/home/seller', '/home/seller/Downloads/Nexus AI'],
  ] as const)(
    'falls back to the user Downloads folder on %s when lookup is unavailable',
    async (platform, homeDirectory, expected) => {
      expect(
        await imageExportDirectory({
          platform,
          homeDirectory,
          query: async () => {
            throw new Error('System lookup unavailable')
          },
        }),
      ).toBe(expected)
    },
  )

  it.each(['', 'Downloads', 'C:relative', '/tmp/one\n/tmp/two'])(
    'rejects an invalid system path: %j',
    async (response) => {
      expect(
        await imageExportDirectory({
          platform: 'win32',
          homeDirectory: 'C:\\Users\\seller',
          query: async () => response,
        }),
      ).toBe('C:\\Users\\seller\\Downloads\\Nexus AI')
    },
  )
})
