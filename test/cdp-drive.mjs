// Drive the running UniAgent UI over the Chrome DevTools Protocol.
// Usage: node test/cdp-drive.mjs "<js-expression-to-eval>"
async function getPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const httpRes = await fetch('http://127.0.0.1:9222/json')
      const targets = await httpRes.json()
      const page = targets.find((t) => t.type === 'page')
      if (page) return page
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('no page target after retries')
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
  if (r.exceptionDetails) {
    throw new Error(
      'eval error: ' +
        (r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    )
  }
  return r.result?.value
}

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

await send('Runtime.enable')
await send('Page.enable')

const expr = process.argv[2]
if (expr) {
  const out = await evaluate(expr)
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2))
}

ws.close()
