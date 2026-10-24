/** Share the plugin's four download slots across gallery and AI consumers. */
export class ImageTransferQueue {
  private readonly waiting: (() => void)[] = []
  private active = 0

  run<T>(signal: AbortSignal, transfer: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        const index = this.waiting.indexOf(start)
        if (index < 0) return
        this.waiting.splice(index, 1)
        reject(signal.reason)
      }
      const start = () => {
        signal.removeEventListener('abort', cancel)
        if (signal.aborted) {
          reject(signal.reason)
          return
        }
        this.active += 1
        void Promise.resolve()
          .then(() => {
            signal.throwIfAborted()
            return transfer()
          })
          .then(resolve, reject)
          .finally(() => {
            // Aborting a WebView request cannot cancel an in-flight native IPC.
            // Keep its slot until the transfer has actually finished closing.
            this.active -= 1
            this.pump()
          })
      }
      signal.addEventListener('abort', cancel, { once: true })
      this.waiting.push(start)
      this.pump()
    })
  }

  private pump(): void {
    while (this.active < 4 && this.waiting.length > 0) this.waiting.shift()?.()
  }
}
