const KEY = 'raccoon.ai-image.pending-product-imports.v1'

interface StoragePort {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface ImportDependencies {
  storage: StoragePort
  getRecord: (id: string) => Promise<{ record: { status: string } }>
  importProduct: (id: string) => Promise<{ alreadyImported: boolean }>
  notify: (message: string, retry?: () => void) => void
}

export class AutoProductImport {
  private ids: string[]
  private checking = false
  private failed = new Set<string>()

  constructor(private readonly deps: ImportDependencies) {
    try {
      const parsed: unknown = JSON.parse(deps.storage.getItem(KEY) ?? '[]')
      this.ids = Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : []
    } catch {
      this.ids = []
    }
  }

  pending(): string[] {
    return [...this.ids]
  }

  track(id: string): void {
    if (!this.ids.includes(id)) {
      const next = [...this.ids, id]
      this.deps.storage.setItem(KEY, JSON.stringify(next))
      this.ids = next
      return
    }
  }

  async check(): Promise<void> {
    if (this.checking) return
    this.checking = true
    try {
      for (const id of [...this.ids]) {
        if (this.failed.has(id)) continue
        try {
          const { record } = await this.deps.getRecord(id)
          if (record.status === 'running') continue
          if (record.status === 'success') {
            await this.deps.importProduct(id)
          } else if (record.status !== 'failed') continue
          const next = this.ids.filter((entry) => entry !== id)
          this.deps.storage.setItem(KEY, JSON.stringify(next))
          this.ids = next
          if (record.status === 'success') this.deps.notify('图片已生成并加入商品库。')
        } catch (error) {
          this.failed.add(id)
          this.deps.notify(
            `图片生成任务 ${id} 尚未入库：${error instanceof Error ? error.message : '请稍后重试'}`,
            () => {
              this.failed.delete(id)
              void this.check()
            },
          )
        }
      }
    } finally {
      this.checking = false
    }
  }
}
