import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureDeepSeekNode, privateNodeBin } from '../src/main/deepseekNodeRuntime.ts'

const run = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'ua-private-node-'))
const previousPath = process.env.PATH
const previousFetch = globalThis.fetch
try {
  const commands = join(root, 'commands')
  await mkdir(commands)
  await writeFile(join(commands, 'node'), '#!/bin/sh\necho v20.0.0\n', { mode: 0o755 })
  process.env.PATH = commands + ':/usr/bin:/bin'
  const directory = `node-v24.22.0-${process.platform}-${process.arch}`
  await mkdir(join(root, directory, 'bin'), { recursive: true })
  await writeFile(join(root, directory, 'bin/node'), '#!/bin/sh\necho v24.22.0\n', { mode: 0o755 })
  await writeFile(join(root, directory, 'bin/npm'), '#!/bin/sh\n[ "$(node --version)" = "v24.22.0" ] || exit 1\necho 11.19.1\n', { mode: 0o755 })
  await run('tar', ['-czf', join(root, 'fixture.tar.gz'), '-C', root, directory])
  const archive = await readFile(join(root, 'fixture.tar.gz'))
  const hash = createHash('sha256').update(archive).digest('hex')
  let corrupt = false
  let calls = 0
  globalThis.fetch = async url => {
    calls++
    const href = String(url)
    assert.ok(href.startsWith('https://nodejs.org/dist/'))
    const body = href.endsWith('index.json') ? JSON.stringify([{ version: 'v24.22.0', lts: 'Krypton', files: [`osx-${process.arch}-tar`, `linux-${process.arch}`] }])
      : href.endsWith('SHASUMS256.txt') ? `${corrupt ? '0'.repeat(64) : hash}  ${directory}.tar.gz\n` : archive
    return new Response(body)
  }
  const data = join(root, 'data')
  assert.equal(privateNodeBin(data), undefined)
  corrupt = true
  await assert.rejects(ensureDeepSeekNode(data, new AbortController().signal), /完整性校验失败/)
  assert.equal(privateNodeBin(data), undefined, 'bad downloads cannot become active')
  corrupt = false
  const bin = await ensureDeepSeekNode(data, new AbortController().signal)
  assert.equal(privateNodeBin(data), bin)
  assert.equal((await run(join(bin!, 'node'), ['--version'])).stdout.trim(), 'v24.22.0')
  const count = calls
  assert.equal(await ensureDeepSeekNode(data, new AbortController().signal), bin)
  assert.equal(calls, count, 'a working private Node never downloads again')
  assert.equal((await readdir(data)).some(entry => entry.startsWith('.node-install-')), false)
  await writeFile(join(data, 'node-runtime.json'), JSON.stringify({ directory: '../outside' }))
  assert.throws(() => privateNodeBin(data), /版本记录损坏/)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(ensureDeepSeekNode(join(root, 'aborted'), abort.signal))
  assert.equal(calls, count, 'cancellation cannot start downloads')
  assert.equal(await readFile(join(commands, 'node'), 'utf8'), '#!/bin/sh\necho v20.0.0\n', 'global command paths remain untouched')
} finally {
  process.env.PATH = previousPath
  globalThis.fetch = previousFetch
  await rm(root, { recursive: true, force: true })
}
console.log('deepseek-node-runtime: private fallback, checksum rejection, activation, reuse, cancellation and path isolation passed')
