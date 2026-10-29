import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = readFileSync(new URL('../src/main/contextCompactionHistory.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { ContextCompactionHistory } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
const history = new ContextCompactionHistory()
assert.equal(history.accept('window-1', '2026-08-21T00:00:00.000Z', 'top', 1), 'window-1')
assert.equal(history.accept(undefined, '2026-08-21T00:00:00.010Z', 'event', 2), null, 'paired event record must dedupe')
assert.equal(history.accept(undefined, '2026-08-21T00:00:10.000Z', 'event', 3), 'context-compaction-history-1787270410000')
assert.equal(history.accept('native-2', '2026-08-21T00:00:11.000Z', 'event', 4), 'native-2', 'distinct explicit compaction must survive')
assert.equal(history.accept('native-2', '2026-08-21T00:00:20.000Z', 'event', 5), null, 'native id must dedupe globally')
const explicitPair = new ContextCompactionHistory()
assert.equal(explicitPair.accept('window-a', '2026-08-21T00:01:00.000Z', 'top', 1), 'window-a')
assert.equal(explicitPair.accept('native-b', '2026-08-21T00:01:00.010Z', 'event', 2), 'native-b', 'a distinct explicit native id must not be consumed as the no-id paired record')
console.log('context-compaction-history: ok')
