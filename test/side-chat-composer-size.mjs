import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const hooks = readFileSync(new URL('../src/renderer/hooks.ts', import.meta.url), 'utf8')
const panel = readFileSync(new URL('../src/renderer/components/SideChatPanel.tsx', import.meta.url), 'utf8')

assert.match(hooks, /new ResizeObserver/)
assert.match(hooks, /observer\.observe\(el\)/)
assert.match(hooks, /observer\.disconnect\(\)/)
assert.match(panel, /value !== 420 \? value : 460/)
