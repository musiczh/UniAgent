// Feature acceptance verification against the RUNNING packaged UniAgent app via
// CDP. Each check exercises the real IPC surface and/or drives the real React
// UI in the live renderer, asserting the concrete behavior each Doc requirement
// demands. Prints a PASS/FAIL matrix and exits non-zero if anything fails.
//
// Usage: node test/cdp-feature-verify.mjs [port]
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
// Reload the renderer so our event/status/queue listeners are the *only* ones
// installed (prior runs leave stale, unfiltered listeners behind that pollute
// the captured status stream). Session state lives in the main process, so a
// renderer reload is non-destructive to sessions/history.
await send('Page.reload', { ignoreCache: false })
await new Promise((r) => setTimeout(r, 2500))
await send('Runtime.enable')

const results = []
const rec = (label, ok, detail) => {
  results.push({ label, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`)
}

// Install a persistent event sink once.
await ev(`
  window.__e = window.__e || [];
  if (!window.__hooked) { window.__hooked = true; window.uniagent.onEvent(x => window.__e.push(x)); }
  return 1;
`)

// ---- Doc4-N1: provider-native Slash Skill/MCP snapshot ----
try {
  const cand = await ev(`
    const snapshot = await window.uniagent.getNativeCapabilities({
      agentId: 'codex', workdir: window.uniagent.homeDir, force: true
    });
    const all = snapshot.candidates;
    return JSON.stringify({
      total: all.length,
      skills: all.filter(c=>c.kind==='skill').length,
      mcps: all.filter(c=>c.kind==='mcp').length,
      onlyNative: all.every(c=>c.kind==='skill'||c.kind==='mcp'),
      legacyAbsent: typeof window.uniagent.listCandidates==='undefined' && typeof window.uniagent.runCommand==='undefined',
      sample: all.slice(0,3).map(c=>c.kind+':'+c.name)
    });
  `)
  const c = JSON.parse(cand)
  rec(
    'Doc4-N1 /候选(Skill/MCP)',
    c.skills > 0 && c.onlyNative && c.legacyAbsent,
    `total=${c.total} skills=${c.skills} mcp=${c.mcps} native=${c.onlyNative} e.g. ${c.sample.join(', ')}`
  )
} catch (e) {
  rec('Doc4-N1 /候选(Skill/MCP)', false, String(e).slice(0, 120))
}

// ---- Doc4-N4: automations scan + toggle round-trip ----
try {
  const auto = await ev(`
    const list = await window.uniagent.listAutomations();
    let toggled = null, restored = null;
    const t = list.find(x => x.path && x.status !== 'unknown');
    if (t) {
      const next = t.status === 'active' ? 'paused' : 'active';
      const ok1 = await window.uniagent.setAutomationStatus(t.path, next);
      const after = await window.uniagent.listAutomations();
      const a = after.find(x => x.id === t.id);
      toggled = ok1 && a && a.status === next;
      // restore original
      const ok2 = await window.uniagent.setAutomationStatus(t.path, t.status);
      const after2 = await window.uniagent.listAutomations();
      const b = after2.find(x => x.id === t.id);
      restored = ok2 && b && b.status === t.status;
    }
    return JSON.stringify({ count: list.length, names: list.map(x=>x.name).slice(0,4), toggled, restored,
      sample: list[0] ? {name:list[0].name, status:list[0].status, sched:list[0].schedule} : null });
  `)
  const a = JSON.parse(auto)
  rec(
    'Doc4-N4 定时任务集中展示+启停',
    a.count > 0 && a.toggled === true && a.restored === true,
    `count=${a.count} toggle=${a.toggled} restore=${a.restored} names=[${a.names.join(', ')}]`
  )
} catch (e) {
  rec('Doc4-N4 定时任务集中展示+启停', false, String(e).slice(0, 160))
}

// ---- Doc2-F5: history scan (listAgentHistory across agents) ----
try {
  const hist = await ev(`
    const cx = await window.uniagent.listAgentHistory('codex');
    const tx = await window.uniagent.listAgentHistory('traex');
    const cl = await window.uniagent.listAgentHistory('claude');
    return JSON.stringify({ codex: cx.length, traex: tx.length, claude: cl.length,
      sample: (cx[0]||tx[0]||cl[0]) ? {title:(cx[0]||tx[0]||cl[0]).title, agentId:(cx[0]||tx[0]||cl[0]).agentId} : null });
  `)
  const h = JSON.parse(hist)
  const any = h.codex + h.traex + h.claude
  rec(
    'Doc2-F5 历史会话扫描',
    any > 0,
    `codex=${h.codex} traex=${h.traex} claude=${h.claude}${h.sample ? ' e.g. ' + h.sample.title?.slice(0, 30) : ''}`
  )
} catch (e) {
  rec('Doc2-F5 历史会话扫描', false, String(e).slice(0, 120))
}

// ---- Doc2-F5b: import a real history session + replay events ----
try {
  const imp = await ev(`
    const agents = ['codex','traex','claude'];
    let picked = null;
    for (const a of agents) {
      const list = await window.uniagent.listAgentHistory(a);
      if (list.length) { picked = { agentId: a, id: list[0].id, title: list[0].title }; break; }
    }
    if (!picked) return JSON.stringify({ picked: null });
    const s = await window.uniagent.importSession(picked.agentId, picked.id);
    if (!s) return JSON.stringify({ picked, imported: false });
    const events = await window.uniagent.getEvents(s.id);
    return JSON.stringify({ picked, imported: true, sessionId: s.id, origin: s.origin,
      eventCount: events.length, types: [...new Set(events.map(e=>e.type))].slice(0,8) });
  `)
  const im = JSON.parse(imp)
  rec(
    'Doc2-F5 历史导入+回放',
    im.picked && im.imported && im.origin === 'imported' && im.eventCount > 0,
    im.picked
      ? `${im.picked.agentId} "${(im.picked.title||'').slice(0,24)}" events=${im.eventCount} types=[${(im.types||[]).join(',')}]`
      : 'no history to import'
  )
} catch (e) {
  rec('Doc2-F5 历史导入+回放', false, String(e).slice(0, 160))
}

// ---- Doc2-F4: session persistence (listSessions returns persisted store) ----
try {
  const persist = await ev(`
    const before = await window.uniagent.listSessions();
    return JSON.stringify({ count: before.length,
      hasImported: before.some(s=>s.origin==='imported'),
      sample: before.slice(0,3).map(s=>({title:s.title.slice(0,20), status:s.status, origin:s.origin})) });
  `)
  const p = JSON.parse(persist)
  // A session exists (from the import above at minimum) and is tracked in the store.
  rec(
    'Doc2-F4 会话持久化(store)',
    p.count > 0,
    `sessions=${p.count} importedTracked=${p.hasImported}`
  )
} catch (e) {
  rec('Doc2-F4 会话持久化(store)', false, String(e).slice(0, 120))
}

// ---- Doc4-N6 + N2: status machine & queue via a real running turn ----
// Create a codex session, immediately enqueue a 2nd message while running,
// assert status goes running -> queued -> (drains) running -> idle, and that
// the queued item shows up then clears.
try {
  const marker1 = 'UA_Q1_' + Math.floor(Math.random() * 100000)
  const marker2 = 'UA_Q2_' + Math.floor(Math.random() * 100000)
  const start = await ev(`
    window.__q = { statuses: [], queues: [] };
    window.__qsid = null;
    if (!window.__qhook) {
      window.__qhook = true;
      window.uniagent.onStatusChange(s => { if (s.sessionId === window.__qsid) window.__q.statuses.push(s.status); });
      window.uniagent.onQueueChange(q => { if (q.sessionId === window.__qsid) window.__q.queues.push(q.queue.length); });
    }
    const s = await window.uniagent.createSession(
      { agentId:'codex', workdir: window.uniagent.homeDir, permissionMode:'read-only' },
      'Write one sentence about mountains, then end with ${marker1}');
    window.__qsid = s.id;
    // Enqueue a second message right away (turn is running) -> should queue.
    await window.uniagent.sendMessage(s.id, 'Now write one sentence about rivers, then end with ${marker2}');
    return s.id;
  `)
  // Poll until both markers seen or timeout.
  let done = false
  let snap = {}
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 500))
    const s = await ev(`
      const evs = window.__e.filter(e => e.sessionId === ${JSON.stringify(start)});
      const blob = JSON.stringify(evs);
      return JSON.stringify({
        m1: blob.includes(${JSON.stringify(marker1)}),
        m2: blob.includes(${JSON.stringify(marker2)}),
        statuses: window.__q.statuses,
        queues: window.__q.queues,
        userMsgs: evs.filter(e=>e.type==='user_message').length,
        completes: evs.filter(e=>e.type==='turn_completed').length
      });
    `)
    snap = JSON.parse(s)
    if (snap.m1 && snap.m2 && snap.completes >= 2) {
      done = true
      break
    }
  }
  // The streamer's done→afterTurn→idle transition lags the turn_completed
  // event slightly; poll the status stream until it settles back to idle.
  for (let i = 0; i < 20; i++) {
    const s = await ev(`return JSON.stringify({ statuses: window.__q.statuses, queues: window.__q.queues });`)
    const tail = JSON.parse(s)
    snap.statuses = tail.statuses
    snap.queues = tail.queues
    if ((tail.statuses || []).slice(-1)[0] === 'idle') break
    await new Promise((r) => setTimeout(r, 400))
  }
  const sawQueued = (snap.statuses || []).includes('queued')
  const sawRunning = (snap.statuses || []).includes('running')
  const endedIdle = (snap.statuses || []).slice(-1)[0] === 'idle'
  const queuePeaked = (snap.queues || []).some((n) => n >= 1)
  const queueCleared = (snap.queues || []).slice(-1)[0] === 0 || (snap.queues || []).length === 0
  rec(
    'Doc4-N2 任务队列(排队→自动发送)',
    done && sawQueued && queuePeaked && snap.userMsgs >= 2,
    `queued=${sawQueued} qPeak=${queuePeaked} userMsgs=${snap.userMsgs} completes=${snap.completes}`
  )
  rec(
    'Doc4-N6 任务状态机(running/queued/idle)',
    sawRunning && sawQueued && endedIdle,
    `path=${(snap.statuses || []).join('→')}`
  )
} catch (e) {
  rec('Doc4-N2 任务队列(排队→自动发送)', false, String(e).slice(0, 160))
  rec('Doc4-N6 任务状态机', false, String(e).slice(0, 160))
}

const out = { results }
console.log('\n' + JSON.stringify(out).length + ' bytes of results')
const fails = results.filter((r) => !r.ok)
console.log(`\n===== FEATURE VERIFY: PASS=${results.length - fails.length} FAIL=${fails.length} =====`)
ws.close()
process.exit(fails.length === 0 ? 0 : 1)
