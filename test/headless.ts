import { Orchestrator } from '../src/main/orchestrator.ts'
import { detectAgents } from '../src/main/agents.ts'
import type { AgentDef, PermissionMode, ReasoningEffort, UAEvent } from '../src/shared/types.ts'

// Headless E2E matrix: drives each installed agent through the REAL orchestrator
// + adapter path (the same buildCommand / effort flags / permission mapping the
// GUI uses) and asserts we get a streamed reply, the exact marker token, and
// ZERO hard errors. This exercises the cascading config end-to-end without the
// Electron window (which is flaky under headless GPU).

interface CaseResult {
  label: string
  ok: boolean
  done: boolean
  markerSeen: boolean
  errors: string[]
  cmd: string
  reply: string
  streamed: boolean
  deltaCount: number
  ms: number
}

function runCase(
  orch: Orchestrator,
  cfg: {
    agentId: string
    model?: string
    effort?: ReasoningEffort
    workdir: string
    permissionMode: PermissionMode
  },
  marker: string,
  expectStreaming: boolean
): Promise<CaseResult> {
  return new Promise((resolve) => {
    const types = new Set<string>()
    const errors: string[] = []
    // Accumulate agent replies by payload.id (streaming re-emits a growing
    // snapshot under one id; one-shot emits a single final event).
    const replyById = new Map<string, string>()
    // Count *running* snapshots per id + track that text is strictly growing —
    // that's the signal that we saw real token-level streaming, not one blob.
    const runningLen = new Map<string, number[]>()
    let cmd = ''
    let markerSeen = false
    let sessionId = ''
    const start = Date.now()

    // Listeners are attached before createSession and removed on finish, and
    // cases run strictly sequentially — so we don't filter by sessionId here.
    // That's important because the `launch` system_notice is emitted
    // synchronously inside createSession, before sessionId is assigned.
    const onEvent = (ev: UAEvent): void => {
      types.add(ev.type)
      const blob = JSON.stringify(ev.payload)
      if (blob.includes(marker)) markerSeen = true
      if (ev.type === 'agent_message') {
        const id = ev.payload.id || '_'
        const text = ev.payload.text || ''
        replyById.set(id, text)
        if (ev.state === 'running') {
          const arr = runningLen.get(id) || []
          arr.push(text.length)
          runningLen.set(id, arr)
        }
      }
      if (ev.type === 'system_notice' && ev.payload?.kind === 'launch') cmd = ev.payload.text
      if (ev.type === 'error' && ev.state === 'failed') errors.push(ev.payload.message)
    }
    const finish = (): void => {
      orch.off('event', onEvent)
      orch.off('statusChange', onStatus)
      const reply = [...replyById.values()].join('\n').trim()
      // Streaming proof: at least one id received ≥2 running snapshots whose
      // accumulated length strictly increased before the final event.
      let deltaCount = 0
      let streamed = false
      for (const lens of runningLen.values()) {
        deltaCount += lens.length
        if (lens.length >= 2 && lens[lens.length - 1] > lens[0]) streamed = true
      }
      const streamOk = !expectStreaming || streamed
      resolve({
        label: `${cfg.agentId} model=${cfg.model || '-'} effort=${cfg.effort || '-'} perm=${cfg.permissionMode}`,
        ok: types.has('turn_completed') && markerSeen && errors.length === 0 && streamOk,
        done: types.has('turn_completed'),
        markerSeen,
        errors,
        cmd,
        reply: reply.slice(0, 160),
        streamed,
        deltaCount,
        ms: Date.now() - start
      })
    }
    const onStatus = (s: { sessionId: string; status: string }): void => {
      if (s.sessionId === sessionId && s.status === 'idle') setTimeout(finish, 150)
    }

    orch.on('event', onEvent)
    orch.on('statusChange', onStatus)
    // A multi-sentence reply (vs. a bare token) guarantees the generation spans
    // several coalescing windows, so streaming agents emit multiple growing
    // "running" snapshots — the signal we assert on. The marker still ends it so
    // completion + fidelity are checked exactly as before.
    const session = orch.createSession(
      cfg,
      `Write 4 short sentences about why the sky is blue, as flowing prose. ` +
        `End your reply with the token ${marker} and nothing after it.`
    )
    sessionId = session.id
  })
}

async function main(): Promise<void> {
  const agents = await detectAgents()
  console.log('Detected agents:')
  for (const a of agents) {
    const ms = a.models.length
    const effModels = a.models.filter((m) => m.efforts.length > 0).length
    console.log(
      `  ${a.icon} ${a.name} (${a.id}): ${a.installed ? 'installed ' + a.version : 'NOT installed'} | models=${ms} (with-effort=${effModels}) | perms=[${a.capabilities.permissionModes.map((m) => m.id).join(',')}] | reasoningEffort=${a.capabilities.reasoningEffort} | streaming=${a.capabilities.streaming === true}`
    )
  }

  const orch = new Orchestrator((id) => agents.find((a) => a.id === id))
  const workdir = process.cwd()
  const installed = agents.filter((a) => a.installed)

  // Build the matrix: for each installed agent, pick a model that supports
  // efforts (to prove the cascade), run read-only + auto-edit.
  const cases: {
    agentId: string
    model?: string
    effort?: ReasoningEffort
    permissionMode: PermissionMode
    workdir: string
  }[] = []
  for (const a of installed) {
    const withEffort = a.models.find((m) => m.efforts.length > 0) || a.models[0]
    const effort = withEffort && withEffort.efforts.length
      ? withEffort.defaultEffort || withEffort.efforts[0]
      : undefined
    const perms = a.capabilities.permissionModes
    if (perms.some((m) => m.id === 'read-only'))
      cases.push({ agentId: a.id, model: withEffort?.id, effort, permissionMode: 'read-only', workdir })
    if (perms.some((m) => m.id === 'auto-edit'))
      cases.push({ agentId: a.id, model: withEffort?.id, effort, permissionMode: 'auto-edit', workdir })
  }

  console.log(`\nRunning ${cases.length} cases across ${installed.length} agents...\n`)
  const results: CaseResult[] = []
  for (const c of cases) {
    const marker = `UA_${c.agentId.toUpperCase()}_${c.permissionMode.replace('-', '').toUpperCase()}_${Math.floor(Math.random() * 100000)}`
    const agent = installed.find((a) => a.id === c.agentId)!
    const expectStreaming = agent.capabilities.streaming === true
    const r = await runCase(orch, c, marker, expectStreaming)
    results.push(r)
    console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.label}  (${(r.ms / 1000).toFixed(1)}s)`)
    console.log(`   cmd: ${r.cmd.slice(0, 240)}`)
    console.log(`   reply: ${JSON.stringify(r.reply)}`)
    console.log(
      `   stream: expect=${expectStreaming} got=${r.streamed} runningSnapshots=${r.deltaCount}`
    )
    if (r.errors.length) console.log(`   ERRORS: ${JSON.stringify(r.errors)}`)
  }

  console.log('\n===== SUMMARY =====')
  let fail = 0
  for (const r of results) {
    console.log(
      `  ${r.ok ? '✅' : '❌'} ${r.label}  [${(r.ms / 1000).toFixed(1)}s]  ${r.streamed ? '⚡streamed' : ''}`
    )
    if (!r.ok) fail++
  }
  console.log(`\nPASS=${results.length - fail} FAIL=${fail}`)
  process.exit(fail === 0 && installed.length >= 3 ? 0 : 1)
}

main()
