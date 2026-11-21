import { Button } from '@proxyshard/shardx-ui-kit'
import { RECORD_KINDS, type RecordKind } from '../../../raccoon/plugins/ai-image/types'
import { RefreshIcon } from '../../../shared/icons'
import { PluginFilterRow, PluginSearch } from '../PluginFilterRow'
import { AiSelect } from './fields'

export function HistoryFilters({
  query,
  status,
  kind,
  pageShortcut,
  onQuery,
  onStatus,
  onKind,
  onRefresh,
}: {
  query: string
  status: string
  kind: RecordKind | 'all'
  pageShortcut: boolean
  onQuery: (value: string) => void
  onStatus: (value: string) => void
  onKind: (value: RecordKind | 'all') => void
  onRefresh: () => void
}) {
  return (
    <PluginFilterRow label="批次筛选条件">
      <PluginSearch
        pageShortcut={pageShortcut}
        className="border border-stroke-soft-200"
        label="搜索批次"
        placeholder="商品、提示词、批次或模型"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
      />
      <AiSelect
        className="w-[144px]!"
        label="任务状态"
        value={status}
        onChange={onStatus}
        options={[
          { value: 'all', label: '全部状态' },
          { value: 'queued', label: '排队中' },
          { value: 'running', label: '执行中' },
          { value: 'success', label: '已生成' },
          { value: 'failed', label: '失败 / 部分完成' },
        ]}
      />
      <AiSelect
        className="w-[128px]!"
        label="批次类型"
        value={kind}
        onChange={(value) => onKind(value as RecordKind | 'all')}
        options={RECORD_KINDS}
      />
      <Button
        size="xsmall"
        mode="stroke"
        variant="neutral"
        leftIcon={<RefreshIcon className="size-3.5" />}
        onClick={onRefresh}
      >
        刷新
      </Button>
    </PluginFilterRow>
  )
}
