import process from 'node:process'

const port = Number(process.argv[2] || 9222)
const targets = await fetch('http://127.0.0.1:' + port + '/json').then((response) => response.json())
const page = targets.find((target) => target.type === 'page')
if (!page) throw new Error('no page target on ' + port)
const ws = new WebSocket(page.webSocketDebuggerUrl)
let sequence = 0
const pending = new Map()
ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
}
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
function cdp(method, params = {}) {
  const id = ++sequence
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => pending.set(id, resolve))
}
async function evaluate(expression) {
  const response = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text)
  return response.result.result.value
}
function check(name, condition, detail = '') {
  if (!condition) throw new Error('FAIL ' + name + ': ' + detail)
  console.log('✓ ' + name)
}
await evaluate("window.uniagent.e2eLifecycleFixture('zero')")
await cdp('Page.reload')
await new Promise((resolve) => setTimeout(resolve, 700))
const setup = JSON.parse(await evaluate("JSON.stringify({cards:document.querySelectorAll('.first-setup-card').length,text:document.body.innerText,buttons:Array.from(document.querySelectorAll('.first-setup-card button')).map(b=>b.textContent.trim())})"))
check('zero-agent first setup has one card per built-in agent', setup.cards === 4, String(setup.cards))
check('setup has install and login guidance', setup.text.includes('安装：') && setup.text.includes('登录：'))
check('setup copy actions and redetect', setup.buttons.filter(x=>x==='复制安装命令').length === 4 && setup.buttons.filter(x=>x==='复制登录命令').length === 4 && setup.text.includes('重新检测'))
await evaluate("window.uniagent.e2eLifecycleFixture('mixed')")
await cdp('Page.reload')
await new Promise((resolve) => setTimeout(resolve, 700))
check('experience task is offered', await evaluate("!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('体验任务'))"))
await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('设置'))?.click()")
await new Promise((resolve) => setTimeout(resolve, 250))
// 设置中心默认打开「通用」分类；CLI 状态列表在「Agent」分类页。
await evaluate("(()=>{const n=Array.from(document.querySelectorAll('.set-nav-item')).find(x=>(x.querySelector('.lbl')||{}).textContent==='Agent');if(n)n.click();return !!n;})()")
await new Promise((resolve) => setTimeout(resolve, 250))
const state = JSON.parse(await evaluate(`JSON.stringify((()=>{
  const page=document.querySelector('.set-page:not([hidden])');
  const group=Array.from(page?.querySelectorAll('.set-group')||[]).find(g=>(g.querySelector('.set-group-t')?.textContent||'').includes('CLI 状态'));
  const rows=group?Array.from(group.querySelectorAll('.row')):[];
  return {
    text:document.body.innerText,
    auto:page?.querySelector('[role=switch][aria-label="启动时自动更新 Agent CLI"]')?.getAttribute('aria-checked'),
    buttons:Array.from(page?.querySelectorAll('.set-mini-btn')||[]).map(b=>b.textContent.trim()),
    labels:rows.map(row=>(row.querySelector('.r-label')?.textContent||'').trim()),
    rows:rows.map(row=>({text:row.textContent,buttons:Array.from(row.querySelectorAll('button')).map(b=>b.textContent.trim())}))
  };
})())`))
check('lifecycle status labels', state.text.includes('可用') && state.text.includes('待登录') && state.text.includes('未安装'))
check('automatic update defaults off', state.auto === 'false', String(state.auto))
check('lifecycle actions', state.buttons.includes('重新检测') && state.buttons.includes('初始化'), state.buttons.join(','))
const builtinNames = ['Codex', 'TraeX', 'Claude Code', 'Grok']
check(
  'lifecycle rows cover exactly the built-in agents',
  state.labels.length === builtinNames.length && builtinNames.every((name) => state.labels.filter((label) => label.includes(name)).length === 1),
  JSON.stringify(state.labels)
)
check(
  'every lifecycle row exposes local actions only',
  state.rows.every((row) => row.buttons.length > 0 && !/管理更新/.test(row.text)),
  JSON.stringify(state.rows.map((row) => row.text.slice(0, 40)))
)
// Codex carries a fixture update (1.0.0 → 1.1.0): its detail page must show the
// transition plus the update action. The update itself is never clicked.
await evaluate("(()=>{const row=Array.from(document.querySelectorAll('.set-page:not([hidden]) .rowlink')).find(x=>(x.querySelector('.r-label')||{}).textContent?.includes('Codex'));if(row)row.click();return !!row;})()")
await new Promise((resolve) => setTimeout(resolve, 250))
const detail = JSON.parse(await evaluate("JSON.stringify({title:(document.querySelector('.set-page:not([hidden]) .set-detail-title h2')?.textContent||'').trim(),vers:Array.from(document.querySelectorAll('.set-page:not([hidden]) .ver')).map((x)=>x.textContent.trim()),buttons:Array.from(document.querySelectorAll('.set-page:not([hidden]) .set-mini-btn')).map((b)=>b.textContent.trim())})"))
check('version transition', detail.title === 'Codex' && detail.vers.join(' ') === '1.0.0 → 1.1.0', JSON.stringify(detail))
check('agent detail exposes the update action', detail.buttons.includes('更新'), detail.buttons.join(','))
await evaluate("(()=>{const b=document.querySelector('.set-page:not([hidden]) .set-back');if(b)b.click();return !!b;})()")
await new Promise((resolve) => setTimeout(resolve, 250))
const originalPermission = await evaluate("Array.from(document.querySelectorAll('.new-task label.cfg')).find(x=>x.textContent.includes('权限'))?.querySelector('select')?.value")
await evaluate("(()=>{const b=Array.from(document.querySelectorAll('.set-page:not([hidden]) .set-mini-btn')).find(x=>x.textContent.trim()==='初始化');if(b)b.click();return !!b;})()")
await new Promise((resolve) => setTimeout(resolve, 250))
const draft = JSON.parse(await evaluate("JSON.stringify({text:document.body.innerText,prompt:document.querySelector('.prompt-input')?.value,perm:Array.from(document.querySelectorAll('label.cfg')).find(x=>x.textContent.includes('权限'))?.querySelector('select')?.value,disabled:Array.from(document.querySelectorAll('label.cfg')).find(x=>x.textContent.includes('权限'))?.querySelector('select')?.disabled})"))
check('configuration prompt fills the original home composer', draft.text.includes('一个 App，驱动所有 Coding Agent') && !draft.text.includes('一次性初始化任务') && draft.prompt.includes('Grok') && draft.prompt.includes('不要修改 UniAgent 项目代码'))
check('configuration preserves editable permission', draft.perm === originalPermission && draft.disabled === false, JSON.stringify(draft))
check('active-session update guard', await evaluate('window.uniagent.e2eLifecycleUpdateGuard()') === 'agent_has_active_session')
console.log('agent lifecycle CDP: all checks passed; no update command executed')
ws.close()
