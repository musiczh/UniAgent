import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteFile, SessionStoreWriteError } from '../src/main/sessionStore'

const root = await mkdtemp(join(tmpdir(), 'startup-recovery-io-'))
try {
  const file = join(root, 'project.json')
  await writeFile(file, 'old')
  await atomicWriteFile(file, JSON.stringify({ recovered: true }))
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { recovered: true })
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(root), ['project.json'])

  const directory = join(root, 'blocked.json')
  await mkdir(directory)
  await writeFile(join(directory, 'prior'), 'preserved')
  await assert.rejects(atomicWriteFile(directory, 'replacement'), error =>
    error instanceof SessionStoreWriteError && error.commitDisposition === 'not-committed')
  assert.equal(await readFile(join(directory, 'prior'), 'utf8'), 'preserved')
  assert.ok(!(await readdir(root)).some(name => name.endsWith('.tmp')))

  await assert.rejects(atomicWriteFile(join(root, 'missing', 'project.json'), 'replacement'), error =>
    error instanceof SessionStoreWriteError && error.commitDisposition === 'not-committed')
  console.log('startup recovery asynchronous atomic I/O: replacement, permissions, failure preservation and temp cleanup passed')
} finally {
  await rm(root, { recursive: true, force: true })
}
