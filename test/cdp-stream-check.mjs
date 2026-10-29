// Quick streaming verification against the RUNNING packaged app via CDP.
// Confirms: app boots, detects codex/traex with capabilities.streaming=true,
// and a real streaming turn produces multiple increasing agent_message
// snapshots (token-level deltas) ending in turn_completed with the marker.
// Usage: node test/cdp-stream-check.mjs [port] [agentId]
const port = process.argv[2] || '9223'
const agentId = process.argv[3] || 'codex'

async function getPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json')
      const t = await r.json()
      const p = t.find((x) => x.type === 'page')
      if (p && p.webSocketDebuggerUrl) return p
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('no page on port ' + port)
}

const page = await getPage()
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 1
const pend = new Map()
const send = (m, p = {}) =>
  new Promise((res, rej) => {
    const i = id++
    pend.set(i, { res, rej })
    ws.send(JSON.stringify({ id: i, method: m, params: p }))
  })
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) {
    const { res, rej } = pend.get(m.id)
    pend.delete(m.id)
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
  }
})
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result?.value
}
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
await send('Runtime.enable')

// Install event sink + report detected streaming capability.
await ev(`(()=>{window.__e=window.__e||[];if(!window.__h){window.__h=1;window.uniagent.onEvent(x=>window.__e.push(x));}return 1;})()`)
const caps = JSON.parse(
  await ev(
    `(async()=>{const a=await window.uniagent.detectAgents();return JSON.stringify(a.map(x=>({id:x.id,installed:x.installed,streaming:x.capabilities.streaming})));})()`
  )
)
console.log('DETECTED:', caps.map((c) => `${c.id}=${c.installed ? 'yes' : 'no'}/stream:${c.streaming === true}`).join('  '))
const target = caps.find((c) => c.id === agentId)
if (!target || !target.installed) {
  console.log(`SKIP: ${agentId} not installed`)
  ws.close()
  process.exit(0)
}

const marker = `UA_STREAM_${agentId.toUpperCase()}_${Math.floor(Math.random() * 100000)}`
const sid = await ev(
  `(async()=>{const s=await window.uniagent.createSession({agentId:${JSON.stringify(agentId)},workdir:window.uniagent.homeDir,permissionMode:'read-only'},'Write a two-sentence description of the ocean, then end with the token ${marker}');return s.id;})()`
)

// Poll and capture the *count of distinct running agent_message snapshots* and
// whether accumulated text length strictly grew (proof of token streaming).
let done = false
let snapshots = []
for (let i = 0; i < 180; i++) {
  await new Promise((r) => setTimeout(r, 500))
  const snap = JSON.parse(
    await ev(
      `JSON.stringify(window.__e.filter(e=>e.sessionId===${JSON.stringify(sid)}).map(e=>({t:e.type,s:e.state,len:(e.payload&&e.payload.text||'').length})))`
    )
  )
  snapshots = snap
  if (snap.some((e) => e.t === 'turn_completed')) {
    await new Promise((r) => setTimeout(r, 400))
    done = true
    break
  }
}
const all = JSON.parse(
  await ev(`JSON.stringify(window.__e.filter(e=>e.sessionId===${JSON.stringify(sid)}))`)
)
const running = all.filter((e) => e.type === 'agent_message' && e.state === 'running')
const lens = running.map((e) => (e.payload.text || '').length)
const streamed = lens.length >= 2 && lens[lens.length - 1] > lens[0]
const finalText = (all.filter((e) => e.type === 'agent_message').slice(-1)[0]?.payload?.text) || ''
const markerSeen = JSON.stringify(all).includes(marker)
console.log('done:', done, '| runningSnapshots:', lens.length, '| lens:', JSON.stringify(lens.slice(0, 12)))
console.log('streamed(token-level):', streamed, '| markerSeen:', markerSeen)
console.log('finalText:', JSON.stringify(finalText.slice(0, 200)))
const ok = done && streamed && markerSeen
console.log(ok ? '\n✅ PASS (real streaming in packaged GUI)' : '\n❌ FAIL')
ws.close()
process.exit(ok ? 0 : 1)
