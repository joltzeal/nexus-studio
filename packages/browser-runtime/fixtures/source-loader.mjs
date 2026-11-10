import { registerHooks } from 'node:module'

const source = new URL('../src/', import.meta.url).href

registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier.startsWith('.') &&
      specifier.endsWith('.js') &&
      context.parentURL?.startsWith(source)
    ) {
      return next(`${specifier.slice(0, -3)}.ts`, context)
    }
    return next(specifier, context)
  },
})
