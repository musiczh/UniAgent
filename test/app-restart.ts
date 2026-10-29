import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppRestartService, RESTART_NOW, RESTART_WAIT, RESTART_CANCEL, type AppRestartDeps, type RestartActivity, type RestartCaller } from '../src/main/appRestart'

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'uniagent-restart-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let now = 1000
  const target = { bundle: '/test/UniAgent.app', executable: '/test/UniAgent.app/Contents/MacOS/UniAgent', version: '1.0.10', sha256: 'a'.repeat(64) }
  const state = {
    caller: { available: true, busy: true, lastSeq: 10 } as RestartCaller,
    activities: [] as RestartActivity[], delivered: false, launches: 0, resumes: 0, notices: [] as string[],
    cards: [] as { id: string; summary: string; options: string[]; answer: (choice?: string) => Promise<void> }[],
    inspect: async () => ({ ...target }), flush: async () => {}, resume: async () => { state.resumes++ }
  }
  const deps: AppRestartDeps = {
    inspectTarget: () => state.inspect(), caller: () => state.caller, activities: () => state.activities,
    ask: (_sessionId, id, summary, options, answer) => { state.cards.push({ id, summary, options, answer }) },
    dismiss: () => {}, replyDelivered: () => state.delivered, flush: () => state.flush(),
    relaunch: () => { state.launches++ }, resume: () => state.resume(), notice: (_id, text) => { state.notices.push(text) }, now: () => now
  }
  const file = join(dir, 'requests.json')
  const service = new AppRestartService(file, deps)
  t.after(() => service.close())
  const id = randomUUID()
  const request = () => service.request(id, 'assistant', target.bundle, '检查新版及飞书连接')
  const answer = (choice = RESTART_NOW) => state.cards.at(-1)!.answer(choice)
  const finished = () => { state.caller.busy = false; state.caller.completed = { seq: 20, success: true }; state.delivered = true }
  const reload = () => { const fresh = new AppRestartService(file, deps); t.after(() => fresh.close()); return fresh }
  return { service, file, state, target, deps, id, request, answer, finished, reload, advance: (ms: number) => { now += ms } }
}
const work = (id: string, status = 'running', revision = '1'): RestartActivity => ({ id, title: id, status, revision })

test('restart waits for a protected choice, successful turn and delivered reply', async t => {
  const f = await fixture(t)
  assert.equal((await f.request()).state, 'awaiting_confirmation')
  assert.deepEqual(f.state.cards[0].options, [RESTART_NOW, RESTART_CANCEL])
  await f.service.tick(); assert.equal(f.state.launches, 0)
  await f.answer(); await f.service.tick(); assert.equal(f.state.launches, 0)
  f.finished(); f.state.delivered = false
  await f.service.tick(); assert.equal(f.state.launches, 0)
  f.state.delivered = true
  await Promise.all([f.service.tick(), f.service.tick()])
  assert.equal(f.state.launches, 1)
  await f.service.tick(); assert.equal(f.state.launches, 1)
  assert.equal((await f.service.status())?.state, 'restarting')
  assert.equal(JSON.parse(await readFile(f.file, 'utf8'))[0].state, 'restarting')
})

test('wait mode includes approval, queued work and sessions started during the wait', async t => {
  const f = await fixture(t)
  f.state.activities = [work('approval', 'awaiting-approval'), work('queue', 'queued')]
  await f.request()
  assert.deepEqual(f.state.cards[0].options, [RESTART_WAIT, RESTART_NOW, RESTART_CANCEL])
  assert.match(f.state.cards[0].summary, /approval.*awaiting-approval/)
  await f.answer(RESTART_WAIT); f.finished()
  await f.service.tick(); assert.equal(f.state.launches, 0)
  f.state.activities = [work('new')]
  await f.service.tick(); assert.equal(f.state.launches, 0)
  f.state.activities = []
  await f.service.tick(); assert.equal(f.state.launches, 1)
})

test('immediate restart accepts only the work shown to the user', async t => {
  const f = await fixture(t)
  f.state.activities = [work('old')]
  await f.request()
  f.state.activities.push(work('new'))
  await f.answer(); assert.equal(f.state.cards.length, 2)
  assert.equal((await f.service.status())?.state, 'awaiting_confirmation')
  await f.answer(); f.finished()
  f.state.activities = [work('old', 'running', '2')]
  await f.service.tick()
  assert.equal(f.state.cards.length, 3, 'a new turn in an existing session also needs confirmation')
  assert.equal(f.state.launches, 0)
  await f.answer(); await f.service.tick()
  assert.equal(f.state.launches, 1)
})

test('user can cancel waiting or reconsider without repeating a restart', async t => {
  const f = await fixture(t)
  f.state.activities = [work('other')]
  await f.request(); await f.answer(RESTART_WAIT)
  const oldCard = f.state.cards[0]
  await f.service.reconsider(f.id, 'assistant')
  await oldCard.answer(RESTART_NOW)
  assert.equal((await f.service.status())?.state, 'awaiting_confirmation')
  await f.answer(RESTART_NOW)
  await f.service.cancel(f.id, 'assistant'); f.finished()
  await f.service.tick(); assert.equal(f.state.launches, 0)
  assert.equal((await f.service.status())?.state, 'cancelled')
  await assert.rejects(f.service.cancel(f.id, 'someone-else'), /当前会话/)
})

test('request identifiers are durable and conflicting or concurrent requests are rejected', async t => {
  const f = await fixture(t)
  await Promise.all([f.request(), f.request()])
  assert.equal(f.state.cards.length, 1)
  await assert.rejects(f.service.request(f.id, 'assistant', f.target.bundle, 'another prompt'), /conflict/)
  await assert.rejects(f.service.request(randomUUID(), 'assistant', f.target.bundle, 'another request'), /已有重启/)
  await assert.rejects(f.service.request('invalid', 'assistant', f.target.bundle, 'prompt'), /无效/)
  await assert.rejects(f.service.request(randomUUID(), 'assistant', '', ''), /无效/)
})

test('package changes or native relaunch failure leave a readable failure without retry', async t => {
  for (const kind of ['changed', 'quit']) {
    const f = await fixture(t)
    await f.request(); await f.answer(); f.finished()
    if (kind === 'changed') f.target.sha256 = 'b'.repeat(64)
    else f.deps.relaunch = () => { throw new Error('native quit failed') }
    await f.service.tick(); await f.service.tick()
    assert.equal((await f.service.status())?.state, 'failed')
    assert.match((await f.service.status())?.error || '', kind === 'changed' ? /已变化/ : /native quit failed/)
    assert.equal(f.state.launches, 0)
  }
})

test('cancel during asynchronous verification wins over restart', async t => {
  const f = await fixture(t)
  await f.request(); await f.answer(); f.finished()
  let release!: () => void, started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { started = resolve })
  f.state.inspect = async () => { started(); await gate; return { ...f.target } }
  const tick = f.service.tick()
  await entered
  await f.service.cancel(f.id, 'assistant'); release(); await tick
  assert.equal(f.state.launches, 0)
})

test('work or caller input arriving while logs flush postpones quitting', async t => {
  for (const kind of ['other', 'caller']) {
    const f = await fixture(t)
    await f.request(); await f.answer(); f.finished()
    f.state.flush = async () => { if (kind === 'other') f.state.activities = [work('new')]; else f.state.caller.busy = true }
    await f.service.tick()
    assert.equal(f.state.launches, 0)
    assert.equal((await f.service.status())?.state, 'waiting')
  }
})

test('failed turn, unavailable caller and reply timeout never quit', async t => {
  for (const kind of ['turn', 'caller', 'delivery']) {
    const f = await fixture(t)
    await f.request(); await f.answer(); f.finished()
    if (kind === 'turn') f.state.caller.completed!.success = false
    if (kind === 'caller') f.state.caller.available = false
    if (kind === 'delivery') f.state.delivered = false
    await f.service.tick(); f.advance(120001); await f.service.tick()
    assert.equal((await f.service.status())?.state, 'failed')
    assert.equal(f.state.launches, 0)
  }
})

test('new process validates the expected package and submits continuation once', async t => {
  const f = await fixture(t)
  await f.request(); await f.answer(); f.finished(); await f.service.tick()
  await f.service.close()
  const recovered = f.reload()
  await Promise.all([recovered.recover(f.id, f.target.executable), recovered.recover(f.id, f.target.executable)])
  assert.equal(f.state.resumes, 1)
  assert.equal((await recovered.status())?.state, 'completed')
  await recovered.recover(f.id, f.target.executable)
  await f.reload().recover(f.id, f.target.executable)
  assert.equal(f.state.resumes, 1)
  assert.equal(f.state.launches, 1)
})

test('wrong launch, expired request, busy session and interrupted submission never replay', async t => {
  for (const kind of ['no-arg', 'wrong-id', 'wrong-exe', 'expired', 'busy', 'uncertain', 'replaced']) {
    const f = await fixture(t)
    await f.request(); await f.answer(); f.finished(); await f.service.tick(); await f.service.close()
    if (kind === 'expired') f.advance(600001)
    if (kind === 'busy') f.state.caller.busy = true
    if (kind === 'replaced') f.target.sha256 = 'b'.repeat(64)
    if (kind === 'uncertain') {
      const rows = JSON.parse(await readFile(f.file, 'utf8')); rows[0].state = 'resuming'
      await writeFile(f.file, JSON.stringify(rows))
    }
    const recovered = f.reload()
    await recovered.recover(kind === 'no-arg' ? undefined : kind === 'wrong-id' ? randomUUID() : f.id, kind === 'wrong-exe' ? '/wrong' : f.target.executable)
    assert.equal((await recovered.status())?.state, 'failed', kind)
    assert.equal(f.state.resumes, 0, kind)
    assert.equal(f.state.launches, 1, kind)
  }
})

test('unexpected App shutdown cancels the old waiting intent on next startup', async t => {
  const f = await fixture(t)
  await f.request(); await f.answer(RESTART_WAIT); await f.service.close()
  await f.reload().recover(undefined, f.target.executable)
  assert.equal((await f.reload().status())?.state, 'failed')
  f.finished(); await f.service.tick()
  assert.equal(f.state.launches, 0)
})

test('confirmation failure is recorded, including when replacing a waiting choice', async t => {
  const f = await fixture(t)
  await f.request(); await f.answer(RESTART_WAIT)
  f.deps.ask = () => { throw new Error('confirmation unavailable') }
  await assert.rejects(f.service.reconsider(f.id, 'assistant'), /confirmation unavailable/)
  assert.equal((await f.service.status())?.state, 'failed')
  assert.match((await f.service.status())?.error || '', /confirmation unavailable/)
  f.finished(); await f.service.tick()
  assert.equal(f.state.launches, 0)
})

test('a failed activity lookup is reported instead of silently retrying forever', async t => {
  const f = await fixture(t)
  await f.request(); await f.answer(RESTART_WAIT); f.finished()
  f.deps.activities = () => { throw new Error('activity unavailable') }
  await f.service.tick()
  assert.equal((await f.service.status())?.state, 'failed')
  assert.equal(f.state.launches, 0)
})
