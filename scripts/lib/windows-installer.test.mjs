import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const directory = resolve(root, 'apps/desktop/src-tauri/installers')
const template = readFileSync(resolve(directory, 'windows.nsi'), 'utf8')
const provenance = () => readFileSync(resolve(directory, 'README.md'), 'utf8')
const cliVersion = '2.12.3'
const sourceCommit = '59b63ab500da9859f12d8888c3298bc29bba0b92'
const sourceUrl =
  `https://raw.githubusercontent.com/tauri-apps/tauri/${sourceCommit}/` +
  'crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi'
const upstreamSha256 = '8ae02c66f8adb4a0d15d97f984fbacd2b44262d8a4d03fefaf6177f67f7008e5'
// Identity fields read with git show HEAD before the rename; keep shallow CI checkouts offline.
const baseline = {
  revision: '401fe87b894224d8e3afa8c64d817631e785608f',
  productName: 'Nexus',
  identifier: 'com.nexusstudio.desktop',
  publisher: null,
  authors: ['Nexus Studio'],
}
// The pinned NSIS bundler uses publisher, then the second identifier component, not authors.
const baselineManufacturer = baseline.publisher ?? baseline.identifier.split('.')[1]
const baselineUninstallKey = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${baseline.productName}`
const baselineProductKey = `Software\\${baselineManufacturer}\\${baseline.productName}`
const identityPatch = [
  {
    name: 'UNINSTKEY',
    upstream:
      '!define UNINSTKEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCTNAME}"',
    patched: `!define UNINSTKEY "${baselineUninstallKey}"`,
  },
  {
    name: 'MANUPRODUCTKEY',
    upstream: '!define MANUPRODUCTKEY "${MANUKEY}\\${PRODUCTNAME}"',
    patched: `!define MANUPRODUCTKEY "${baselineProductKey}"`,
  },
]

function definition(script, name) {
  const matches = [...script.matchAll(new RegExp(`^!define ${name} "(.*)"$`, 'gm'))]
  if (matches.length !== 1) throw new Error(`Expected one definition of ${name}`)
  return matches[0][1]
}

function upstreamFingerprint(script) {
  let normalized = script.replaceAll('\r\n', '\n')
  for (const { name, upstream, patched } of identityPatch) {
    if (`!define ${name} "${definition(normalized, name)}"` !== patched) {
      throw new Error(`Unexpected identity patch for ${name}`)
    }
    normalized = normalized.replace(patched, upstream)
  }
  return createHash('sha256').update(normalized).digest('hex')
}

function functionBody(name) {
  const body = template.split(`Function ${name}\n`)[1]?.split('FunctionEnd')[0]
  if (body === undefined) throw new Error(`Missing NSIS function ${name}`)
  return body
}

// Expand only the five scalar identity definitions, without executing NSIS.
function identities(productName, manufacturer) {
  const names = ['MANUFACTURER', 'PRODUCTNAME', 'UNINSTKEY', 'MANUKEY', 'MANUPRODUCTKEY']
  const values = {}
  for (const name of names) {
    values[name] = definition(template, name)
      .replaceAll('{{product_name}}', productName)
      .replaceAll('{{manufacturer}}', manufacturer)
      .replace(/\$\{(\w+)\}/g, (_, reference) => {
        if (values[reference] === undefined) {
          throw new Error(`Unresolved identity reference ${reference}`)
        }
        return values[reference]
      })
  }
  return values
}

describe('vendored Windows NSIS installer', () => {
  it('derives the previous identity from the recorded pre-rename Git HEAD configuration', () => {
    expect(baseline.productName).toBe('Nexus')
    expect(baseline.authors).toEqual(['Nexus Studio'])
    expect(baseline.publisher).toBeNull()
    expect(baselineManufacturer).toBe('nexusstudio')
    expect(baselineUninstallKey).toBe(
      'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Nexus',
    )
    expect(baselineProductKey).toBe('Software\\nexusstudio\\Nexus')
    expect(`${baseline.productName}.lnk`).toBe('Nexus.lnk')
    expect(provenance()).toContain(baseline.revision)
  })

  it('pins the template to the CLI version declared in the package and lockfile', () => {
    const desktop = JSON.parse(
      readFileSync(resolve(root, 'apps/desktop/package.json'), 'utf8'),
    )
    const lockfile = readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8')
    expect(desktop.devDependencies['@tauri-apps/cli']).toBe(cliVersion)
    expect(lockfile).toMatch(
      /'@tauri-apps\/cli':\r?\n\s+specifier: 2\.12\.3\r?\n\s+version: 2\.12\.3(?:\r?\n|$)/,
    )
  })

  it('reconstructs the exact official template by reversing only the two key definitions', () => {
    expect(upstreamFingerprint(template)).toBe(upstreamSha256)
    expect(upstreamFingerprint(template.replaceAll('\n', '\r\n'))).toBe(upstreamSha256)
  })

  it.each([
    [
      'visible product name',
      (script) =>
        script.replace(
          '!define PRODUCTNAME "{{product_name}}"',
          '!define PRODUCTNAME "Nexus"',
        ),
    ],
    [
      'visible publisher',
      (script) =>
        script.replace(
          '!define MANUFACTURER "{{manufacturer}}"',
          '!define MANUFACTURER "Nexus Studio"',
        ),
    ],
    [
      'installation directory guard',
      (script) =>
        script.replace('${If} $INSTDIR == "${PLACEHOLDER_INSTALL_DIR}"', '${If} 1 = 1'),
    ],
    [
      'update-mode handling',
      (script) => script.replace('Goto reinst_done', 'Goto reinst_uninstall'),
    ],
    [
      'additional install command',
      (script) =>
        script.replace('Section Install\n', 'Section Install\n  ExecWait "old.exe"\n'),
    ],
  ])('detects changes outside the identity patch: %s', (_, mutate) => {
    expect(upstreamFingerprint(mutate(template))).not.toBe(upstreamSha256)
  })

  it.each(identityPatch)(
    'requires a single exact $name technical key definition',
    ({ name, patched }) => {
      expect(`!define ${name} "${definition(template, name)}"`).toBe(patched)
      expect(() => upstreamFingerprint(`${template}\n${patched}\n`)).toThrow(
        `Expected one definition of ${name}`,
      )
    },
  )

  it.each([
    [
      'authors used as product name',
      'UNINSTKEY',
      'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Nexus Studio',
    ],
    [
      'authors used as implicit manufacturer',
      'MANUPRODUCTKEY',
      'Software\\Nexus Studio\\Nexus',
    ],
  ])('rejects an incorrect historical identity: %s', (_, name, incorrect) => {
    const { patched } = identityPatch.find((patch) => patch.name === name)
    expect(() =>
      upstreamFingerprint(template.replace(patched, `!define ${name} "${incorrect}"`)),
    ).toThrow(`Unexpected identity patch for ${name}`)
  })

  it.each([
    ['Raccoon', 'Raccoon'],
    ['Future Display Name', 'Another Publisher'],
  ])(
    'keeps both prior technical keys when the display name is %s and publisher is %s',
    (productName, manufacturer) => {
      const values = identities(productName, manufacturer)
      expect(values.UNINSTKEY).toBe(baselineUninstallKey)
      expect(values.MANUPRODUCTKEY).toBe(baselineProductKey)
      expect(values.PRODUCTNAME).toBe(productName)
      expect(values.MANUFACTURER).toBe(manufacturer)
      expect(values.MANUKEY).toBe(`Software\\${manufacturer}`)
    },
  )

  it('keeps the visible name and publisher supplied by the current release', () => {
    expect(definition(template, 'PRODUCTNAME')).toBe('{{product_name}}')
    expect(definition(template, 'MANUFACTURER')).toBe('{{manufacturer}}')
    expect(template).toContain(
      'WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"',
    )
    expect(template).toContain(
      'WriteRegStr SHCTX "${UNINSTKEY}" "Publisher" "${MANUFACTURER}"',
    )
  })

  it('documents explicit Raccoon publisher and the custom template without replacing other bundle settings', () => {
    const documentedConfig = JSON.parse(provenance().match(/```json\n([\s\S]*?)\n```/)[1])
    expect(documentedConfig).toEqual({
      bundle: {
        publisher: 'Raccoon',
        windows: {
          nsis: {
            template: 'installers/windows.nsi',
            installMode: 'currentUser',
          },
        },
      },
    })
    const schema = JSON.parse(
      readFileSync(
        resolve(root, 'apps/desktop/node_modules/@tauri-apps/cli/config.schema.json'),
        'utf8',
      ),
    )
    expect(schema.definitions.NsisConfig.properties.template.type).toContain('string')
    expect(schema.definitions.BundleConfig.properties.publisher.description).toContain(
      'Defaults to the second element in the identifier string',
    )
  })

  it('uses the stable keys before initialization and maintenance detection as well as during installation', () => {
    const firstUse = template.indexOf('Function PageReinstall\n')
    for (const { patched } of identityPatch) {
      expect(template.indexOf(patched)).toBeLessThan(firstUse)
    }
    expect(functionBody('PageReinstall')).toContain(
      'ReadRegStr $R0 SHCTX "${UNINSTKEY}" ""',
    )
    expect(functionBody('RestorePreviousInstallLocation')).toContain(
      'ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""',
    )
    expect(template).toContain('WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" $INSTDIR')
    expect(template).toContain('DeleteRegKey HKCU "${UNINSTKEY}"')
  })

  it('preserves the explicit-directory guard around restoring a previous installation', () => {
    const initialization = functionBody('.onInit')
    expect(initialization).toMatch(
      /\$\{If\} \$INSTDIR == "\$\{PLACEHOLDER_INSTALL_DIR\}"[\s\S]*?Call RestorePreviousInstallLocation\s+\$\{EndIf\}/,
    )
    expect(functionBody('RestorePreviousInstallLocation')).toContain(
      'StrCmp $4 "" +2 0\n    StrCpy $INSTDIR $4',
    )
  })

  it('preserves the NSIS updater bypass of the previous uninstaller', () => {
    const maintenance = functionBody('PageLeaveReinstall')
    const bypass = '${If} $UpdateMode = 1\n    Goto reinst_done\n  ${EndIf}'
    expect(maintenance).toContain(bypass)
    expect(maintenance.indexOf(bypass)).toBeLessThan(
      maintenance.indexOf('reinst_uninstall:'),
    )
    const installation = template.split('Section Install\n')[1].split('SectionEnd')[0]
    expect(installation).not.toMatch(/\b(?:ExecWait|ExecShell|RMDir)\b/i)
  })

  it('preserves the current-user installation mode and the application data identifier', () => {
    const config = JSON.parse(
      readFileSync(resolve(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
    )
    const schema = JSON.parse(
      readFileSync(
        resolve(root, 'apps/desktop/node_modules/@tauri-apps/cli/config.schema.json'),
        'utf8',
      ),
    )
    expect(config.identifier).toBe('com.nexusstudio.desktop')
    expect(
      config.bundle.windows.nsis?.installMode ??
        schema.definitions.NsisConfig.properties.installMode.default,
    ).toBe('currentUser')
    expect(template).toContain(
      '!if "${INSTALLMODE}" == "currentUser"\n  RequestExecutionLevel user\n!endif',
    )
    expect(definition(template, 'BUNDLEID')).toBe('{{bundle_id}}')
  })

  it('records the immutable source, original digest and upstream license', () => {
    const readme = provenance()
    expect(readme).toContain(`\`tauri-cli-v${cliVersion}\``)
    expect(readme).toContain(sourceUrl)
    expect(readme).toContain(upstreamSha256)
    expect(readme).toContain('Copyright')
    expect(readme).toContain('Permission is hereby granted')
    expect(readme).toContain('installers/windows.nsi')
  })
})
