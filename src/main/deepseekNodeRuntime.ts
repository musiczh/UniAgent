import { randomUUID, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const supported = (version: string) => {
  const match = /^v(\d+)\.(\d+)\.\d+$/.exec(version.trim())
  return !!match && (+match[1] === 22 && +match[2] >= 19 || +match[1] >= 24)
}
export function privateNodeBin(root: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(join(root, 'node-runtime.json'), 'utf8'))
    if (!/^node-v24\.\d+\.\d+-(darwin|linux)-(arm64|x64)-[a-f0-9-]+$/.test(value.directory)) throw new Error()
    return join(root, value.directory, 'bin')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('DeepSeek 专用 Node.js 版本记录损坏，请重新安装')
  }
}

/** Reuses a compatible Node or installs an application-private official LTS archive; never changes global npm. */
export async function ensureDeepSeekNode(root: string, signal: AbortSignal): Promise<string | undefined> {
  const installed = privateNodeBin(root)
  const bin = installed ? join(installed, 'node') : 'node'
  try {
    const { stdout } = await run(bin, ['--version'], { timeout: 8000, signal })
    if (supported(stdout)) {
      const npm = installed ? join(installed, 'npm') : process.platform === 'win32' ? 'npm.cmd' : 'npm'
      const version = await run(npm, ['--version'], { timeout: 8000, signal,
        env: { ...process.env, ...(installed ? { PATH: installed + delimiter + (process.env.PATH || '') } : {}) } })
      if (/^\d+\.\d+\.\d+/.test(version.stdout.trim())) return installed
    }
  } catch { signal.throwIfAborted() }
  if (!['darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) {
    throw new Error('当前平台需要先安装 Node.js 22.19+ 或 24+，再重试安装 DeepSeek')
  }
  const fetchFile = async (url: string, limit: number): Promise<Buffer> => {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]) })
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Node.js 下载失败，请检查网络后重试') }
    const reader = response.body.getReader()
    const chunks: Buffer[] = []; let size = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.byteLength
        if (size > limit) throw new Error('Node.js 下载内容超出大小限制')
        chunks.push(Buffer.from(next.value))
      }
      return Buffer.concat(chunks)
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  }
  const index = JSON.parse((await fetchFile('https://nodejs.org/dist/index.json', 5 * 1024 * 1024)).toString())
  const platformFile = process.platform === 'darwin' ? `osx-${process.arch}-tar` : `linux-${process.arch}`
  const release = Array.isArray(index) ? index.find(item => /^v24\.\d+\.\d+$/.test(item.version) && item.lts && item.files?.includes(platformFile)) : undefined
  if (!release) throw new Error('没有找到当前平台可用的 Node.js LTS 版本')
  const directory = `node-${release.version}-${process.platform}-${process.arch}`
  const filename = `${directory}.tar.gz`
  const origin = `https://nodejs.org/dist/${release.version}/`
  const sums = (await fetchFile(origin + 'SHASUMS256.txt', 1024 * 1024)).toString()
  const expected = sums.split('\n').map(line => line.trim().split(/\s+/)).find(parts => parts[1] === filename)?.[0]
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Node.js 下载校验信息无效')
  const archive = await fetchFile(origin + filename, 120 * 1024 * 1024)
  const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', new Uint8Array(archive))).toString('hex')
  if (digest !== expected) throw new Error('Node.js 下载完整性校验失败，请重试')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(root, '.node-install-'))
  try {
    const file = join(staging, filename)
    await writeFile(file, archive, { mode: 0o600 })
    await run('tar', ['-xzf', file, '-C', staging], { timeout: 60_000, signal })
    const { stdout } = await run(join(staging, directory, 'bin/node'), ['--version'], { timeout: 8000, signal })
    if (stdout.trim() !== release.version) throw new Error('Node.js 版本验证失败')
    signal.throwIfAborted()
    const target = `${directory}-${randomUUID()}`
    await rename(join(staging, directory), join(root, target))
    await writeFile(join(staging, 'pointer.json'), JSON.stringify({ directory: target }), { mode: 0o600 })
    await rename(join(staging, 'pointer.json'), join(root, 'node-runtime.json'))
    return join(root, target, 'bin')
  } finally { await rm(staging, { recursive: true, force: true }) }
}
