import assert from 'node:assert/strict'
import test from 'node:test'
import { AutomationDetailRequestController } from '../src/renderer/components/AutomationsPanel'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

test('automation detail requests commit only for the current task', async (t) => {
  await t.test('an older completion cannot clear the newer request loading state', async () => {
    const controller = new AutomationDetailRequestController()
    const first = deferred<string>()
    const second = deferred<string>()
    let detail: string | null = null
    let loading = true

    const firstRun = controller.run(() => first.promise, (value) => { detail = value }, () => { loading = false })
    const secondRun = controller.run(() => second.promise, (value) => { detail = value }, () => { loading = false })

    first.resolve('A')
    await firstRun
    assert.equal(detail, null)
    assert.equal(loading, true)

    second.resolve('B')
    await secondRun
    assert.equal(detail, 'B')
    assert.equal(loading, false)
  })

  await t.test('an older late response cannot overwrite the current task detail', async () => {
    const controller = new AutomationDetailRequestController()
    const first = deferred<string>()
    const second = deferred<string>()
    let detail: string | null = null
    let settled = 0

    const firstRun = controller.run(() => first.promise, (value) => { detail = value }, () => { settled += 1 })
    const secondRun = controller.run(() => second.promise, (value) => { detail = value }, () => { settled += 1 })

    second.resolve('B')
    await secondRun
    first.resolve('A')
    await firstRun

    assert.equal(detail, 'B')
    assert.equal(settled, 1)
  })

  await t.test('invalidating a request prevents commits after return or unmount', async () => {
    const controller = new AutomationDetailRequestController()
    const pending = deferred<string>()
    let committed = false
    let settled = false

    const run = controller.run(
      () => pending.promise,
      () => { committed = true },
      () => { settled = true }
    )
    controller.invalidate()
    pending.resolve('stale')
    await run

    assert.equal(committed, false)
    assert.equal(settled, false)
  })
})
