import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AgentSettingsSchema, type AgentSettings } from '@nexus/plugin-sdk/agent'
import { AgentFailure } from '../errors.js'

const DocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  settings: AgentSettingsSchema.nullable(),
})

export interface SettingsStore {
  readonly durable?: boolean
  read(): Promise<AgentSettings | null>
  save(input: unknown, assertAlive?: () => void): Promise<AgentSettings>
  clear(assertAlive?: () => void): Promise<void>
}

export function createSettingsStore(directory: string): SettingsStore {
  const path = join(directory, 'settings.json')
  let tail: Promise<unknown> = Promise.resolve()
  const queue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work)
    tail = result.catch(() => {})
    return result
  }
  const persist = async (
    settings: AgentSettings | null,
    assertAlive: () => void,
  ): Promise<void> => {
    assertAlive()
    const temporary = join(directory, `.settings-${randomUUID()}.tmp`)
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(JSON.stringify({ schemaVersion: 1, settings }))
        await file.sync()
      } finally {
        await file.close()
      }
      assertAlive()
      await rename(temporary, path)
    } catch (error) {
      if (error instanceof AgentFailure) throw error
      throw new AgentFailure('STORAGE_ERROR', 'Ecom Agent 设置保存失败，原设置仍然保留')
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
    }
  }
  return {
    durable: true,
    read: () =>
      queue(async () => {
        try {
          const metadata = await stat(path)
          if (!metadata.isFile() || metadata.size > 128 * 1024)
            throw new Error('invalid settings file')
          const document = DocumentSchema.parse(JSON.parse(await readFile(path, 'utf8')))
          return document.settings
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return null
          throw new AgentFailure(
            'STORAGE_ERROR',
            '无法读取Ecom Agent 设置，请检查本地文件',
          )
        }
      }),
    save: (input, assertAlive = () => {}) =>
      queue(async () => {
        const parsed = AgentSettingsSchema.safeParse(input)
        if (!parsed.success)
          throw new AgentFailure('INVALID_REQUEST', '请完整填写决策模型和生成模型配置')
        await persist(parsed.data, assertAlive)
        return parsed.data
      }),
    clear: (assertAlive = () => {}) => queue(() => persist(null, assertAlive)),
  }
}
