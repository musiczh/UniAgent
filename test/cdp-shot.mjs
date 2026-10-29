// Select the first session in the UI, wait for render, then grab a screenshot
// straight from the renderer via CDP Page.captureScreenshot (works headless).
import { writeFileSync } from 'node:fs'

async function getPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:9222/json')
      const t = await r.json()
      const p = t.find((x) => x.type === 'page')
      if (p) return p
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('no page')
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
await send('Page.enable')

// Drive the REAL UI: type a prompt into the composer and click 开始 so the
// session flows through React state (window.uniagent.createSession alone does
// not update the renderer's session list).
const started = await ev(`(() => {
  const ta = document.querySelector('textarea.prompt-input')
  if (!ta) return 'no-textarea'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, '用一句中文简短介绍你自己。')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  // Find and click 开始 (send) button.
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('开始'))
  if (!btn) return 'no-button'
  if (btn.disabled) return 'button-disabled(workdir=' + JSON.stringify(window.uniagent.homeDir) + ')'
  btn.click()
  return 'started'
})()`)
console.log('start:', started)

// Wait until idle (turn done) or timeout.
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  const state = await ev(`(() => {
    const b = document.body.innerText
    if (b.includes('运行中')) return 'running'
    if (b.includes('空闲')) return 'idle'
    return '?'
  })()`)
  if (i > 3 && state === 'idle') break
}

await new Promise((r) => setTimeout(r, 600))

const info = await ev(`JSON.stringify({
  header: !!document.querySelector('.session-header'),
  eventCount: document.querySelectorAll('.event, .event-row, .stream-item, .es-item').length,
  bodyLen: document.body.innerText.length
})`)
console.log('view info:', info)

const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
writeFileSync(process.argv[2] || '/tmp/uashots/ua-session.png', Buffer.from(shot.data, 'base64'))
console.log('screenshot saved')
ws.close()
process.exit(0)
