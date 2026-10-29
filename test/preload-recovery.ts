import assert from 'node:assert/strict'
import { recoverFromPreloadError } from '../src/renderer/preloadRecovery'

const values = new Map<string, string>()
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value) },
}
let prevented = 0
let reloads = 0
const event = { preventDefault: () => { prevented++ } } as Event
const reload = (): void => { reloads++ }

recoverFromPreloadError(event, 'old-entry.js', storage, reload)
recoverFromPreloadError(event, 'old-entry.js', storage, reload)
assert.equal(prevented, 2, 'preload failures are handled instead of surfacing as uncaught errors')
assert.equal(reloads, 1, 'the same stale build reloads only once')

recoverFromPreloadError(event, 'new-entry.js', storage, reload)
assert.equal(reloads, 2, 'a later build may recover independently')

console.log('preload-recovery: ok')
