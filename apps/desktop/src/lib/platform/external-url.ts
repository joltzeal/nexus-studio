import { invoke, isTauri } from '@tauri-apps/api/core'

export function safeExternalHttpUrl(value: string | null | undefined): string | null {
  if (
    !value ||
    value.includes('\\') ||
    [...value].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  ) {
    return null
  }
  const trimmed = value.trim()
  if (!/^https?:\/\//i.test(trimmed)) return null
  try {
    const url = new URL(trimmed)
    return (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.hostname &&
      !url.username &&
      !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}

export async function openExternalUrl(value: string): Promise<void> {
  const url = safeExternalHttpUrl(value)
  if (!url) throw new Error('链接无效，仅支持不含账号密码的 HTTP(S) 地址。')
  if (isTauri()) {
    await invoke<void>('external_url_open', { url })
    return
  }
  // Keep the preview open synchronous with the user gesture to retain activation.
  window.open(url, '_blank', 'noopener,noreferrer')
}
