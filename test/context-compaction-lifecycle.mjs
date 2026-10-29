import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = readFileSync(new URL('../src/main/contextCompactionLifecycle.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { CompactionActivityGate, CompactionInvocationQueue, ContextCompactionLifecycle, DeferredTurnCompletions } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

const lifecycle = new ContextCompactionLifecycle(() => 'thread-1')
const started = lifecycle.beginInvocation()
lifecycle.alias('native-compact-1', started.id)
const itemStarted = lifecycle.started('native-compact-1')
const itemCompleted = lifecycle.completedItem('native-compact-1')
const duplicateCompleted = lifecycle.compacted('native-compact-1')
assert.deepEqual([started, itemStarted, itemCompleted].map((event) => event.state), ['running', 'running', 'success'])
assert.equal(new Set([started, itemStarted, itemCompleted].map((event) => event.id)).size, 1)
assert.equal(duplicateCompleted, null, 'thread/compacted must not duplicate item completion')

const serverStarted = lifecycle.started('native-server-2')
const serverCompleted = lifecycle.completedItem('native-server-2')
assert.deepEqual([serverStarted.state, serverCompleted.state], ['running', 'success'])
assert.equal(serverStarted.id, serverCompleted.id)
assert.notEqual(serverStarted.id, started.id)

const notificationFirst = new ContextCompactionLifecycle(() => 'thread-2')
const early = notificationFirst.beginInvocation()
assert.equal(notificationFirst.compacted(), null, 'no-id thread notice is not an authoritative terminal')
assert.equal(notificationFirst.started('native-late').id, early.id)
assert.equal(notificationFirst.completedItem('native-late').id, early.id)

const interleaved = new ContextCompactionLifecycle(() => 'thread-3')
const invocationA = interleaved.beginInvocation()
const invocationB = interleaved.beginInvocation()
interleaved.alias('native-a', invocationA.id)
assert.equal(interleaved.started('native-a').id, invocationA.id)
assert.equal(interleaved.started('native-b').id, invocationB.id, 'a second native item must claim the second pending invocation')
assert.equal(interleaved.completedItem('native-b').id, invocationB.id)
assert.equal(interleaved.completedItem('native-a').id, invocationA.id)
assert.notEqual(invocationA.id, invocationB.id)

const reverseCompletion = new ContextCompactionLifecycle(() => 'thread-4')
const reverseA = reverseCompletion.beginInvocation()
const reverseB = reverseCompletion.beginInvocation()
reverseCompletion.alias('native-reverse-b', reverseB.id)
reverseCompletion.alias('native-reverse-a', reverseA.id)
assert.equal(reverseCompletion.started('native-reverse-a').id, reverseA.id)
assert.equal(reverseCompletion.started('native-reverse-b').id, reverseB.id)
assert.equal(reverseCompletion.completedItem('native-reverse-b').id, reverseB.id, 'B may complete before A')
assert.equal(reverseCompletion.completedItem('native-reverse-a').id, reverseA.id, 'A must retain its own stable id')
assert.equal(reverseCompletion.compacted('native-reverse-b'), null, 'an id-bearing thread notification dedupes B')
assert.equal(reverseCompletion.compacted(), null, 'second no-id thread notification dedupes independently')

// Native notifications may precede the empty RPC response. The second request
// cannot enter the lifecycle until the first reaches a terminal notification.
const responseBeforeNextStart = new ContextCompactionLifecycle(() => 'thread-5')
const invocationQueue = new CompactionInvocationQueue()
let releaseAResponse
let releaseBResponse
let releaseATerminal
let releaseBTerminal
const aResponse = new Promise((resolve) => { releaseAResponse = resolve })
const bResponse = new Promise((resolve) => { releaseBResponse = resolve })
const aTerminal = new Promise((resolve) => { releaseATerminal = resolve })
const bTerminal = new Promise((resolve) => { releaseBTerminal = resolve })
const startedIds = []
const requestA = invocationQueue.run(async () => {
  const invocation = responseBeforeNextStart.beginInvocation()
  startedIds.push(invocation.id)
  await aResponse
  await aTerminal
})
const requestB = invocationQueue.run(async () => {
  const invocation = responseBeforeNextStart.beginInvocation()
  startedIds.push(invocation.id)
  await bResponse
  await bTerminal
})
await Promise.resolve()
assert.equal(startedIds.length, 1, 'B must not begin while A is active')
assert.equal(responseBeforeNextStart.compacted(), null)
await Promise.resolve()
assert.equal(startedIds.length, 1, 'a no-id thread notice must not release A or start B')
assert.equal(responseBeforeNextStart.started('native-a-before-response').id, startedIds[0])
const completedA = responseBeforeNextStart.completedItem('native-a-before-response')
assert.equal(completedA.id, startedIds[0])
releaseATerminal()
releaseAResponse({})
await requestA
await Promise.resolve()
assert.equal(startedIds.length, 2, 'B begins only after A is terminal')
assert.equal(responseBeforeNextStart.started('native-b-before-response').id, startedIds[1])
const failedB = responseBeforeNextStart.completedItem('native-b-before-response', true, 'B failed')
assert.equal(failedB.id, startedIds[1])
releaseBTerminal()
releaseBResponse({})
await requestB
assert.notEqual(startedIds[0], startedIds[1])

const closableQueue = new CompactionInvocationQueue()
let releaseCurrent
const currentGate = new Promise((resolve) => { releaseCurrent = resolve })
let queuedStarted = false
const current = closableQueue.run(async () => currentGate)
const queued = closableQueue.run(async () => { queuedStarted = true })
const queuedRejected = assert.rejects(queued, /disposed/)
await Promise.resolve()
closableQueue.close(new Error('disposed'))
releaseCurrent()
await current
await queuedRejected
assert.equal(queuedStarted, false, 'closing the queue must prevent pending invocations from starting')
await assert.rejects(closableQueue.run(async () => undefined), /disposed/, 'new work is rejected after close')

const activity = new CompactionActivityGate()
assert.equal(activity.manualUnavailableReason(), undefined)
activity.turnStarted('turn-a')
assert.match(activity.manualUnavailableReason(), /运行中/, 'manual compact is blocked for the whole active turn')
activity.turnStarted('turn-b')
activity.turnFinished('turn-a')
assert.match(activity.manualUnavailableReason(), /运行中/, 'one finishing turn cannot clear another active turn')
activity.turnFinished('turn-a')
assert.match(activity.manualUnavailableReason(), /运行中/, 'duplicate old completion cannot clear the newer turn token')
activity.turnFinished('turn-b')
assert.equal(activity.manualUnavailableReason(), undefined)
activity.turnStarted('turn-c')
activity.turnStarted('turn-d')
activity.resetTurns()
assert.equal(activity.manualUnavailableReason(), undefined, 'dispose resets every outstanding turn token')
activity.nativeStarted('native-auto')
assert.match(activity.manualUnavailableReason(), /正在压缩/, 'an independent native compaction blocks local invocation')
activity.nativeFinished('native-auto')
assert.equal(activity.manualUnavailableReason(), undefined)

const deferred = new DeferredTurnCompletions()
const oldCompletion = { id: 'old-turn', status: 'interrupted' }
const sameChunkCompletion = { id: 'new-turn', status: 'completed' }
deferred.defer(oldCompletion.id, oldCompletion)
deferred.defer(sameChunkCompletion.id, sameChunkCompletion)
assert.equal(deferred.claim('new-turn'), sameChunkCompletion, 'response continuation claims only its exact early completion')
assert.equal(deferred.claim('old-turn'), undefined, 'stale completion is discarded when the native id is established')
console.log('context-compaction-lifecycle: ok')
