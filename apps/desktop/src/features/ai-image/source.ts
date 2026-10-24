import type { GenerationSource } from '@/lib/page-handoff'
import { message } from './types'

export type SourceIdentity = Pick<GenerationSource, 'pluginId' | 'itemId'>

export const SOURCE_UPDATE_HINT =
  '当前 AI 生图插件不支持商品来源关联，请到插件中心更新 AI 生图插件后重试。'

function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new Error('商品来源信息无效或超过长度限制，请返回商品页重新选择。')
  }
  return value.trim()
}

export function sourceIdentity(source: SourceIdentity): SourceIdentity {
  return {
    pluginId: boundedText(source.pluginId, 128),
    itemId: boundedText(source.itemId, 128),
  }
}

/** Display and RPC boundary validation; source text is never a prompt. */
export function generationSource(source: GenerationSource): GenerationSource {
  const identity = sourceIdentity(source)
  const title = boundedText(source.title, 500)
  const url = boundedText(source.url, 2048)
  if (safeSourceUrl(url) === null) {
    throw new Error('商品来源链接必须为不含账号密码的 http(s) 地址。')
  }
  return { ...identity, title, url }
}

export function safeSourceUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname !== '' &&
      url.username === '' &&
      url.password === ''
      ? url.href
      : null
  } catch {
    return null
  }
}

export function sourceRequestError(error: unknown): Error {
  const text = message(error)
  if (/INVALID_REQUEST|请求参数无效|未声明该方法|不支持该方法/.test(text)) {
    return new Error(SOURCE_UPDATE_HINT)
  }
  return new Error(text)
}
