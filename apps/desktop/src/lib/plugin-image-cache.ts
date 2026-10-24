const MAX_BYTES = 32 * 1024 * 1024
const MAX_ENTRIES = 128
const IDLE_MS = 60_000

type Loader = (url: string, signal: AbortSignal) => Promise<Blob>

interface Entry {
  source: string
  refs: number
  started: boolean
  invalid: boolean
  controller: AbortController
  promise: Promise<string>
  resolve: (url: string) => void
  reject: (error: unknown) => void
  objectUrl: string | null
  bytes: number
  timer: ReturnType<typeof setTimeout> | null
}

/** Reference-counted Blob URLs with a bounded idle cache shared by all images. */
export class PluginImageCache {
  private readonly entries = new Map<string, Entry>()
  private queue: Entry[] = []
  private active = 0
  private bytes = 0

  constructor(private readonly load: Loader) {}

  acquire(source: string) {
    let entry = this.entries.get(source)
    if (entry === undefined) {
      this.makeRoom(0)
      let resolve!: Entry['resolve']
      let reject!: Entry['reject']
      const promise = new Promise<string>((done, fail) => {
        resolve = done
        reject = fail
      })
      entry = {
        source,
        refs: 0,
        started: false,
        invalid: false,
        controller: new AbortController(),
        promise,
        resolve,
        reject,
        objectUrl: null,
        bytes: 0,
        timer: null,
      }
      if (this.entries.size >= MAX_ENTRIES) {
        reject(new Error('图片请求较多，请稍后重试'))
      } else {
        this.entries.set(source, entry)
        this.queue.push(entry)
      }
    } else {
      // Map insertion order is the LRU order.
      this.entries.delete(source)
      this.entries.set(source, entry)
      if (entry.timer !== null) clearTimeout(entry.timer)
      entry.timer = null
    }
    entry.refs += 1
    const retained = entry
    this.pump()
    let released = false
    return {
      promise: entry.promise,
      release: () => {
        if (released) return
        released = true
        retained.refs -= 1
        if (retained.refs !== 0) return
        if (retained.objectUrl === null) {
          retained.controller.abort()
          if (!retained.started) {
            this.queue = this.queue.filter((item) => item !== retained)
            retained.reject(new DOMException('Image no longer visible', 'AbortError'))
          }
          this.remove(retained)
        } else if (retained.invalid) {
          this.remove(retained)
        } else {
          retained.timer = setTimeout(() => this.remove(retained), IDLE_MS)
        }
      },
    }
  }

  invalidate(source: string, objectUrl: string) {
    const entry = this.entries.get(source)
    if (entry?.objectUrl !== objectUrl) return
    entry.invalid = true
    this.entries.delete(source)
    if (entry.refs === 0) this.remove(entry)
  }

  /** Used on page refresh/unmount; URLs still displayed by another consumer stay alive. */
  clearUnused() {
    for (const entry of this.entries.values()) {
      if (entry.refs === 0) this.remove(entry)
    }
  }

  private remove(entry: Entry) {
    if (this.entries.get(entry.source) === entry) this.entries.delete(entry.source)
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = null
    if (entry.objectUrl !== null) {
      URL.revokeObjectURL(entry.objectUrl)
      this.bytes -= entry.bytes
      entry.objectUrl = null
      entry.bytes = 0
    }
  }

  private makeRoom(incoming: number) {
    for (const entry of this.entries.values()) {
      if (this.bytes + incoming <= MAX_BYTES && this.entries.size < MAX_ENTRIES) break
      if (entry.refs === 0) this.remove(entry)
    }
  }

  private pump() {
    while (this.active < 4 && this.queue.length > 0) {
      const entry = this.queue.shift()!
      entry.started = true
      this.active += 1
      void this.run(entry)
    }
  }

  private async run(entry: Entry) {
    try {
      const blob = await this.load(entry.source, entry.controller.signal)
      entry.controller.signal.throwIfAborted()
      this.makeRoom(blob.size)
      if (this.bytes + blob.size > MAX_BYTES) throw new Error('图片缓存已满，请稍后重试')
      entry.objectUrl = URL.createObjectURL(blob)
      entry.bytes = blob.size
      this.bytes += blob.size
      entry.resolve(entry.objectUrl)
    } catch (error) {
      this.remove(entry)
      entry.reject(error)
    } finally {
      this.active -= 1
      this.pump()
    }
  }
}
