import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHistoryPreviewProgress } from '../src/main/historyPreviewProgress'
import { readHistoryFile } from '../src/main/historyProgress'
import type { HistoryLoadProgress } from '../src/shared/types'

const now = performance.now()
for (const agentId of ['codex', 'traex', 'claude', 'grok']) {
  const estimate = createHistoryPreviewProgress(agentId, false)
  const history: HistoryLoadProgress[] = [
    { phase: 'preparing' }, { phase: 'locating' },
    { phase: 'reading', total: 40_000_000, completed: 0 },
    { phase: 'reading', total: 40_000_000, completed: 20_000_000 },
    { phase: 'reading', total: 40_000_000, completed: 40_000_000 },
    { phase: 'locating' },
    { phase: 'reading-parent', total: 5000, completed: 4000 },
    { phase: 'reading-parent', total: 9000, completed: 0 },
    { phase: 'rollbacks', total: 100, completed: 70 },
    { phase: 'scanning', total: 0, completed: 0 },
    { phase: 'parsing', total: 100, completed: 120 },
    { phase: 'subagents' }, { phase: 'replaying' }, { phase: 'fork-points' },
    { phase: 'fork-points', total: NaN, completed: Infinity }
  ]
  let previous = 0
  for (let index = 0; index < history.length; index++) {
    const { percent } = estimate.update(history[index], now + index * 100)
    assert.ok(Number.isFinite(percent) && percent >= previous && percent <= 98, `${agentId}: invalid total progress`)
    previous = percent
  }
  assert.ok(estimate.value(now + 3_600_000).percent < 100, 'waiting must never report completion')
  assert.equal(estimate.update({ phase: 'rendering' }).percent, 98)
}

const largeCodex = createHistoryPreviewProgress('codex', false)
largeCodex.update({ phase: 'reading', total: 39_051_535, completed: 0 }, now)
assert.ok(largeCodex.update({ phase: 'fork-points' }, now).percent < 5, 'large Codex must reserve most progress for native thread reading')
const largeTrae = createHistoryPreviewProgress('traex', false)
largeTrae.update({ phase: 'reading', total: 15_033_586, completed: 0 }, now)
assert.ok(largeTrae.update({ phase: 'subagents' }, now).percent < 5, 'large TraeX must reserve progress for child histories')
assert.ok(largeTrae.update({ phase: 'fork-points' }, now).percent > 90)
const coldClaude = createHistoryPreviewProgress('claude', true)
coldClaude.update({ phase: 'reading', total: 24_780, completed: 24_780 }, now)
assert.ok(coldClaude.update({ phase: 'fork-points' }, now).percent < 5, 'cold Claude must reserve CLI probe cost')
assert.equal(createHistoryPreviewProgress('codex', false).value(now).percent, 0, 'new requests must start independently')

const scratch = await mkdtemp(join(tmpdir(), 'ua-history-progress-unit-'))
try {
  const file = join(scratch, 'history.jsonl')
  const content = Buffer.from('中文🙂\n'.repeat(100_000))
  await writeFile(file, content)
  const ticks: HistoryLoadProgress[] = []
  assert.deepEqual(await readHistoryFile(file, (tick) => ticks.push(tick)), content)
  assert.equal(ticks[0].completed, 0)
  assert.equal(ticks.at(-1)?.completed, content.length)
  assert.ok(ticks.every((tick, i) => tick.total === content.length && (!i || tick.completed! >= ticks[i - 1].completed!)))
  await writeFile(file, '')
  assert.equal((await readHistoryFile(file, () => {})).length, 0)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
console.log('history preview progress: passed monotonicity, phase budgets, wait limits, isolation, and byte accuracy')
