import assert from 'node:assert/strict'
import { hasExternalProcessHolder, lsofWritableProcessIds } from '../src/main/nativeSessionOccupancy.ts'

const readersAndWriters = [
  'p100', 'cUniAgent', 'f12', 'ar',
  'p200', 'ccodex', 'f13', 'ar', 'f14', 'aw', 'f16', 'au',
  'p300', 'ctraex', 'f15', 'au'
].join('\n')
assert.deepEqual(
  lsofWritableProcessIds(readersAndWriters),
  [200, 300],
  'history readers cannot write the rollout; write and read/write holders can'
)
assert.deepEqual(lsofWritableProcessIds('p100\ncUniAgent\nf12\nar\n'), [])
assert.deepEqual(lsofWritableProcessIds(''), [])
for (const output of [
  'p100\nf12\na \n',
  'p100\nf12\n',
  'p100\ncUniAgent\n',
  'p100\nf12\nf13\nar\n',
  'p100\nf12\np200\nf13\nar\n',
  'p0\nf12\naw\n',
  'f12\naw\n',
  'p100\nf\naw\n',
  'unexpected output'
]) {
  assert.equal(lsofWritableProcessIds(output), undefined, 'unknown access must not become an external lock')
}

const parents = new Map<number, number>([
  [210, 200],
  [220, 210],
  [300, 1]
])

assert.equal(
  hasExternalProcessHolder([220], new Set([200]), parents),
  false,
  'a native app-server descendant belongs to the current runner'
)
assert.equal(
  hasExternalProcessHolder([200], new Set([200]), new Map()),
  false,
  'a directly spawned app-server still matches its runner root'
)
assert.equal(
  hasExternalProcessHolder([220, 300], new Set([200]), parents),
  true,
  'an independent holder remains external even when the current runner also holds the file'
)
assert.equal(
  hasExternalProcessHolder([220], new Set([200]), new Map()),
  undefined,
  'an incomplete process tree cannot reliably classify an unmatched holder'
)
assert.equal(
  hasExternalProcessHolder(lsofWritableProcessIds(readersAndWriters)!, new Set([200]), parents),
  true,
  'ignoring a history reader and our own writer must still preserve an external writer lock'
)

console.log('native-session-occupancy: ok')
