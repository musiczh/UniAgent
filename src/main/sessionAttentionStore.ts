import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { atomicWriteFile } from './sessionStore'
import { parseSessionAttentionData, type SessionAttentionData } from '../shared/sessionAttention'

/** Serialized asynchronous writes keep an older snapshot from replacing a newer one. */
export class SessionAttentionStore {
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly file: string) {}

  async load(): Promise<SessionAttentionData> {
    try { return parseSessionAttentionData(JSON.parse(await readFile(this.file, 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, legacyImported: false, channels: [] }
      throw error
    }
  }

  save(data: SessionAttentionData): Promise<void> {
    const contents = JSON.stringify(data)
    this.tail = this.tail.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      await atomicWriteFile(this.file, contents)
    })
    return this.tail
  }

  flush(): Promise<void> { return this.tail }
}
