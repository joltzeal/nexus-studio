import { availableToWindow, type ProxyUsageState } from './proxy-usage'
import { matchesProxyQuery, type ProxyRow } from './types'

export function visibleProxyRows(
  rows: readonly ProxyRow[],
  query: string,
  onlyAvailable: boolean,
  endpointId: number | null,
  usage: ProxyUsageState,
): ProxyRow[] {
  return rows
    .filter(
      (row) =>
        (row.id === String(endpointId) || matchesProxyQuery(row, query)) &&
        (!onlyAvailable ||
          row.id === String(endpointId) ||
          availableToWindow(usage, row.id)),
    )
    .sort(
      (a, b) => Number(b.id === String(endpointId)) - Number(a.id === String(endpointId)),
    )
}
