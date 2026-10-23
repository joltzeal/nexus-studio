import { useState } from 'react'
import { Download, Radio, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { NativeProfile } from '@/lib/platform/native-profiles'
import { FileTransferDialog } from './file-transfer-dialog'
import { WindowSyncDialog } from './window-sync-dialog'
import { selectionError } from './transfer-state'

export function TransferToolbar({
  native,
  windows,
  operating,
  onImported,
  onClear,
}: {
  native: boolean
  windows: NativeProfile[]
  operating: ReadonlySet<string>
  onImported: () => Promise<void>
  onClear: () => void
}) {
  const [active, setActive] = useState<'export' | 'import' | 'sync' | null>(null)
  const [syncOpened, setSyncOpened] = useState(false)
  const issue = selectionError(windows, operating)
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
      <Button variant="outline" disabled={!native} onClick={() => setActive('import')}>
        <Download data-icon="inline-start" />
        导入
      </Button>
      <Button
        variant="outline"
        disabled={!native}
        onClick={() => {
          setSyncOpened(true)
          setActive('sync')
        }}
      >
        <Radio data-icon="inline-start" />
        设备同步
      </Button>
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
