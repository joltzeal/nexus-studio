export type SupplyImageLease = {
  url: Promise<string>
  release: () => void
}

type Entry = {
  key: string
  refs: number
  controller: AbortController
  promise: Promise<string>
  resolve: (value: string) => void
  reject: (error: unknown) => void
  started: boolean
  settled: boolean
  objectUrl?: string
  bytes: number
  usedAt: number
}

export class SupplyImageSession {
  private readonly entries = new Map<string, Entry>()
  private readonly queue: Entry[] = []
  private active = 0
  private bytes = 0
  private disposed = false

  constructor(
    private readonly load: (url: string, signal: AbortSignal) => Promise<Blob>,
    private readonly createUrl: (blob: Blob) => string = (blob) =>
      URL.createObjectURL(blob),
    private readonly revokeUrl: (url: string) => void = (url) => URL.revokeObjectURL(url),
    private readonly now: () => number = () => Date.now(),
    private readonly maxEntries = 128,
    private readonly maxBytes = 32 * 1024 * 1024,
    private readonly maxConcurrent = 4,
    private readonly idleMs = 60_000,
  ) {}

  acquire(key: string): SupplyImageLease {
    if (this.disposed) throw new Error('图片会话已结束')
    let entry = this.entries.get(key)
    if (entry === undefined) {
      let resolve!: (value: string) => void
      let reject!: (error: unknown) => void
      const promise = new Promise<string>((accept, decline) => {
        resolve = accept
        reject = decline
      })
      entry = {
        key,
        refs: 0,
        controller: new AbortController(),
        promise,
        resolve,
        reject,
        started: false,
        settled: false,
        bytes: 0,
        usedAt: this.now(),
      }
      this.entries.set(key, entry)
      this.queue.push(entry)
    }
    entry.refs += 1
    entry.usedAt = this.now()
    this.drain()
    let released = false
    return {
      url: entry.promise,
      release: () => {
        if (released) return
        released = true
        this.release(entry!)
      },
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.entries.values()) {
      entry.controller.abort()
      this.drop(entry)
      if (!entry.settled) {
        entry.settled = true
        entry.reject(new Error('图片会话已结束'))
      }
    }
    this.entries.clear()
    this.queue.length = 0
    this.bytes = 0
  }

  private drain(): void {
    while (!this.disposed && this.active < this.maxConcurrent && this.queue.length > 0) {
      const entry = this.queue.shift()!
      if (entry.refs === 0 || this.entries.get(entry.key) !== entry) continue
      entry.started = true
      this.active += 1
      void this.load(entry.key, entry.controller.signal)
        .then((blob) => {
          if (this.disposed || entry.controller.signal.aborted || entry.refs === 0) {
            throw new Error('图片读取已取消')
          }
          const url = this.createUrl(blob)
          entry.objectUrl = url
          entry.bytes = blob.size
          this.bytes += blob.size
          this.evictIdle(entry)
          if (this.entries.get(entry.key) !== entry) throw new Error('图片缓存容量已满')
          entry.settled = true
          entry.resolve(url)
        })
        .catch((error: unknown) => {
          if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
          this.drop(entry)
          if (!entry.settled) {
            entry.settled = true
            entry.reject(error)
          }
        })
        .finally(() => {
          this.active -= 1
          this.drain()
        })
    }
  }

  private release(entry: Entry): void {
    if (entry.refs === 0) return
    entry.refs -= 1
    entry.usedAt = this.now()
    if (entry.refs > 0) return
    if (!entry.started) {
      const index = this.queue.indexOf(entry)
      if (index >= 0) this.queue.splice(index, 1)
      if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
      entry.settled = true
      entry.reject(new Error('图片读取已取消'))
      this.drain()
      return
    }
    if (!entry.settled) {
      if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
      entry.controller.abort()
    }
    this.evictIdle()
  }

  private evictIdle(protectedEntry?: Entry): void {
    const now = this.now()
    for (const entry of this.entries.values()) {
      if (
        entry !== protectedEntry &&
        entry.refs === 0 &&
        now - entry.usedAt >= this.idleMs
      ) {
        this.entries.delete(entry.key)
        this.drop(entry)
      }
    }
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const candidate = [...this.entries.values()]
        .filter((entry) => entry.refs === 0 && entry !== protectedEntry)
        .sort((left, right) => left.usedAt - right.usedAt)[0]
      if (candidate === undefined) {
        if (
          protectedEntry !== undefined &&
          this.entries.get(protectedEntry.key) === protectedEntry
        ) {
          this.entries.delete(protectedEntry.key)
          this.drop(protectedEntry)
        }
        return
      }
      this.entries.delete(candidate.key)
      this.drop(candidate)
    }
  }

  private drop(entry: Entry): void {
    if (!entry.objectUrl) return
    this.revokeUrl(entry.objectUrl)
    this.bytes -= entry.bytes
    entry.objectUrl = undefined
    entry.bytes = 0
  }
}
