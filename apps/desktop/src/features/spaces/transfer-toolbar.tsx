import { useState } from 'react'
import { Download, Radio, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { BrowserConnection } from '@/lib/platform/browser-connections'
import type { BrowserWindow } from '@/lib/platform/windows'
import { FileTransferDialog } from './file-transfer-dialog'
import { WindowSyncDialog } from './window-sync-dialog'
import { selectionError } from './transfer-state'

export function TransferToolbar({
  native,
  connection,
  windows,
  operating,
  onImported,
  onClear,
}: {
  native: boolean
  connection: BrowserConnection | null
  windows: BrowserWindow[]
  operating: ReadonlySet<string>
  onImported: () => Promise<void>
  onClear: () => void
}) {
  const [active, setActive] = useState<'export' | 'import' | 'sync' | null>(null)
  const [syncOpened, setSyncOpened] = useState(false)
  const unsupported = windows.some((window) => window.providerId !== 'cloakbrowser')
    ? selectionError(windows, operating)
    : !connection
      ? '请先启用浏览器接入。'
      : connection.providerId !== 'cloakbrowser'
        ? '此接入不支持完整迁移，请使用官方浏览器的同步功能。'
        : !connection.capabilities.transfer
          ? '此接入不支持完整迁移。'
          : null
  const issue = unsupported ?? selectionError(windows, operating)
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="窗口迁移">
      <span className="result-count">已选 {windows.length}</span>
      {windows.length ? (
        <Button variant="ghost" size="sm" onClick={onClear}>
          清除选择
        </Button>
      ) : null}
      <Button
        variant="outline"
        disabled={!native || issue !== null}
        title={issue ?? '导出已选窗口的加密快照'}
        onClick={() => setActive('export')}
      >
        <Upload data-icon="inline-start" />
        导出
      </Button>
      <Button
        variant="outline"
        disabled={!native || unsupported !== null}
        title={unsupported ?? '导入内置浏览器的加密快照'}
        onClick={() => setActive('import')}
      >
        <Download data-icon="inline-start" />
        导入
      </Button>
      <Button
        variant="outline"
        disabled={!native || unsupported !== null}
        title={unsupported ?? undefined}
        onClick={() => {
          setSyncOpened(true)
          setActive('sync')
        }}
      >
        <Radio data-icon="inline-start" />
        设备同步
      </Button>
      {unsupported ? (
        <p className="text-xs text-muted-foreground" role="status">
          {unsupported}
        </p>
      ) : null}
      {native && (active === 'export' || active === 'import') ? (
        <FileTransferDialog
          key={active}
          kind={active}
          windows={windows}
          operating={operating}
          onImported={onImported}
          onClose={() => setActive(null)}
        />
      ) : null}
      {native && syncOpened ? (
        <WindowSyncDialog
          open={active === 'sync'}
          windows={windows}
          operating={operating}
          onImported={onImported}
          onClose={() => setActive(null)}
        />
      ) : null}
    </div>
  )
}
