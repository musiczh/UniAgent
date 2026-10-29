import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveUserDataHome } from './userData.ts'
import { decryptLocalSecretAsync, encryptLocalSecretAsync } from './localSecretStore.ts'

type Owner = 'claude' | 'grok'
const variables = { claude: 'ANTHROPIC_API_KEY', grok: 'XAI_API_KEY' } as const
let root = '', loading: Promise<void> | undefined
let keys: Partial<Record<Owner, string>> = {}, encrypted: Partial<Record<Owner, string>> = {}
let writer: Promise<unknown> = Promise.resolve()
export function nativeCredentialEnv(owner: string): NodeJS.ProcessEnv {
  if (root !== resolveUserDataHome()) return {}
  const key = keys[owner as Owner]
  return key ? { [variables[owner as Owner]]: key } : {}
}
export function loadNativeCredentials(): Promise<void> {
  const directory = resolveUserDataHome()
  if (root !== directory) { root = directory; loading = undefined; keys = {}; encrypted = {} }
  return loading ??= (async () => {
    let text: string
    try { text = await readFile(join(directory, 'agent-credentials.json'), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('Agent 凭据配置无法读取') }
    try {
      const stored = JSON.parse(text)
      const next: typeof keys = {}, ciphertext: typeof encrypted = {}
      for (const id of Object.keys(variables) as Owner[]) if (stored[id] !== undefined) {
        if (typeof stored[id] !== 'string') throw new Error('invalid')
        next[id] = await decryptLocalSecretAsync(stored[id]); ciphertext[id] = stored[id]
      }
      if (root === directory) { keys = next; encrypted = ciphertext }
    } catch { throw new Error('Agent 凭据配置无法解密，请恢复备份或重新配置') }
  })()
}
export async function saveNativeCredential(owner: Owner, key: string): Promise<void> {
  if (!Object.hasOwn(variables, owner) || !key.trim()) throw new Error('连接参数无效')
  const operation = writer.then(async () => {
    await loadNativeCredentials()
    const directory = resolveUserDataHome()
    const next = { ...encrypted, [owner]: await encryptLocalSecretAsync(key) }
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const file = join(directory, 'agent-credentials.json')
    await writeFile(file + '.tmp', JSON.stringify(next), { mode: 0o600 })
    await rename(file + '.tmp', file)
    encrypted = next; keys = { ...keys, [owner]: key }
  })
  writer = operation.catch(() => {})
  return operation
}
