export class CodexConfigMutationQueue {
  private tail: Promise<void> = Promise.resolve()

  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}
