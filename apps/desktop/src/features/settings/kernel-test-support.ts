import {
  Children,
  isValidElement,
  type DependencyList,
  type EffectCallback,
  type JSXElementConstructor,
  type ReactElement,
  type ReactNode,
} from 'react'
import type { KernelStatus } from '@/lib/platform/native-kernels'

// Exercise component handlers and effects without pretending to test the DOM or
// Radix focus management. Each test owns and disposes its hook lifecycle.
export class KernelHookHarness {
  private values: unknown[] = []
  private cursor = 0
  private effectCursor = 0
  private effects: {
    deps: DependencyList | undefined
    callback: EffectCallback
    cleanup?: () => void
  }[] = []
  private queued: number[] = []

  constructor(private readonly context: { hooks: KernelHookHarness | null }) {}

  state(initial: unknown): [unknown, (next: unknown) => void] {
    const index = this.cursor++
    if (index === this.values.length) {
      this.values.push(typeof initial === 'function' ? initial() : initial)
    }
    return [
      this.values[index],
      (next) => {
        this.values[index] = typeof next === 'function' ? next(this.values[index]) : next
      },
    ]
  }

  effect(callback: EffectCallback, deps?: DependencyList) {
    const index = this.effectCursor++
    const previous = this.effects[index]
    if (
      previous?.deps &&
      deps &&
      previous.deps.length === deps.length &&
      deps.every((value, i) => Object.is(value, previous.deps?.[i]))
    ) {
      return
    }
    previous?.cleanup?.()
    this.effects[index] = { callback, deps }
    this.queued.push(index)
  }

  render<T>(component: () => T): T {
    this.cursor = 0
    this.effectCursor = 0
    const previous = this.context.hooks
    this.context.hooks = this
    try {
      return component()
    } finally {
      this.context.hooks = previous
    }
  }

  flushEffects() {
    for (const index of this.queued.splice(0)) {
      const cleanup = this.effects[index]!.callback()
      if (typeof cleanup === 'function') this.effects[index]!.cleanup = cleanup
    }
  }

  dispose() {
    for (const effect of this.effects) effect.cleanup?.()
  }
}

export function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child)
      ? [child, ...elements(child.props.children as ReactNode)]
      : [],
  )
}

export function components<P>(tree: ReactNode, type: JSXElementConstructor<P>) {
  return elements(tree).filter((node) => node.type === type) as ReactElement<P>[]
}

export function text(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? text(child.props.children)
        : String(child),
    )
    .join('')
}

export function kernelStatus(versions: string[] = ['155.0.8059.39.2']): KernelStatus {
  return {
    cacheDir: '/synthetic/kernels',
    platform: 'darwin-arm64',
    activationConfigured: true,
    installed: versions.map((version) => ({
      version,
      binaryPath: `/synthetic/kernels/chromium-${version}-pro/browser`,
    })),
    download: {
      phase: 'idle',
      version: null,
      requestedVersion: null,
      percent: null,
      downloadedMb: null,
      totalMb: null,
      attempt: null,
      error: null,
    },
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

export async function flushPromises() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}
