import { existsSync, readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire, registerHooks } from 'node:module'

const require = createRequire(import.meta.url)
const typescript = require('typescript')
const workspaceRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)))

function workspaceTypeScriptPath(specifier) {
  const sdkEntries = new Map([
    ['@nexus/plugin-sdk', 'index.ts'],
    ['@nexus/plugin-sdk/agent', 'agent.ts'],
    ['@nexus/plugin-sdk/configuration', 'configuration.ts'],
    ['@nexus/plugin-sdk/lifecycle', 'lifecycle.ts'],
    ['@nexus/plugin-sdk/ui', 'ui.ts'],
  ])
  const sdkEntry = sdkEntries.get(specifier)
  if (sdkEntry) return resolve(workspaceRoot, 'packages/plugin-sdk/src', sdkEntry)

  const contractsPrefix = '@nexus/plugin-contracts/'
  if (specifier.startsWith(contractsPrefix)) {
    return resolve(
      workspaceRoot,
      'packages/plugin-contracts/src',
      `${specifier.slice(contractsPrefix.length)}.ts`,
    )
  }
  return null
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const sourcePath = workspaceTypeScriptPath(specifier)
    if (sourcePath && existsSync(sourcePath)) {
      return nextResolve(pathToFileURL(sourcePath).href, context)
    }

    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (
        error?.code !== 'ERR_MODULE_NOT_FOUND' ||
        !specifier.endsWith('.js') ||
        !context.parentURL?.startsWith('file:')
      ) {
        throw error
      }

      const javascriptPath = fileURLToPath(new URL(specifier, context.parentURL))
      const typescriptPath = `${javascriptPath.slice(0, -extname(javascriptPath).length)}.ts`
      if (existsSync(javascriptPath) || !existsSync(typescriptPath)) throw error
      return nextResolve(pathToFileURL(resolve(typescriptPath)).href, context)
    }
  },
  load(url, context, nextLoad) {
    if (!url.startsWith('file:') || !url.endsWith('.ts')) return nextLoad(url, context)
    const source = readFileSync(fileURLToPath(url), 'utf8')
    const transformed = typescript.transpileModule(source, {
      compilerOptions: {
        target: typescript.ScriptTarget.ES2022,
        module: typescript.ModuleKind.ESNext,
        moduleResolution: typescript.ModuleResolutionKind.Bundler,
        verbatimModuleSyntax: true,
      },
      fileName: fileURLToPath(url),
      reportDiagnostics: false,
    })
    return { format: 'module', source: transformed.outputText, shortCircuit: true }
  },
})
