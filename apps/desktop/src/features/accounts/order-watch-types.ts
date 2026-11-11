export interface OrderWatchSettings {
  intervalMinutes: number
  bark: {
    baseUrl: string
    deviceKey: string
    enabled: boolean
  }
}

export interface OrderCandidate {
  id: string
  itemId: string
  itemUrl: string
  title: string
  imageUrl: string | null
  lastSeenAt: string | null
  missingAt: string
  checkedAt: string | null
  status: 'pending' | 'sold' | 'reappeared'
  checkError: string | null
  notifiedAt: string | null
  notifyError: string | null
}

export interface OrderWatchView {
  accountId: string
  homepageUrl: string
  enabled: boolean
  running: boolean
  lastCompleteAt: string | null
  lastItemCount: number | null
  lastError: string | null
  nextRunAt: string | null
  pendingCount?: number
  soldCount?: number
  candidates: OrderCandidate[]
}
