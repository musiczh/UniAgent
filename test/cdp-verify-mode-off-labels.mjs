// Verify requirement 4 in the real packaged renderer via CDP.
// Usage: node test/cdp-verify-mode-off-labels.mjs [port]
const port = process.argv[2] || '9222'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function pageTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const page = targets.find((target) => target.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch {}
    await sleep(250)
  }
  throw new Error(`no page on port ${port}`)
}

const page = await pageTarget()
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  const waiter = pending.get(message.id)
  if (!waiter) return
  pending.delete(message.id)
  message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result)
})
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++id
    pending.set(requestId, { resolve, reject })
    ws.send(JSON.stringify({ id: requestId, method, params }))
  })
}

async function evaluate(expression) {
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

await send('Runtime.enable')
await evaluate(`document.querySelector('.btn-new')?.click()`)
await sleep(400)

const agents = JSON.parse(
  await evaluate(`(async()=>JSON.stringify(await window.uniagent.detectAgents()))()`)
)

async function selectAgent(agentId) {
  const selected = await evaluate(`(()=>{
    const select=document.querySelector('.new-task .config-bar .cfg select');
    if(!select)return false;
    const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
    setter.call(select,${JSON.stringify(agentId)});
    select.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  })()`)
  if (!selected) throw new Error('new-task Agent selector not found')
  await sleep(500)
}

async function selectModel(label) {
  await evaluate(`document.querySelector('.new-task .model-picker .mp-trigger')?.click()`)
  await sleep(150)
  const changed = await evaluate(`(()=>{
    const option=[...document.querySelectorAll('.new-task .model-picker .mp-opt')]
      .find((node)=>node.textContent?.includes(${JSON.stringify(label)}));
    if(!option)return false;
    option.click();
    return true;
  })()`)
  if (!changed) throw new Error(`model option not found: ${label}`)
  await sleep(300)
}

async function verifyToggle({ agentId, selector, offText, onText, supportingModel }) {
  await selectAgent(agentId)
  if (!(await documentButtonExists(selector)) && supportingModel) await selectModel(supportingModel.label)
  let before = await textOf(selector)
  // Preferences may restore the toggle as enabled. Normalize to the off state so
  // this verifies both labels deterministically without mutating the saved value.
  if (before.includes(onText)) {
    await evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`)
    await sleep(200)
    before = await textOf(selector)
  }
  if (!before.includes(offText)) throw new Error(`${agentId} off label was "${before}"`)
  await evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`)
  await sleep(200)
  const on = await textOf(selector)
  if (!on.includes(onText)) throw new Error(`${agentId} on label was "${on}"`)
  await evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`)
  await sleep(200)
  const restored = await textOf(selector)
  if (!restored.includes(offText)) throw new Error(`${agentId} restored label was "${restored}"`)
  console.log(`PASS ${agentId}: ${before} -> ${on} -> ${restored}`)
}

async function documentButtonExists(selector) {
  return Boolean(await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`))
}

async function textOf(selector) {
  return String(
    (await evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent?.trim() || ''`)) || ''
  )
}

const codex = agents.find((agent) => agent.id === 'codex' && agent.installed)
const fastModel = codex?.models.find((model) => model.supportsFast)
if (!codex || !fastModel) throw new Error('installed Codex with a Fast-capable model is required')
await verifyToggle({
  agentId: 'codex',
  selector: '.new-task .cfg-fast:not(.cfg-max)',
  offText: '快速·关',
  onText: '快速·开',
  supportingModel: fastModel
})

const traex = agents.find((agent) => agent.id === 'traex' && agent.installed)
const maxModel = traex?.models.find((model) => model.supportsMax)
if (!traex || !maxModel) throw new Error('installed TraeX with a Max-capable model is required')
await verifyToggle({
  agentId: 'traex',
  selector: '.new-task .cfg-max',
  offText: 'Max·关',
  onText: 'Max·开',
  supportingModel: maxModel
})

ws.close()
