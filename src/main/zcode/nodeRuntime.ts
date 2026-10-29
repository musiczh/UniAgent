import { webcrypto } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runZCodeInstallProcess } from './installProcess'

// Kept exact: ZCode's workspace engine-strict and native dependencies require its pinned toolchain.
export const ZCODE_NODE_VERSION = '24.14.0'

export async function downloadZCodeFile(url: string, limit: number, signal: AbortSignal): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]) })
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('ZCode 运行环境下载失败，请检查网络后重试') }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []; let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > limit) throw new Error('ZCode 运行环境下载超过大小限制')
      chunks.push(Buffer.from(next.value))
    }
    return Buffer.concat(chunks)
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}

export async function verifyZCodeArchive(archive: Buffer, sums: string, filename: string): Promise<void> {
  const matches = sums.split('\n').map(line => line.trim().split(/\s+/)).filter(parts => parts[1] === filename)
  if (matches.length !== 1 || !/^[a-f0-9]{64}$/.test(matches[0][0])) throw new Error('ZCode 运行环境校验信息无效')
  const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', new Uint8Array(archive))).toString('hex')
  if (digest !== matches[0][0]) throw new Error('ZCode 运行环境完整性校验失败')
}

export async function ensureZCodeNode(directory: string, env: NodeJS.ProcessEnv, signal: AbortSignal, preferred?: string): Promise<string> {
  const run = (bin: string, args: string[], timeout = 8000) => runZCodeInstallProcess(bin, args, {
    cwd: directory, env, signal, timeout, message: 'ZCode Node 运行环境不可用'
  })
  // Only reuse an explicit, previously managed runtime. A PATH Node may belong to another CLI.
  if (preferred) {
    try {
      if (await run(preferred, ['--version']) === `v${ZCODE_NODE_VERSION}`) return preferred
    } catch { signal.throwIfAborted() }
  }
  if (!['darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) {
    throw new Error('当前平台暂不支持 ZCode 自动安装，请使用 Agent 初始化')
  }
  const name = `node-v${ZCODE_NODE_VERSION}-${process.platform}-${process.arch}`
  const file = `${name}.tar.gz`
  const origin = `https://nodejs.org/dist/v${ZCODE_NODE_VERSION}/`
  const sums = await downloadZCodeFile(origin + 'SHASUMS256.txt', 1024 * 1024, signal)
  const archive = await downloadZCodeFile(origin + file, 120 * 1024 * 1024, signal)
  await verifyZCodeArchive(archive, sums.toString(), file)
  signal.throwIfAborted()
  await mkdir(join(directory, 'node'), { mode: 0o700 })
  const path = join(directory, 'node', file)
  await writeFile(path, archive, { mode: 0o600 })
  await run('tar', ['-xzf', path, '-C', join(directory, 'node')], 60_000)
  const executable = join(directory, 'node', name, 'bin', 'node')
  if (await run(executable, ['--version']) !== `v${ZCODE_NODE_VERSION}`) throw new Error('ZCode Node 版本校验失败')
  await access(join(directory, 'node', name, 'bin', 'corepack'))
  return executable
}
