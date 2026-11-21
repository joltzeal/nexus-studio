import { message, type GenerationRecord } from './types'

interface RecordCallbacks {
  onRecord: (record: GenerationRecord) => void
  onError: (error: string) => void
  onSettled: () => void | Promise<void>
}

function running(record: GenerationRecord | null): boolean {
  return record?.status === 'running' || record?.outputVision?.status === 'running'
}

/** Reads are sequential; each user action invalidates earlier read/action results. */
export class RecordSession {
  private revision = 0
  private recordId: string | null = null
  private record: GenerationRecord | null = null
  private callbacks: RecordCallbacks | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private readingRevision: number | undefined

  constructor(
    private readonly get: (id: string) => Promise<{ record: GenerationRecord }>,
  ) {}

  open(id: string, callbacks: RecordCallbacks): Promise<void> {
    this.close()
    this.recordId = id
    this.callbacks = callbacks
    return this.read(this.revision)
  }

  close() {
    this.beginAction()
    this.recordId = null
    this.record = null
    this.callbacks = null
  }

  beginAction(): number {
    this.revision += 1
    clearTimeout(this.timer)
    this.timer = undefined
    return this.revision
  }

  isCurrent(revision: number): boolean {
    return revision === this.revision && this.callbacks !== null
  }

  accept(revision: number, record: GenerationRecord): boolean {
    if (!this.isCurrent(revision)) return false
    if (record.id !== this.recordId) throw new Error('读取到其他生成记录，请重新读取。')
    this.record = record
    this.callbacks?.onRecord(record)
    return this.isCurrent(revision)
  }

  refresh(): Promise<void> {
    return this.read(this.beginAction())
  }

  resume(revision: number) {
    if (
      !this.isCurrent(revision) ||
      this.readingRevision === revision ||
      !running(this.record)
    )
      return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.read(revision)
    }, 2500)
  }

  private async read(revision: number): Promise<void> {
    if (
      !this.isCurrent(revision) ||
      this.recordId === null ||
      this.readingRevision === revision
    )
      return
    this.readingRevision = revision
    try {
      const result = await this.get(this.recordId)
      if (!this.isCurrent(revision)) return
      const wasRunning = running(this.record)
      if (this.accept(revision, result.record) && wasRunning && !running(result.record)) {
        await this.callbacks?.onSettled()
      }
    } catch (cause) {
      if (this.isCurrent(revision)) this.callbacks?.onError(message(cause))
    } finally {
      if (this.readingRevision === revision) this.readingRevision = undefined
      this.resume(revision)
    }
  }
}
