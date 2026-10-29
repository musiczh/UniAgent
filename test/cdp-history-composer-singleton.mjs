import assert from 'node:assert/strict'
import WebSocket from 'ws'

const port = process.argv[2] || '9222'
const titleFragment = process.argv[3]
if (!titleFragment) throw new Error('usage: node test/cdp-history-composer-singleton.mjs <port> <title-fragment>')

const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json())
const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
if (!page) throw new Error(`no renderer target on port ${port}`)

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result)
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const response = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
  }
  return response.result?.value
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  await send('Runtime.enable')
  await evaluate(`document.querySelector('.btn-new')?.click()` )
  await sleep(150)

  const selected = await evaluate(`(() => {
    const titleFragment = ${JSON.stringify(titleFragment)};
    const rows = [...document.querySelectorAll('[data-session-id]')];
    const row = rows.find((candidate) => (candidate.textContent || '').includes(titleFragment));
    if (!row) return null;
    row.click();
    return { id: row.getAttribute('data-session-id'), title: row.textContent };
  })()` )
  assert.ok(selected, `no history session matched ${JSON.stringify(titleFragment)}`)

  let maximumComposerCount = 0
  const samples = []
  for (let index = 0; index < 40; index++) {
    await sleep(100)
    const sample = await evaluate(`({
      composerCount: document.querySelectorAll('.session-view > .composer-wrap').length,
      loading: !!document.querySelector('.session-loading')
    })` )
    samples.push(sample)
    maximumComposerCount = Math.max(maximumComposerCount, sample.composerCount)
  }

  assert.equal(
    maximumComposerCount,
    1,
    `opening ${selected.id} mounted multiple composers: ${JSON.stringify(samples)}`
  )
  console.log(`history composer singleton: ok (${selected.id})`)
} finally {
  socket.close()
}
