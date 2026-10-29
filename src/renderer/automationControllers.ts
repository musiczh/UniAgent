export async function runAutomationListRequest<T>(
  request: () => Promise<T>,
  commit: (value: T) => void,
  reject: () => void,
  settle: () => void
): Promise<void> {
  try {
    commit(await request())
  } catch {
    reject()
  } finally {
    settle()
  }
}

export class AutomationMutationController {
  private active = false

  async run<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (this.active) return undefined
    this.active = true
    try {
      return await operation()
    } finally {
      this.active = false
    }
  }
}
