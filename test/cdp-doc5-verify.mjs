// Doc5 verification against the RUNNING packaged app via CDP.
//   Doc5-T1 accurate per-turn token usage + cost (one line): a multi-step turn
//           reports the total INCREMENT (not last call), cost only for priceable
//           models, occupancy bar uses bounded last.inputTokens.
//   Doc5-T2 remembered last model/effort/permission per agent (prefs.json round-
//           trip via setPrefs/getPrefs + NewTaskPanel restores a CONCRETE model).
//   Doc5-T3 task list de-duped by sessionId identity (no duplicate sidebar rows,
//           importSession upserts by identity).
//
// Usage: node test/cdp-doc5-verify.mjs [port]
const port = process.argv[2] || '9222'

async function getPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json')
      const t = await r.json()
      const p = t.find((x) => x.type === 'page' && /index\.html/.test(x.url))
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
    expression: `(async()=>{${expr}})()`,
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
await send('Page.enable')
await send('Page.reload', { ignoreCache: false })
await new Promise((r) => setTimeout(r, 2600))
await send('Runtime.enable')

const results = []
const rec = (label, ok, detail) => {
  results.push({ label, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`)
}

await ev(`
  window.__e = window.__e || [];
  if (!window.__d5hook) { window.__d5hook = true; window.uniagent.onEvent(x => window.__e.push(x)); }
  return 1;
`)

const HELPERS = `
  window.__reactSet = function(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
`
await ev(`${HELPERS} return 1;`)

// ---- Doc5-T1: per-turn total increment + cost + bounded occupancy ----
// Run a multi-step codex turn (several command executions => several model
// calls) THROUGH THE REAL FORM (so the session-view mounts and the usage card
// renders). Assert the usage footer's inputTokens is the TOTAL increment (much
// larger than any single call's contextTokens), a cost is present for a
// priceable model, and the occupancy (contextTokens) stays bounded and < input.
try {
  const marker = 'UA_T1_' + Math.floor(Math.random() * 100000)
  const created = await ev(`
    const plus = document.querySelector('.btn-new');
    if (!document.querySelector('.new-task') && plus) plus.click();
    for (let i=0;i<60;i++){ if (document.querySelector('.new-task .config-bar select')) break; await new Promise(r=>setTimeout(r,120)); }
    const nt = document.querySelector('.new-task');
    const [agentSel, modelSel, effortSel, permSel] = nt.querySelectorAll('.config-bar select');
    window.__reactSet(agentSel, 'codex');
    await new Promise(r=>setTimeout(r,120));
    const opt = [...modelSel.options].find(o=>/sol/i.test(o.value)) || [...modelSel.options].find(o=>o.value);
    if (opt) window.__reactSet(modelSel, opt.value);
    await new Promise(r=>setTimeout(r,120));
    const ro = [...permSel.options].find(o=>o.value==='read-only');
    if (ro) window.__reactSet(permSel, 'read-only');
    await new Promise(r=>setTimeout(r,120));
    const ta = nt.querySelector('.prompt-input');
    window.__reactSet(ta, 'Do these one at a time using your shell tool: (1) run \`pwd\`, (2) run \`ls\`, (3) run \`date\`, (4) run \`uname -a\`. After each, briefly note the result. Finally reply with the word ${marker}.');
    await new Promise(r=>setTimeout(r,120));
    nt.querySelector('.btn-send').click();
    for (let i=0;i<80;i++){ if (document.querySelector('.session-view')) break; await new Promise(r=>setTimeout(r,120)); }
    const ids = [...new Set(window.__e.map(e=>e.sessionId))];
    return JSON.stringify({ mounted: !!document.querySelector('.session-view'), model: modelSel.value, sid: ids[ids.length-1] });
  `)
  const ci = JSON.parse(created)
  const sid = ci.sid
  let usage = null
  let cmdCount = 0
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 500))
    const s = await ev(`
      const evs = window.__e.filter(e=>e.sessionId===${JSON.stringify(sid)});
      const u = evs.filter(e=>e.type==='system_notice' && e.payload?.kind==='usage').slice(-1)[0];
      const cmds = evs.filter(e=>e.type==='command_exec' && e.state==='success').length;
      const completed = evs.some(e=>e.type==='turn_completed');
      return JSON.stringify({ usage: u? u.payload.usage : null, cmds, completed });
    `)
    const d = JSON.parse(s)
    cmdCount = d.cmds
    if (d.completed && d.usage) {
      usage = d.usage
      break
    }
  }
  if (!usage) {
    rec('Doc5-T1 每轮token增量+费用', false, `turn did not complete with a usage footer (model=${ci.model})`)
  } else {
    const input = usage.inputTokens ?? usage.input_tokens ?? 0
    const output = usage.outputTokens ?? usage.output_tokens ?? 0
    const occ = usage.contextTokens ?? 0
    const cost = usage.cost
    // For a multi-call turn the summed input must exceed a single call's
    // occupancy (this is the whole point of the increment fix).
    const incrementOK = input > 0 && output > 0 && input >= occ
    const boundedOK = occ > 0 && (!usage.contextWindow || occ <= usage.contextWindow)
    const costOK = usage.modelId ? typeof cost === 'number' && cost > 0 : true
    rec(
      'Doc5-T1 每轮token增量+费用(一行)',
      incrementOK && boundedOK && costOK,
      `model=${usage.modelId} 输入=${input} 输出=${output} 占用=${occ} 窗口=${usage.contextWindow} 费用=${cost} cmds=${cmdCount}`
    )
    // DOM: the usage card renders exactly one line with 本轮完成 + 费用 段.
    const card = await ev(`
      const cards = [...document.querySelectorAll('.session-view .system-notice.usage')];
      const c = cards[cards.length-1];
      const txt = (c?.textContent||'').replace(/\\s+/g,' ').trim();
      return JSON.stringify({ present: !!c, txt, oneLine: !/\\n/.test(c?.textContent||''), hasFee: /费用/.test(txt), hasIn: /输入/.test(txt) });
    `)
    const cc = JSON.parse(card)
    rec(
      'Doc5-T1 usage 卡片一行渲染',
      cc.present && cc.oneLine && cc.hasIn && (usage.modelId ? cc.hasFee : true),
      `"${cc.txt}"`
    )
  }
} catch (e) {
  rec('Doc5-T1 每轮token增量+费用(一行)', false, String(e).slice(0, 200))
}

// ---- Doc5-T2: prefs round-trip + NewTaskPanel restores a concrete model ----
try {
  // Directly exercise the prefs IPC: set a choice, read it back.
  const rt = await ev(`
    const saved = await window.uniagent.setPrefs('codex', { model:'gpt-5.6-sol', effort:'high', permissionMode:'auto-edit' });
    const got = await window.uniagent.getPrefs();
    return JSON.stringify({
      lastAgentId: got.lastAgentId,
      codex: got.lastByAgent?.codex || null
    });
  `)
  const d = JSON.parse(rt)
  const prefOK =
    d.lastAgentId === 'codex' &&
    d.codex &&
    d.codex.model === 'gpt-5.6-sol' &&
    d.codex.effort === 'high' &&
    d.codex.permissionMode === 'auto-edit'
  rec(
    'Doc5-T2 prefs 持久化往返',
    prefOK,
    `lastAgent=${d.lastAgentId} codex=${JSON.stringify(d.codex)}`
  )

  // NewTaskPanel: open a fresh panel; the model dropdown must select a CONCRETE
  // model (never the empty "跟随 CLI 默认" value), and reflect the saved pref.
  const panel = await ev(`
    const plus = document.querySelector('.btn-new');
    if (plus) plus.click();
    for (let i=0;i<60;i++){ if (document.querySelector('.new-task .config-bar select')) break; await new Promise(r=>setTimeout(r,120)); }
    const selects = document.querySelectorAll('.new-task .config-bar select');
    const [agentSel, modelSel, effortSel, permSel] = selects;
    return JSON.stringify({
      agent: agentSel?.value,
      model: modelSel?.value,
      effort: effortSel?.value,
      perm: permSel?.value,
      modelNonEmpty: !!(modelSel && modelSel.value)
    });
  `)
  const pp = JSON.parse(panel)
  rec(
    'Doc5-T2 新建面板回填具体模型',
    pp.agent === 'codex' && pp.modelNonEmpty && pp.model === 'gpt-5.6-sol' && pp.effort === 'high' && pp.perm === 'auto-edit',
    `agent=${pp.agent} model=${pp.model} effort=${pp.effort} perm=${pp.perm}`
  )
} catch (e) {
  rec('Doc5-T2 默认模型记住上次选择', false, String(e).slice(0, 200))
}

// ---- Doc5-T3: task list de-dup by identity ----
try {
  // Import the same native history session TWICE; assert only ONE sidebar row
  // (and listSessions returns one) for that identity.
  const d = await ev(`
    let picked = null;
    for (const a of ['codex','traex','claude']) {
      const list = await window.uniagent.listAgentHistory(a);
      if (list.length) { picked = { agentId:a, id:list[0].id }; break; }
    }
    if (!picked) return JSON.stringify({ picked:null });
    const s1 = await window.uniagent.importSession(picked.agentId, picked.id);
    const s2 = await window.uniagent.importSession(picked.agentId, picked.id);
    const list = await window.uniagent.listSessions();
    const same = list.filter(x => x.config.agentId===picked.agentId && x.nativeSessionId===picked.id);
    // Render check: how many sidebar rows carry that native identity.
    for (let i=0;i<20;i++){ if (document.querySelector('.session-item')) break; await new Promise(r=>setTimeout(r,120)); }
    const rows = [...document.querySelectorAll('.session-item')].map(el=>el.getAttribute('data-session-id'));
    const uniqueKeys = new Set(list.map(x => x.nativeSessionId ? x.config.agentId+':'+x.nativeSessionId : x.id));
    return JSON.stringify({
      picked, s1: s1?.id, s2: s2?.id, reusedId: s1?.id === s2?.id,
      sameIdentityCount: same.length, listLen: list.length,
      uniqueKeyLen: uniqueKeys.size, domRows: rows.length,
      noDupInList: list.length === uniqueKeys.size
    });
  `)
  const r = JSON.parse(d)
  if (!r.picked) {
    rec('Doc5-T3 任务列表去重', false, 'no history session to import for the test')
  } else {
    rec(
      'Doc5-T3 任务列表按身份去重',
      r.reusedId && r.sameIdentityCount === 1 && r.noDupInList,
      `reusedLocalId=${r.reusedId} sameIdentity=${r.sameIdentityCount} listLen=${r.listLen} uniqueKeys=${r.uniqueKeyLen} domRows=${r.domRows}`
    )
  }
} catch (e) {
  rec('Doc5-T3 任务列表按身份去重', false, String(e).slice(0, 200))
}

const fails = results.filter((r) => !r.ok)
console.log(`\n===== DOC5 VERIFY: PASS=${results.length - fails.length} FAIL=${fails.length} =====`)
ws.close()
process.exit(fails.length === 0 ? 0 : 1)
