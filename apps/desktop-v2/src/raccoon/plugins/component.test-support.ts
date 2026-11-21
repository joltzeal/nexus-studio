import {
  Children,
  isValidElement,
  type DependencyList,
  type EffectCallback,
  type JSXElementConstructor,
  type ReactElement,
  type ReactNode,
} from 'react'

export class ComponentHooks {
  private values: unknown[] = []
  private cursor = 0
  private effectCursor = 0
  private effects: { deps: DependencyList | undefined; cleanup?: () => void }[] = []
  private queued: (() => void)[] = []

  state(initial: unknown): [unknown, (next: unknown) => void] {
    const index = this.cursor++
    if (index === this.values.length)
      this.values.push(typeof initial === 'function' ? initial() : initial)
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
      deps.length === previous.deps.length &&
      deps.every((value, i) => Object.is(value, previous.deps?.[i]))
    )
      return
    previous?.cleanup?.()
    const effect: (typeof this.effects)[number] = { deps }
    this.effects[index] = effect
    this.queued.push(() => {
      const cleanup = callback()
      if (typeof cleanup === 'function') effect.cleanup = cleanup
    })
  }
  render<T>(component: () => T): T {
    this.cursor = 0
    this.effectCursor = 0
    return component()
  }
  flush() {
    for (const effect of this.queued.splice(0)) effect()
  }
  dispose() {
    for (const effect of this.effects) effect.cleanup?.()
  }
}

export function components<P>(
  node: ReactNode,
  type: JSXElementConstructor<P>,
): ReactElement<P>[] {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return []
    return [
      ...(child.type === type ? [child as ReactElement<P>] : []),
      ...components(child.props.children, type),
    ]
  })
}
export async function flushPromises() {
  for (let index = 0; index < 10; index++) await Promise.resolve()
}
