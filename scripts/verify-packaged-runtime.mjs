import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePackagedRuntime, verifyPackagedRuntime } from './lib/packaged-runtime.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const defaultBundle =
  process.platform === 'darwin'
    ? resolve(root, 'apps/desktop/src-tauri/target/release/bundle/macos/Nexus.app')
    : resolve(root, 'apps/desktop/src-tauri/target/release')
const bundlePath = resolve(process.argv[2] ?? defaultBundle)
const paths = resolvePackagedRuntime({ platform: process.platform, bundlePath })

verifyPackagedRuntime(paths)
console.log(`Verified packaged runtime: ${paths.node}`)
