import { Orchestrator } from '../src/main/orchestrator.ts'
import { detectAgents } from '../src/main/agents.ts'
import type { PermissionMode, ReasoningEffort, UAEvent } from '../src/shared/types.ts'

// Edge-case E2E: proves the effective config negotiated per turn is correct.
// codex/traex now stream via `app-server`, so sandbox / approval / model /
// effort are sent as JSON-RPC params rather than argv — the launch notice
// surfaces the effective values, and we assert on those. Cases:
//   (1) omitting effort produces NO effort in the effective config,
//   (2) full-access maps to sandbox=danger-full-access (approval=never), and
//   (3) a non-default effort on a supporting model flows through verbatim.
// Cases run sequentially; listeners are attached before createSession so the
// synchronous `launch` notice (which carries the effective config) is captured.

function runCase(
  orch: Orchestrator,
  cfg: { agentId: string; model?: string; effort?: ReasoningEffort; workdir: string; permissionMode: PermissionMode },
  marker: string
): Promise<{ label: string; turnOk: boolean; cmd: string; errors: string[]; reply: string }> {
  return new Promise((resolve) => {
    const types = new Set<string>()
    const errors: string[] = []
    // Streaming re-emits a growing snapshot per id; keep last-wins per id so the
    // reply isn't the concatenation of every intermediate snapshot.
    const replyById = new Map<string, string>()
    let cmd = ''
    let markerSeen = false
    let sessionId = ''
    const onEvent = (ev: UAEvent): void => {
      types.add(ev.type)
      if (JSON.stringify(ev.payload).includes(marker)) markerSeen = true
      if (ev.type === 'agent_message') replyById.set(ev.payload.id || '_', ev.payload.text || '')
      if (ev.type === 'system_notice' && ev.payload?.kind === 'launch') cmd = ev.payload.text
      if (ev.type === 'error' && ev.state === 'failed') errors.push(ev.payload.message)
    }
    const finish = (): void => {
      orch.off('event', onEvent)
      orch.off('statusChange', onStatus)
      resolve({
        label: `${cfg.agentId} model=${cfg.model || '-'} effort=${cfg.effort || '-'} perm=${cfg.permissionMode}`,
        turnOk: types.has('turn_completed') && markerSeen && errors.length === 0,
        cmd,
        errors,
        reply: [...replyById.values()].join(' ').trim().slice(0, 120)
      })
    }
    const onStatus = (s: { sessionId: string; status: string }): void => {
      if (s.sessionId === sessionId && s.status === 'idle') setTimeout(finish, 150)
    }
    orch.on('event', onEvent)
    orch.on('statusChange', onStatus)
    const session = orch.createSession(cfg, `Reply with exactly the token ${marker} and nothing else.`)
    sessionId = session.id
  })
}

async function main(): Promise<void> {
  const agents = await detectAgents()
  const orch = new Orchestrator((id) => agents.find((a) => a.id === id))
  const workdir = process.cwd()
  const codex = agents.find((a) => a.id === 'codex')!

  const hiModel = codex.models.find((m) => m.efforts.includes('high'))!
  const anyModel = codex.models[0]

  type EdgeCase = {
    cfg: Parameters<typeof runCase>[1]
    // assertion on the built argv; return null when OK, else the failure reason.
    assert: (cmd: string) => string | null
    requireTurn: boolean
  }
  const cases: EdgeCase[] = [
    // (1) effort omitted -> no effort in the effective config.
    {
      cfg: { agentId: 'codex', model: anyModel.id, effort: undefined, workdir, permissionMode: 'read-only' },
      assert: (cmd) => (/\beffort=/.test(cmd) ? 'effort present despite undefined effort' : null),
      requireTurn: true
    },
    // (2) full-access -> sandbox=danger-full-access (approval bypassed via never).
    {
      cfg: { agentId: 'codex', model: anyModel.id, effort: anyModel.defaultEffort, workdir, permissionMode: 'full-access' },
      assert: (cmd) =>
        cmd.includes('sandbox=danger-full-access') ? null : 'full-access sandbox not applied',
      requireTurn: true
    },
    // (3) non-default effort (high) applied verbatim.
    {
      cfg: { agentId: 'codex', model: hiModel.id, effort: 'high', workdir, permissionMode: 'read-only' },
      assert: (cmd) => (cmd.includes('effort=high') ? null : 'high effort not applied'),
      requireTurn: true
    }
  ]

  let fail = 0
  for (const c of cases) {
    const marker = `UA_EDGE_${Math.floor(Math.random() * 100000)}`
    const r = await runCase(orch, c.cfg, marker)
    const assertErr = c.assert(r.cmd)
    const ok = (!c.requireTurn || r.turnOk) && !assertErr
    if (!ok) fail++
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${r.label}`)
    console.log(`   cmd: ${r.cmd.slice(0, 260)}`)
    console.log(`   reply: ${JSON.stringify(r.reply)}`)
    if (assertErr) console.log(`   ASSERT FAIL: ${assertErr}`)
    if (r.errors.length) console.log(`   ERRORS: ${JSON.stringify(r.errors)}`)
  }
  console.log(`\nEDGE PASS=${cases.length - fail} FAIL=${fail}`)
  process.exit(fail === 0 ? 0 : 1)
}

main()
