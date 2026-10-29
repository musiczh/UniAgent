// Packaged-app verification for the writable/available sidebar contract.
const port = process.argv[2] || '9222'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let target
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json`)
    const targets = await response.json()
    target = targets.find((item) => item.type === 'page' && /index\.html/.test(item.url))
    if (target?.webSocketDebuggerUrl) break
  } catch {
    // App is still starting.
  }
  await sleep(250)
}
if (!target?.webSocketDebuggerUrl) throw new Error(`no page on port ${port}`)

const ws = new WebSocket(target.webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result)
})
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}

try {
  await send('Runtime.enable')
  // Other packaged suites exercise import/fork IPC directly, bypassing the UI
  // handlers that update React state. Reload once so this independent check
  // starts from the authoritative SessionStore rather than their stale page.
  await send('Page.enable')
  await send('Page.reload', { ignoreCache: true })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const ready = await evaluate(
        `document.readyState === 'complete' && !!window.uniagent && !!document.querySelector('.session-list')`
      )
      if (ready) break
    } catch {
      // The old execution context is being replaced.
    }
    await sleep(100)
  }
  let snapshot
  const deadline = Date.now() + 30_000
  do {
    snapshot = JSON.parse(await evaluate(`(async()=>{
      const [agents, sessions] = await Promise.all([
        window.uniagent.listAgents(),
        window.uniagent.listSessions()
      ]);
      const available = new Set(agents
        .filter((agent) => agent.lifecycle?.availability === 'available')
        .map((agent) => agent.id));
      const eligible = sessions.filter((session) =>
        !session.archived &&
        available.has(session.config.agentId) &&
        session.readOnly !== true &&
        !(session.origin === 'imported' && session.forkedFrom == null &&
          !(session.importMode === 'direct' && session.readOnly === false))
      );
      const hiddenSnapshots = sessions.filter((session) =>
        session.readOnly === true ||
        (session.origin === 'imported' && session.forkedFrom == null &&
          !(session.importMode === 'direct' && session.readOnly === false))
      );
      const hiddenUnavailable = sessions.filter((session) => !available.has(session.config.agentId));
      return JSON.stringify({
        expected: eligible.map((session) => session.id).sort(),
        visible: [...document.querySelectorAll('.sl-body .session-item[data-session-id]')]
          .map((row) => row.getAttribute('data-session-id')).filter(Boolean).sort(),
        hiddenSnapshots: hiddenSnapshots.length,
        hiddenUnavailable: hiddenUnavailable.length,
        leakedReadOnlyTag: !!document.querySelector('.sl-body .si-tag-ro')
      });
    })()`))
    if (JSON.stringify(snapshot.visible) === JSON.stringify(snapshot.expected)) break
    await sleep(200)
  } while (Date.now() < deadline)

  const exact = JSON.stringify(snapshot.visible) === JSON.stringify(snapshot.expected)
  console.log(`${exact ? '✅' : '❌'} sidebar contains exactly writable sessions for available Agents`)
  console.log(`${snapshot.hiddenSnapshots > 0 ? '✅' : '❌'} fixture includes filtered imported/read-only snapshots (${snapshot.hiddenSnapshots})`)
  console.log(`${snapshot.hiddenUnavailable > 0 ? '✅' : '…'} unavailable-Agent fixture coverage (${snapshot.hiddenUnavailable}; optional when every Agent is available)`)
  console.log(`${!snapshot.leakedReadOnlyTag ? '✅' : '❌'} no read-only snapshot is rendered`)
  if (!exact || snapshot.hiddenSnapshots < 1 || snapshot.leakedReadOnlyTag) {
    process.exitCode = 1
    console.error(JSON.stringify(snapshot, null, 2))
  }
} finally {
  ws.close()
}
