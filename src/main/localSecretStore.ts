import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolveUserDataHome } from './userData'

const PREFIX = 'local:v1:'

export function isLocalSecret(value: string | undefined): boolean {
  return !!value?.startsWith(PREFIX)
}

function localKey(create: boolean): Buffer {
  const directory = join(resolveUserDataHome(), 'credentials')
  const file = join(directory, 'key')
  try {
    if (create) {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      chmodSync(directory, 0o700)
      try { writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    const key = readFileSync(file)
    if (key.length !== 32) throw new Error('Invalid key length')
    chmodSync(file, 0o600)
    return key
  } catch { throw new Error('本地加密密钥无法读取或保存，请恢复应用数据备份后重试') }
}

export function encryptLocalSecret(value: string): string {
  return encryptWithKey(value, localKey(true))
}

function encryptWithKey(value: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')
}

export function decryptLocalSecret(value: string): string {
  if (!isLocalSecret(value)) throw new Error('API Key 存储方式已更新，请重新填写')
  try { return decryptWithKey(value, localKey(false)) }
  catch { throw new Error('无法读取已保存的 API Key，请重新填写或恢复应用数据备份') }
}

function decryptWithKey(value: string, key: Buffer): string {
  if (!isLocalSecret(value)) throw new Error('API Key 存储方式已更新，请重新填写')
  try {
    const encoded = value.slice(PREFIX.length)
    const data = Buffer.from(encoded, 'base64')
    if (data.length < 28 || data.toString('base64') !== encoded) throw new Error('Invalid ciphertext')
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12), { authTagLength: 16 })
    decipher.setAuthTag(data.subarray(12, 28))
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8')
  } catch { throw new Error('无法读取已保存的 API Key，请重新填写或恢复应用数据备份') }
}

async function localKeyAsync(create: boolean): Promise<Buffer> {
  const directory = join(resolveUserDataHome(), 'credentials')
  const file = join(directory, 'key')
  try {
    if (create) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await chmod(directory, 0o700)
      try { await writeFile(file, randomBytes(32), { flag: 'wx', mode: 0o600 }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    const key = await readFile(file)
    if (key.length !== 32) throw new Error('Invalid key length')
    await chmod(file, 0o600)
    return key
  } catch { throw new Error('本地加密密钥无法读取或保存，请恢复应用数据备份后重试') }
}

export async function encryptLocalSecretAsync(value: string): Promise<string> {
  return encryptWithKey(value, await localKeyAsync(true))
}

export async function decryptLocalSecretAsync(value: string): Promise<string> {
  if (!isLocalSecret(value)) throw new Error('API Key 存储方式已更新，请重新填写')
  try { return decryptWithKey(value, await localKeyAsync(false)) }
  catch { throw new Error('无法读取已保存的 API Key，请重新填写或恢复应用数据备份') }
}
