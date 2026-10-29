// Drive a real task through the running UniAgent app via its exposed IPC API,
// then collect streamed events until the turn completes.
async function getPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:9222/json')
      const targets = await r.json()
      const page = targets.find((t) => t.type === 'page')
      if (page) return page
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('no page target')
}

const page = await getPage()
const ws = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  }
})
async function evaluate(expression, awaitPromise = true) {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true
  })
  if (r.exceptionDetails)
    throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result?.value
}
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
await send('Runtime.enable')

const agentId = process.argv[2] || 'codex'
const marker = process.argv[3] || 'HELLO_FROM_UI'
const workdir = process.cwd()

// Install an event collector on the page, then create a session through the real app path.
const setup = await evaluate(`(async () => {
  window.__ua_events = [];
  if (!window.__ua_hooked) {
    window.__ua_hooked = true;
    window.uniagent.onEvent((ev) => window.__ua_events.push(ev));
  }
  const session = await window.uniagent.createSession({
    agentId: ${JSON.stringify(agentId)},
    thinkingLevel: 'standard',
    workdir: ${JSON.stringify(workdir)},
    permissionMode: 'auto'
  }, 'Reply with exactly the token ${marker} and nothing else.');
  return JSON.stringify(session);
})()`)
console.log('SESSION:', setup)
const session = JSON.parse(setup)

// Poll for completion.
let done = false
let events = []
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  const snap = await evaluate(`JSON.stringify({
    status: (window.__ua_events.filter(e => e.sessionId === ${JSON.stringify(session.id)} && e.type === 'status')).slice(-1)[0]?.payload?.status || null,
    events: window.__ua_events.filter(e => e.sessionId === ${JSON.stringify(session.id)})
  })`)
  const parsed = JSON.parse(snap)
  events = parsed.events
  const types = events.map((e) => e.type)
  // Only turn_completed is terminal. Codex emits non-fatal warnings as `error`
  // events (e.g. hooks.json duplicate) that must not end the wait.
  if (types.includes('turn_completed')) {
    await new Promise((r) => setTimeout(r, 400))
    done = true
  }
  if (done) break
}

const finalSnap = await evaluate(
  `JSON.stringify(window.__ua_events.filter(e => e.sessionId === ${JSON.stringify(session.id)}))`
)
const all = JSON.parse(finalSnap)
console.log('\n=== EVENT TYPES ===')
console.log(all.map((e) => e.type).join(', '))
console.log('\n=== TEXT/MESSAGE PAYLOADS ===')
for (const e of all) {
  if (e.type === 'agent_message' || e.type === 'user_message' || e.type === 'error') {
    console.log(e.type + ': ' + JSON.stringify(e.payload).slice(0, 600))
  }
}
const blob = JSON.stringify(all)
console.log('\n=== MARKER PRESENT:', blob.includes(marker), '===')
ws.close()
process.exit(0)
