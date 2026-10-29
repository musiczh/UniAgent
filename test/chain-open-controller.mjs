import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = readFileSync(new URL('../src/renderer/chainOpenController.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

let state = { manualOpenIds: new Set(), manualClosedIds: new Set() }
state = mod.toggleChainOpen(state, 'a', 'a')
assert.equal(mod.isChainOpen(state, 'a', 'a'), false, 'closing auto-open chain must stay closed')
state = mod.toggleChainOpen(state, 'c', 'b')
assert.equal(mod.isChainOpen(state, 'b', 'b'), true)
assert.equal(mod.isChainOpen(state, 'c', 'b'), true, 'multiple manual chains may remain open')
state = mod.toggleChainOpen(state, 'd', 'b')
assert.equal(mod.isChainOpen(state, 'c', 'b'), true)
assert.equal(mod.isChainOpen(state, 'd', 'b'), true, 'manual opens do not evict each other')
assert.equal(mod.isChainOpen(state, 'a', 'a'), false, 'appending to a manually-closed chain must not reopen it')
state = mod.reconcileChainOpenState(state, new Set(['a', 'c']))
assert.deepEqual([...state.manualOpenIds], ['c'])
assert.deepEqual([...state.manualClosedIds], ['a'])
console.log('chain-open-controller: ok')
