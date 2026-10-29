import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { encryptLocalSecret, isLocalSecret } from './localSecretStore'
import { resolveUserDataHome } from './userData'

export const SECRET_MIGRATION_ARG = '--uniagent-migrate-secrets'
const failureMessage = '旧 API Key 迁移未完成，原配置已保留；请允许钥匙串访问后重试'
const flights = new Map<string, Promise<string[]>>()

/** Only the helper process may invoke the blocking OS keychain API. */
export function migrateLegacySecrets(values: string[]): Promise<string[]> {
  if (!values.some(value => value && !isLocalSecret(value))) return Promise.resolve(values)
  const userData = resolveUserDataHome()
  const identity = JSON.stringify([userData, values])
  const pending = flights.get(identity)
  if (pending) return pending
  const job = new Promise<string[]>((resolve, reject) => {
    const { app } = createRequire(import.meta.url)('electron')
    const child = spawn(process.execPath, [...(app.isPackaged ? [] : [app.getAppPath()]), SECRET_MIGRATION_ARG], {
      env: { ...process.env, UNIAGENT_USER_DATA: userData, ELECTRON_RUN_AS_NODE: undefined },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    })
    let settled = false
    const finish = (result?: string[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (result) resolve(result)
      else { child.kill('SIGKILL'); reject(new Error(failureMessage)) }
    }
    const timer = setTimeout(() => finish(), 120_000)
    child.once('error', () => finish())
    child.once('exit', () => finish())
    child.on('message', (message: any) => {
      if (message?.type === 'ready') child.send({ values }, error => { if (error) finish() })
      if (message?.type === 'result') {
        const result = message.values
        const valid = Array.isArray(result) && result.length === values.length
          && result.every((value, index) => typeof value === 'string'
            && (values[index] && !isLocalSecret(values[index]) ? isLocalSecret(value) : value === values[index]))
        finish(valid ? result : undefined)
      }
      if (message?.type === 'failed') finish()
    })
  }).finally(() => { flights.delete(identity) })
  flights.set(identity, job)
  return job
}

export async function runLegacySecretMigrationWorker(): Promise<void> {
  const { app, safeStorage } = createRequire(import.meta.url)('electron')
  app.dock?.hide()
  await app.whenReady()
  process.once('disconnect', () => app.exit())
  process.once('message', (message: any) => {
    try {
      if (!Array.isArray(message?.values) || !message.values.every((value: unknown) => typeof value === 'string')) throw new Error()
      const values = message.values.map((value: string) => {
        if (!value || isLocalSecret(value)) return value
        if (!safeStorage.isEncryptionAvailable()) throw new Error()
        const plaintext = safeStorage.decryptString(Buffer.from(value, 'base64'))
        if (!plaintext) throw new Error()
        return encryptLocalSecret(plaintext)
      })
      process.send!({ type: 'result', values }, () => app.exit())
    } catch { process.send!({ type: 'failed' }, () => app.exit(1)) }
  })
  process.send!({ type: 'ready' })
}
