import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { encryptLocalSecretAsync, decryptLocalSecretAsync } from '../localSecretStore'

export interface WeixinAccount { token: string; botId: string; userId: string; baseUrl: string }
export interface WeixinSavedState {
  account?: WeixinAccount
  sessionId?: string
  cursor: string
  contextToken?: string
  handled: string[]
  pending: string[]
  pushedSeq: number
}
const empty = (): WeixinSavedState => ({ cursor: '', handled: [], pending: [], pushedSeq: -1 })

/** The token, reply context and receive cursor stay in one encrypted, atomic snapshot. */
export class WeixinStore {
  private value = empty()
  private writes = Promise.resolve()
  constructor(private file: string) {}
  get(): WeixinSavedState { return structuredClone(this.value) }
  async load(): Promise<void> {
    let raw: string
    try { raw = await readFile(this.file, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('微信连接配置无法读取') }
    try {
      const value = JSON.parse(await decryptLocalSecretAsync(raw)) as WeixinSavedState
      const account = value.account
      if (typeof value.cursor !== 'string' || !Array.isArray(value.handled) || !Array.isArray(value.pending) ||
        !Number.isInteger(value.pushedSeq) || account && ['token','botId','userId','baseUrl'].some(key => typeof account[key as keyof WeixinAccount] !== 'string' || !account[key as keyof WeixinAccount])) throw new Error()
      this.value = value
    } catch { throw new Error('微信连接配置无法解密，请重新扫码绑定') }
  }
  update(patch: Partial<WeixinSavedState> | ((current: WeixinSavedState) => Partial<WeixinSavedState> | undefined)): Promise<void> {
    const run = this.writes.then(async () => {
      const delta = typeof patch === 'function' ? patch(this.get()) : patch
      if (!delta) return
      const next = { ...this.value, ...structuredClone(delta) }
      const encrypted = await encryptLocalSecretAsync(JSON.stringify(next))
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      const temporary = `${this.file}.${process.pid}.tmp`
      await writeFile(temporary, encrypted, { mode: 0o600 })
      await rename(temporary, this.file)
      this.value = next
    })
    this.writes = run.catch(() => {})
    return run
  }
  reset(): Promise<void> { return this.update({ ...empty(), account: undefined, sessionId: undefined, contextToken: undefined }) }
  close(): Promise<void> { return this.writes }
}
