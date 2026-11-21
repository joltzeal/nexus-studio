export class ImageOwners {
  private owners = new Map<string, number>()

  constructor(private readonly release: (id: string) => void) {}

  retain(id: string): () => void {
    this.owners.set(id, (this.owners.get(id) ?? 0) + 1)
    let retained = true
    return () => {
      if (!retained) return
      retained = false
      const count = (this.owners.get(id) ?? 1) - 1
      if (count > 0) this.owners.set(id, count)
      else {
        this.owners.delete(id)
        this.release(id)
      }
    }
  }
}
