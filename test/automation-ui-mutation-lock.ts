import assert from 'node:assert/strict'
import test from 'node:test'
import { AutomationMutationController, runAutomationListRequest } from '../src/renderer/automationControllers'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

test('automation list loading distinguishes an empty result from a rejected request', async (t) => {
  await t.test('an empty successful result commits and settles without failure', async () => {
    const events: string[] = []
    await runAutomationListRequest(
      async () => [],
      (items) => events.push(`commit:${items.length}`),
      () => events.push('reject'),
      () => events.push('settle')
    )
    assert.deepEqual(events, ['commit:0', 'settle'])
  })

  await t.test('a rejected request reports failure, settles, and does not reject its caller', async () => {
    const events: string[] = []
    await assert.doesNotReject(runAutomationListRequest(
      async () => { throw new Error('scan failed') },
      () => events.push('commit'),
      () => events.push('reject'),
      () => events.push('settle')
    ))
    assert.deepEqual(events, ['reject', 'settle'])
  })
})

test('automation UI mutations share one synchronous controller', async () => {
  const controller = new AutomationMutationController()
  const pendingToggle = deferred<string>()
  const started: string[] = []

  const toggle = controller.run(async () => {
    started.push('toggle')
    return pendingToggle.promise
  })
  const saveWhileToggleRuns = controller.run(async () => {
    started.push('save')
    return 'saved'
  })
  const deleteWhileToggleRuns = controller.run(async () => {
    started.push('delete')
    return 'deleted'
  })

  assert.equal(await saveWhileToggleRuns, undefined)
  assert.equal(await deleteWhileToggleRuns, undefined)
  assert.deepEqual(started, ['toggle'])

  pendingToggle.resolve('toggled')
  assert.equal(await toggle, 'toggled')
  assert.equal(await controller.run(async () => 'saved'), 'saved')

  await assert.rejects(controller.run(async () => { throw new Error('write failed') }), /write failed/)
  assert.equal(await controller.run(async () => 'deleted'), 'deleted')
})
