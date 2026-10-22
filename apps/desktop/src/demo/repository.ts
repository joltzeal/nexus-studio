import { DEMO_INITIAL_STATE, parseDemoState } from './model'
import type { DemoState } from './model'

export const DEMO_STORAGE_KEY = 'nexus.demo.workspace.v1'

export type DemoStorage = Pick<Storage, 'getItem' | 'setItem'>

export interface DemoRepository {
  load(): DemoState
  save(next: DemoState): DemoState
}

export function createDemoRepository(storage: DemoStorage): DemoRepository {
  function load(): DemoState {
    let raw: string | null
    try {
      raw = storage.getItem(DEMO_STORAGE_KEY)
    } catch {
      throw new Error('无法读取本地数据，请检查浏览器存储权限后重试。')
    }
    if (raw === null) return parseDemoState(DEMO_INITIAL_STATE)
    try {
      const input: unknown = JSON.parse(raw)
      return parseDemoState(input)
    } catch {
      throw new Error('本地数据格式或版本无效，原始内容已保留，请检查后重试。')
    }
  }

  return {
    load,
    save(next) {
      const validated = parseDemoState(next)
      // Recheck storage before writing: a failed read must never become a reset.
      load()
      try {
        storage.setItem(DEMO_STORAGE_KEY, JSON.stringify(validated))
      } catch {
        throw new Error(
          '未能保存本地数据，已有内容未替换，请检查存储权限或剩余容量后重试。',
        )
      }
      return validated
    },
  }
}

export function getDemoRepository(): DemoRepository {
  try {
    return createDemoRepository(window.localStorage)
  } catch {
    throw new Error('无法访问本地存储，请检查浏览器存储权限后重试。')
  }
}
