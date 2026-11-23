export const PLUGIN_CARD_PATTERN = /^RAC-[A-Z0-9]{16,32}$/i
export const PLUGIN_CARD_MAX_LENGTH = 36

export function validatePluginCard(value: string): string | null {
  const card = value.trim()
  if (!card) return '请输入激活码'
  if (card.length > PLUGIN_CARD_MAX_LENGTH || !PLUGIN_CARD_PATTERN.test(card)) {
    return '格式无效，请输入 RAC- 开头、后接 16–32 位字母或数字的激活码'
  }
  return null
}

export function normalizePluginCard(value: string): string {
  const error = validatePluginCard(value)
  if (error) throw new Error(error)
  return value.trim().toUpperCase()
}
