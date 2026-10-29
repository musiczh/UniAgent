import assert from 'node:assert/strict'
import { appendFile, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reviewGetFilePair } from '../src/main/reviewFiles'

const workdir = await mkdtemp(join(tmpdir(), 'uniagent-review-'))
try {
  const after = 'new UTF-8 file: 你好\n'
  await writeFile(join(workdir, 'new.txt'), after)
  assert.deepEqual(
    await reviewGetFilePair(
      { sessionId: 'test', path: 'new.txt', unifiedDiff: '', kind: 'add' },
      workdir
    ),
    { path: 'new.txt', kind: 'add', before: '', after }
  )

  const growingPath = join(workdir, 'growing.txt')
  await writeFile(growingPath, 'small')
  const probe = await open(growingPath, 'r')
  const fileHandlePrototype = Object.getPrototypeOf(probe) as { stat: typeof probe.stat }
  const originalStat = fileHandlePrototype.stat
  await probe.close()
  let grew = false
  fileHandlePrototype.stat = async function (...args) {
    const snapshot = await originalStat.apply(this, args)
    if (!grew) {
      grew = true
      await appendFile(growingPath, Buffer.alloc(1.5 * 1024 * 1024 + 1))
    }
    return snapshot
  }
  try {
    const growing = await reviewGetFilePair(
      { sessionId: 'test', path: 'growing.txt', unifiedDiff: '', kind: 'add' },
      workdir
    )
    assert.equal(grew, true)
    assert.equal(growing.tooLarge, true)
    assert.equal(growing.after, '')
  } finally {
    fileHandlePrototype.stat = originalStat
  }

  const outside = join(workdir, '..', `uniagent-review-secret-${process.pid}.txt`)
  await writeFile(outside, 'must not escape')
  await symlink(outside, join(workdir, 'escape.txt'))
  for (const path of [outside, `../${outside.split('/').at(-1)}`, 'escape.txt']) {
    const result = await reviewGetFilePair(
      { sessionId: 'test', path, unifiedDiff: '', kind: 'add' },
      workdir
    )
    assert.equal(result.after, '')
    assert.equal(result.degraded, true)
  }
  await rm(outside, { force: true })
} finally {
  await rm(workdir, { recursive: true, force: true })
}
