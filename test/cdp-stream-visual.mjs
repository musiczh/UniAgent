// Drive a REAL streaming turn through the packaged GUI the way a user does:
// type into the composer textarea (React-compatible), click 开始, then watch
// the ACTUAL DOM (.agent-msg) grow token-by-token — capturing a mid-stream and
// a final screenshot. This exercises the true render path (handleCreate ->
// setActiveId -> EventStream), not just the backend IPC.
// Usage: node test/cdp-stream-visual.mjs [port] [agentId]
const port = process.argv[2] || '9226'
const agentId = process.argv[3] || 'codex'
const fs = await import('node:fs')

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
const shot = async (path) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path, Buffer.from(r.data, 'base64'))
  console.log('  shot:', path)
}
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
await send('Runtime.enable')
await send('Page.enable')

const caps = JSON.parse(
  await ev(
    `(async()=>{const a=await window.uniagent.detectAgents();return JSON.stringify(a.map(x=>({id:x.id,installed:x.installed,streaming:x.capabilities.streaming})));})()`
  )
)
console.log('DETECTED:', caps.map((c) => `${c.id}=${c.installed ? 'yes' : 'no'}/stream:${c.streaming === true}`).join('  '))

const marker = `UA_VIS_${agentId.toUpperCase()}_${Math.floor(Math.random() * 100000)}`
const promptText = `Write exactly 4 sentences about why the sky is blue, as flowing prose. End the last sentence with the token ${marker}.`

// 1) Select the agent in the dropdown (React-controlled) if not already.
// 2) Type the prompt into the textarea via the native setter + input event.
// 3) Click 开始. All through the real DOM + React handlers.
const drove = await ev(`(() => {
  const setNativeValue = (el, value) => {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLSelectElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  // agent select is the first .cfg select
  const selects = [...document.querySelectorAll('.config-bar select')]
  const agentSel = selects[0]
  if (agentSel) {
    const opt = [...agentSel.options].find(o => o.value === ${JSON.stringify(agentId)})
    if (opt && agentSel.value !== ${JSON.stringify(agentId)}) setNativeValue(agentSel, ${JSON.stringify(agentId)})
  }
  const ta = document.querySelector('textarea.prompt-input')
  if (!ta) return 'no-textarea'
  setNativeValue(ta, ${JSON.stringify(promptText)})
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('开始'))
  if (!btn) return 'no-button'
  btn.click()
  return 'clicked'
})()`)
console.log('drove UI:', drove)
if (drove !== 'clicked') {
  console.log('❌ FAIL: could not drive composer')
  ws.close()
  process.exit(1)
}

// Poll the DOM: capture the moment .agent-msg is partial (streaming), then final.
// Also assert node STABILITY: tag the streaming node once; if React remounts it
// per delta (the flashing bug), the tag disappears and reappears on a fresh
// node. A stable tag across many deltas proves text grows in place (no flash).
let midShot = false
let done = false
let maxLen = 0
let tagged = false
let tagSurvivedChecks = 0
let tagLost = 0
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 200))
  const st = JSON.parse(
    await ev(`(() => {
      const el = document.querySelector('.agent-msg')
      const txt = el ? el.innerText : ''
      const streaming = !!document.querySelector('.agent-msg.streaming')
      const cursor = !!document.querySelector('.stream-cursor')
      const idle = !!document.querySelector('.status-idle')
      let tag = 'na'
      if (el) {
        if (el.dataset.uatag === '1') tag = 'survived'
        else { el.dataset.uatag = '1'; tag = 'set' }
      }
      return JSON.stringify({ len: txt.length, streaming, cursor, idle, has: !!el, tag })
    })()`)
  )
  if (st.len > maxLen) maxLen = st.len
  // Track tag stability during the streaming (running) phase only.
  if (st.streaming && st.has) {
    if (st.tag === 'set') {
      if (tagged) tagLost++ // node was remounted -> lost previous tag (flash!)
      tagged = true
    } else if (st.tag === 'survived') {
      tagSurvivedChecks++
    }
  }
  if (!midShot && st.streaming && st.len > 15) {
    await shot(`/tmp/ua-stream-${agentId}-mid.png`)
    console.log('  mid-stream DOM len:', st.len, 'cursor:', st.cursor)
    midShot = true
  }
  if (st.idle && st.len > 0) {
    await new Promise((r) => setTimeout(r, 400))
    await shot(`/tmp/ua-stream-${agentId}-final.png`)
    done = true
    break
  }
}

const finalDom = await ev(
  `(() => { const el = document.querySelector('.agent-msg'); return el ? el.innerText : '(none)'; })()`
)
const markerInDom = finalDom.includes(marker)
const expectStreaming = caps.find((c) => c.id === agentId)?.streaming === true
console.log('done:', done, '| midShotCaptured:', midShot, '| maxDomLen:', maxLen)
console.log(
  'node stability (streaming phase): survivedChecks=' + tagSurvivedChecks + ' remounts=' + tagLost
)
console.log('final DOM .agent-msg:', JSON.stringify(finalDom.slice(0, 220)))
console.log('markerInDom:', markerInDom)

let ok
if (expectStreaming) {
  // Real streaming: reply must appear mid-stream, grow, carry the marker, and
  // the DOM node must NOT remount per delta (0 remounts + several survivals).
  ok = done && midShot && markerInDom && maxLen > 20 && tagLost === 0 && tagSurvivedChecks >= 3
} else {
  // One-shot (claude): no mid-stream frame expected; just verify final render.
  ok = done && markerInDom && maxLen > 20
}
console.log(
  ok
    ? `\n✅ PASS ${agentId} (${expectStreaming ? 'token-level streaming grows in place, no flash' : 'one-shot render OK'})`
    : `\n❌ FAIL ${agentId}`
)
ws.close()
process.exit(ok ? 0 : 1)
