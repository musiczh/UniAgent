// E2E matrix driver: drives the running packaged app via CDP, exercising the
// new cascading config (agent -> real model -> supported effort -> permission).
// Usage: node test/cdp-matrix.mjs [port]
// It reads each installed agent's REAL model list from the app, picks a model
// that supports efforts, and runs a task per (agent, permissionMode) case.

const port = process.argv[2] || '9223'

async function getPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json')
      const t = await r.json()
      const p = t.find((x) => x.type === 'page')
      if (p) return p
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

// Install a single global event sink.
await ev(`(()=>{window.__e=window.__e||[];if(!window.__h){window.__h=1;window.uniagent.onEvent(x=>window.__e.push(x));}return 1;})()`)

// Pull the detected agents with their real model lists.
const agents = await ev(`(async()=>{const a=await window.uniagent.detectAgents();return JSON.stringify(a.map(x=>({id:x.id,name:x.name,installed:x.installed,caps:x.capabilities,models:x.models})));})()`)
const agentDefs = JSON.parse(agents)
console.log('DETECTED:', agentDefs.map((a) => `${a.name}=${a.installed ? 'yes' : 'no'}`).join(', '))

// Build a test matrix: for each installed agent, choose a model that supports
// efforts (to prove the cascade), then run two permission modes.
const cases = []
for (const a of agentDefs) {
  if (!a.installed) continue
  const withEffort = a.models.find((m) => m.efforts && m.efforts.length > 0) || a.models[0]
  if (!withEffort) continue
  const eff = withEffort.efforts && withEffort.efforts.length ? withEffort.defaultEffort || withEffort.efforts[0] : undefined
  const perms = a.caps.permissionModes
  // one read-only case and one auto-edit case per agent
  cases.push({ agentId: a.id, name: a.name, model: withEffort.id, effort: eff, perm: 'read-only' })
  if (perms.some((m) => m.id === 'auto-edit'))
    cases.push({ agentId: a.id, name: a.name, model: withEffort.id, effort: eff, perm: 'auto-edit' })
}

let pass = 0
let fail = 0
const results = []

for (const c of cases) {
  const marker = `UA_${c.agentId.toUpperCase()}_${c.perm.replace('-', '').toUpperCase()}_${Math.floor(Math.random() * 100000)}`
  const cfg = JSON.stringify({
    agentId: c.agentId,
    model: c.model,
    effort: c.effort,
    workdir: '__HOME__',
    permissionMode: c.perm
  })
  const sid = await ev(
    `(async()=>{const cfg=${cfg};cfg.workdir=window.uniagent.homeDir;const s=await window.uniagent.createSession(cfg,'Reply with exactly the token ${marker} and nothing else.');return s.id;})()`
  )
  const started = Date.now()
  let done = false
  for (let i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const types = JSON.parse(
      await ev(`JSON.stringify(window.__e.filter(e=>e.sessionId===${JSON.stringify(sid)}).map(e=>e.type))`)
    )
    if (types.includes('turn_completed')) {
      done = true
      await new Promise((r) => setTimeout(r, 400))
      break
    }
  }
  const all = JSON.parse(
    await ev(`JSON.stringify(window.__e.filter(e=>e.sessionId===${JSON.stringify(sid)}))`)
  )
  const launch = all.find((e) => e.type === 'system_notice' && e.payload?.kind === 'launch')
  const agentMsgs = all.filter((e) => e.type === 'agent_message').map((e) => e.payload.text)
  const hardErrors = all.filter(
    (e) => e.type === 'error' && e.state === 'failed'
  )
  const markerSeen = JSON.stringify(all).includes(marker)
  const ok = done && markerSeen && hardErrors.length === 0
  if (ok) pass++
  else fail++
  results.push({
    case: `${c.name} / model=${c.model} / effort=${c.effort || '-'} / perm=${c.perm}`,
    ok,
    done,
    markerSeen,
    hardErrors: hardErrors.map((e) => e.payload?.message),
    cmd: launch?.payload?.text?.slice(0, 200),
    dur: ((Date.now() - started) / 1000).toFixed(1) + 's',
    reply: agentMsgs.join(' | ').slice(0, 120)
  })
  console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${c.name} model=${c.model} effort=${c.effort || '-'} perm=${c.perm} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
  console.log('  cmd:', launch?.payload?.text?.slice(0, 240))
  console.log('  reply:', agentMsgs.join(' | ').slice(0, 160))
  if (hardErrors.length) console.log('  ERRORS:', JSON.stringify(hardErrors.map((e) => e.payload?.message)))
}

console.log('\n========== SUMMARY ==========')
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.case}  [${r.dur}]`)
console.log(`\nPASS=${pass} FAIL=${fail}`)
ws.close()
process.exit(fail === 0 ? 0 : 1)
