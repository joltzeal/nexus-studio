import type {
  AvailabilityStatus,
  FavouriteOperator,
  ItemFilters,
  ItemOrder,
} from './types'

export interface FilterDraft {
  monitorId: string
  keyword: string
  externalId: string
  availabilityStatus: string
  starred: string
  favouriteCountOp: string
  favouriteCount: string
  favouriteCountEnd: string
}

export const EMPTY_FILTERS: FilterDraft = {
  monitorId: '',
  keyword: '',
  externalId: '',
  availabilityStatus: '',
  starred: '',
  favouriteCountOp: '',
  favouriteCount: '',
  favouriteCountEnd: '',
}

export const FAVOURITE_OPERATORS: { value: FavouriteOperator; label: string }[] = [
  { value: 'eq', label: '等于' },
  { value: 'ne', label: '不等于' },
  { value: 'gt', label: '大于' },
  { value: 'ge', label: '大于等于' },
  { value: 'lt', label: '小于' },
  { value: 'le', label: '小于等于' },
  { value: 'between', label: '介于' },
  { value: 'isNull', label: '未提供' },
  { value: 'notNull', label: '已提供' },
]

function count(value: string): number {
  if (!/^\d+$/.test(value.trim())) throw new Error('点赞数需要填写非负整数')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error('点赞数超出范围')
  return parsed
}

export function itemFilterParams(draft: FilterDraft): ItemFilters {
  const result: ItemFilters = {}
  if (draft.monitorId) result.monitorId = draft.monitorId
  if (draft.keyword.trim()) result.keyword = draft.keyword.trim()
  if (draft.externalId.trim()) {
    if (!/^\d{1,32}$/.test(draft.externalId.trim()))
      throw new Error('来源商品 ID 需要填写最多 32 位数字')
    result.externalId = draft.externalId.trim()
  }
  if (draft.availabilityStatus)
    result.availabilityStatus = draft.availabilityStatus as AvailabilityStatus
  if (draft.starred) result.starred = draft.starred === 'true'
  if (draft.favouriteCountOp) {
    const op = FAVOURITE_OPERATORS.find(
      (entry) => entry.value === draft.favouriteCountOp,
    )?.value
    if (!op) throw new Error('点赞数筛选方式无效')
    result.favouriteCountOp = op
    if (op === 'between') {
      const start = draft.favouriteCount.trim() ? count(draft.favouriteCount) : undefined
      const end = draft.favouriteCountEnd.trim()
        ? count(draft.favouriteCountEnd)
        : undefined
      if (start === undefined && end === undefined)
        throw new Error('请至少填写一个点赞数区间边界')
      if (start !== undefined && end !== undefined && start > end)
        throw new Error('点赞数下限不能大于上限')
      if (start !== undefined) result.favouriteCountStart = start
      if (end !== undefined) result.favouriteCountEnd = end
    } else if (op !== 'isNull' && op !== 'notNull') {
      result.favouriteCount = count(draft.favouriteCount)
    }
  }
  return result
}

export function nextFavouriteOrder(order: ItemOrder): ItemOrder {
  return order === 'collected_desc'
    ? 'favourite_asc'
    : order === 'favourite_asc'
      ? 'favourite_desc'
      : 'collected_desc'
}

export function safeExternalUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

const COUNTRIES: Record<string, string> = {
  com: '美国',
  'co.uk': '英国',
  fr: '法国',
  de: '德国',
  pl: '波兰',
  at: '奥地利',
  be: '比利时',
  cz: '捷克',
  dk: '丹麦',
  es: '西班牙',
  fi: '芬兰',
  gr: '希腊',
  hr: '克罗地亚',
  hu: '匈牙利',
  it: '意大利',
  lt: '立陶宛',
  lu: '卢森堡',
  nl: '荷兰',
  pt: '葡萄牙',
  ro: '罗马尼亚',
  se: '瑞典',
  sk: '斯洛伐克',
}

export function sourceCountry(domain: string): string {
  return COUNTRIES[domain.replace(/^(www\.)?vinted\./, '')] ?? domain
}
