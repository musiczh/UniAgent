import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, Session } from '../src/shared/types.ts'

const root = await mkdtemp(join(tmpdir(), 'uniagent-handoff-lifecycle-'))
process.env.UNIAGENT_USER_DATA = join(root, 'user-data')

const [{ Orchestrator }, { SessionStore }, handoff] = await Promise.all([
  import('../src/main/orchestrator.ts'),
  import('../src/main/sessionStore.ts'),
  import('../src/main/handoff.ts')
])

function agent(): AgentDef {
  return {
    id: 'codex', name: 'Codex', bin: '/usr/bin/true', adapter: 'codex', icon: '',
    builtin: true, installed: true,
    capabilities: { modelSelect: false, reasoningEffort: false, permissionModes: [], streaming: false },
    models: []
  }
}

function rpc(child: ChildProcessWithoutNullStreams, id: number, params: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error(`MCP response ${id} timed out`)), 3000)
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString()
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line) continue
        const message = JSON.parse(line)
        if (message.id !== id) continue
        clearTimeout(timer)
        child.stdout.off('data', onData)
        resolve(message)
      }
    }
    child.stdout.on('data', onData)
    child.once('error', reject)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params }) + '\n')
  })
}

async function takeRequest(directory: string): Promise<any> {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const name = (await readdir(directory)).find((entry) => entry.endsWith('.json'))
    if (name) {
      const path = join(directory, name)
      const request = JSON.parse(await readFile(path, 'utf8'))
      await unlink(path)
      return request
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('handoff request was not written')
}

async function writeState(directory: string, id: string, state: object): Promise<void> {
  const path = join(directory, id + '.json')
  await writeFile(path + '.tmp', JSON.stringify(state), 'utf8')
  await rename(path + '.tmp', path)
}

try {
  const store = new SessionStore(join(root, 'sessions.json'))
  const sessions: Session[] = [
    {
      id: 'caller', title: 'caller', status: 'running', createdAt: 1,
      config: { agentId: 'codex', workdir: root },
      waitingForHandoff: { handoffId: 'handoff', awaitedSessionId: 'child', agentId: 'codex', agentName: 'Codex', label: 'child' }
    },
    { id: 'child', title: 'child', status: 'running', createdAt: 2, config: { agentId: 'codex', workdir: root } }
  ]
  store.save(sessions)
  const orchestrator = new Orchestrator((id) => id === 'codex' ? agent() : undefined, store)
  orchestrator.loadPersisted()
  orchestrator.getSessionById('caller')!.status = 'running'
  orchestrator.getSessionById('child')!.status = 'running'
  orchestrator.getSessionById('caller')!.waitingForHandoff = sessions[0].waitingForHandoff
  orchestrator.interrupt('caller')
  assert.equal(orchestrator.getSessionById('child')?.status, 'cancelling')

  handoff.ensureHandoffServer()
  const serverSource = await readFile(handoff.handoffServerPath(), 'utf8')
  assert.match(serverSource, /startedAt \+ 3 \* 60 \* 60 \* 1000/)
  assert.match(serverSource, /deadline = Math\.min\(now \+ 10 \* 60 \* 1000, hardDeadline\)/)
  assert.match(serverSource, /method === 'notifications\/cancelled'/)
  const codexArgs = handoff.handoffMcpArgs('codex')
  assert.ok(codexArgs.includes('mcp_servers.uniagent.tool_timeout_sec=10860'))
  const claudeArgs = handoff.handoffMcpArgs('claude')
  const claudeConfig = JSON.parse(claudeArgs[claudeArgs.indexOf('--mcp-config') + 1])
  assert.equal(claudeConfig.mcpServers.uniagent.timeout, 10_860_000)

  const testServerPath = join(root, 'server.cjs')
  await writeFile(
    testServerPath,
    serverSource
      .replace('startedAt + 3 * 60 * 60 * 1000', 'startedAt + 2000')
      .replace('now + 10 * 60 * 1000', 'now + 200')
      .replace('setTimeout(tick, 400)', 'setTimeout(tick, 50)'),
    'utf8'
  )
  const child = spawn(process.execPath, [testServerPath], {
    env: {
      ...process.env,
      UNIAGENT_HANDOFF_INBOX: handoff.handoffInboxDir(),
      UNIAGENT_HANDOFF_RESULTS: handoff.handoffResultsDir()
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  try {
    await writeState(handoff.handoffResultsDir(), 'running-task', {
      status: 'running', text: '', sessionId: 'running-session'
    })
    const rejectedFollowup = await rpc(child, 11, {
      name: 'uniagent_task',
      arguments: { action: 'followup', prompt: 'must not queue', taskId: 'running-task' }
    })
    assert.match(rejectedFollowup.error.message, /尚未结束/)
    assert.equal((await readdir(handoff.handoffInboxDir())).filter((name) => name.endsWith('.json')).length, 0)

    await writeState(handoff.handoffResultsDir(), 'completed-task', {
      status: 'idle', text: '已完成', sessionId: 'shared-session',
      targetAgent: {
        id: 'codex', name: 'Codex', adapter: 'codex',
        capabilities: { steer: true, followup: true }
      }
    })
    const acceptedFollowup = rpc(child, 12, {
      name: 'uniagent_task',
      arguments: { action: 'followup', prompt: 'first follow-up', taskId: 'completed-task' }
    })
    const followupRequest = await takeRequest(handoff.handoffInboxDir())
    assert.equal(followupRequest.followupTaskId, 'completed-task')
    await writeState(handoff.handoffResultsDir(), followupRequest.id, {
      status: 'running', text: '', sessionId: 'shared-session', delivery: 'delivered',
      targetAgent: {
        id: 'codex', name: 'Codex', adapter: 'codex',
        capabilities: { steer: true, followup: true }
      }
    })
    const acceptedFollowupResponse = await acceptedFollowup
    assert.match(acceptedFollowupResponse.result.content[0].text, /uniagent:event=delivered/)

    const blockedByQueuedFollowup = await rpc(child, 13, {
      name: 'uniagent_task',
      arguments: { action: 'followup', prompt: 'must wait for first follow-up', taskId: 'completed-task' }
    })
    assert.match(blockedByQueuedFollowup.error.message, /同一会话的任务.*尚未结束/)
    assert.equal((await readdir(handoff.handoffInboxDir())).filter((name) => name.endsWith('.json')).length, 0)

    const immediate = rpc(child, 1, { name: 'uniagent_task', arguments: { action: 'create', prompt: 'default timeout' } })
    const defaultRequest = await takeRequest(handoff.handoffInboxDir())
    assert.equal(defaultRequest.timeout, 1200)
    handoff.handoffTaskStore.begin(defaultRequest.id)
    handoff.writeHandoffResult(defaultRequest.id, {
      status: 'running', text: '', sessionId: 'new-session', delivery: 'started',
      targetAgent: {
        id: 'kimi', name: 'Kimi Code', adapter: 'kimi', protocol: 'acp',
        capabilities: {
          steer: false, followup: true, sessionFork: false, sessionForkAtTurn: false,
          crossAgentFork: false, sideChat: false, nativeGoal: false, nativeReview: false,
          structuredSubagents: false, formElicitation: true, freeTextElicitation: false,
          structuredUsage: false, capabilityInventory: false,
          additionalDirectoriesNew: true, additionalDirectoriesResume: false
        }
      }
    })
    const immediateResponse = await immediate
    const paths = JSON.parse(immediateResponse.result.content[1].text)
    assert.equal(paths.statusFile, join(handoff.handoffResultsDir(), defaultRequest.id + '.json'))
    assert.equal(paths.eventsFile, join(handoff.handoffResultsDir(), defaultRequest.id + '.events.jsonl'))
    assert.equal(paths.logAvailable, true)
    assert.equal(paths.targetAgent.name, 'Kimi Code')
    assert.equal(paths.targetAgent.capabilities.steer, false)
    handoff.handoffTaskStore.recordEvent(defaultRequest.id, {
      sessionId: 'new-session', seq: 1, ts: Date.now(), type: 'agent_message', state: 'success',
      payload: { id: 'reply', text: '完整回复' }
    })
    handoff.writeHandoffResult(defaultRequest.id, {
      status: 'idle', text: '完整回复', sessionId: 'new-session',
      targetAgent: {
        id: 'kimi', name: 'Kimi Code', adapter: 'kimi', protocol: 'acp',
        capabilities: {
          steer: false, followup: true, sessionFork: false, sessionForkAtTurn: false,
          crossAgentFork: false, sideChat: false, nativeGoal: false, nativeReview: false,
          structuredSubagents: false, formElicitation: true, freeTextElicitation: false,
          structuredUsage: false, capabilityInventory: false,
          additionalDirectoriesNew: true, additionalDirectoriesResume: false
        }
      }
    })
    const query = await rpc(child, 16, { name: 'uniagent_task', arguments: { action: 'get', taskId: defaultRequest.id } })
    const info = JSON.parse(query.result.content[0].text)
    assert.equal(info.eventsFile, paths.eventsFile)
    assert.equal(info.latestReply, '完整回复')
    assert.equal(info.done, true)
    assert.equal(info.logComplete, true)
    assert.equal(info.logBytes, (await readFile(info.eventsFile)).length)
    assert.equal(info.stale, false)
    assert.equal(info.targetAgent.name, 'Kimi Code')
    assert.equal(info.targetAgent.capabilities.steer, false)
    const invalidPath = await rpc(child, 17, { name: 'uniagent_task', arguments: { action: 'get', taskId: '../outside' } })
    assert.equal(invalidPath.error.code, -32602)

    await writeState(handoff.handoffResultsDir(), 'force-target', {
      status: 'running', text: '', sessionId: 'force-session',
      targetAgent: {
        id: 'codex', name: 'Codex', adapter: 'codex',
        capabilities: { steer: true, followup: true }
      }
    })

    await writeState(handoff.handoffResultsDir(), 'kimi-force-target', {
      status: 'running', text: '', sessionId: 'kimi-force-session',
      targetAgent: {
        id: 'kimi', name: 'Kimi Code', adapter: 'kimi', protocol: 'acp',
        capabilities: { steer: false, followup: true }
      }
    })
    const rejectedKimiForce = await rpc(child, 18, {
      name: 'uniagent_task',
      arguments: { action: 'followup', prompt: 'must never queue', taskId: 'kimi-force-target', force: true }
    })
    assert.match(rejectedKimiForce.error.message, /unsupported_target_capability: Kimi Code \(ACP\) does not support steer/)
    assert.equal((await readdir(handoff.handoffInboxDir())).filter((name) => name.endsWith('.json')).length, 0)
    const forced = rpc(child, 14, {
      name: 'uniagent_task',
      arguments: { action: 'followup', prompt: 'change this turn now', taskId: 'force-target', force: true }
    })
    const forceRequest = await takeRequest(handoff.handoffInboxDir())
    assert.equal(forceRequest.force, true)
    assert.equal(forceRequest.targetSessionId, 'force-session')
    await writeState(handoff.handoffResultsDir(), forceRequest.id, {
      status: 'delivered', text: '', sessionId: 'force-session', taskId: 'force-target', delivery: 'force-delivered'
    })
    const forcedResponse = await forced
    assert.match(forcedResponse.result.content[0].text, /uniagent:event=force-delivered/)
    assert.match(forcedResponse.result.content[0].text, /taskId=force-target/)

    const stopping = rpc(child, 15, {
      name: 'uniagent_task', arguments: { action: 'stop', taskId: 'force-target' }
    })
    const stopRequest = await takeRequest(handoff.handoffInboxDir())
    assert.equal(stopRequest.action, 'stop')
    assert.equal(stopRequest.targetSessionId, 'force-session')
    await writeState(handoff.handoffResultsDir(), stopRequest.id, {
      status: 'interrupted', text: '已停止', sessionId: 'force-session', taskId: 'force-target', stoppedBy: 'stop_uniagent_task'
    })
    const stoppedResponse = await stopping
    assert.match(stoppedResponse.result.content[0].text, /uniagent:terminal=stopped/)

    const startedAt = Date.now()
    const waiting = rpc(child, 2, {
      name: 'uniagent_task',
      arguments: { action: 'create', prompt: 'keep waiting while running', wait: true, timeout: 0.05 }
    })
    const request = await takeRequest(handoff.handoffInboxDir())
    await writeState(handoff.handoffResultsDir(), request.id, {
      status: 'running', text: '', sessionId: 'child', delivery: 'started'
    })
    setTimeout(() => {
      void writeState(handoff.handoffResultsDir(), request.id, {
        status: 'idle', text: '最终结果', sessionId: 'child', delivery: 'started'
      })
    }, 720)
    const response = await waiting
    assert.ok(Date.now() - startedAt >= 700, 'running handoff must keep renewing beyond one wait window')
    assert.match(response.result.content[0].text, /最终结果/)
    assert.match(response.result.content[0].text, /uniagent:event=started/)
    assert.match(response.result.content[0].text, /uniagent:terminal=completed/)
  } finally {
    child.kill()
  }
} finally {
  handoff.handoffTaskStore.close()
  await rm(root, { recursive: true, force: true })
}

console.log('handoff-lifecycle: ok')
