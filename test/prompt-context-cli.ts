import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { RouterMcpBridge, runtimeContextCli, runtimeContextCliGuide, projectMemoryCli } from '../src/main/router/mcp'
import { configureAssistantContextRuntime, queryAssistantContext } from '../src/main/assistant/context'
import { configureRequirementRuntime, requirementContextForCaller, setRequirementsEnabled } from '../src/main/requirementRuntime'
import type { Session } from '../src/shared/types'

const directory = await mkdtemp(join(tmpdir(), "ua-context cli-'-"))
const session: Session = { id: 'cli-owner', title: 'CLI', createdAt: 1, status: 'idle', config: { agentId: 'fixture-cli', workdir: directory, requirementId: 'req-current' } }
const lookup = (id: string) => id === session.id ? session : undefined
configureAssistantContextRuntime(lookup, () => {})
setRequirementsEnabled(true)
configureRequirementRuntime(lookup, async (id, args) => ({ caller: id, requirementId: lookup(id)!.config.requirementId, action: args.action }))
const bridge = new RouterMcpBridge(directory, async () => { throw new Error('router tools are not available here') }, undefined,
  (id, tool, args) => tool === 'uniagent_query' ? queryAssistantContext(id, args) : requirementContextForCaller(id, args as any))
try {
  await bridge.bindMemory(session.id, true, { project: false })
  const cli = runtimeContextCli(session.id)!
  assert.ok(cli)
  assert.equal(projectMemoryCli(session.id), undefined, 'runtime queries do not enable project memory')
  const guide = runtimeContextCliGuide(session.id)
  assert.match(guide, /requirement_context/)
  assert.ok(!guide.includes(cli.command) && cli.args.every(arg => !guide.includes(arg)), 'CLI instructions hide absolute executable and binding paths')
  const command = guide.match(/`([^`]+)`/)?.[1]
  assert.ok(command, 'the CLI guide includes a copyable short command')
  const fromGuide = JSON.parse((await promisify(execFile)('/bin/sh', ['-c', command!], { cwd: directory, env: process.env })).stdout)
  assert.equal(fromGuide.sessionId, session.id, 'the short entry selects this session without a binding path in the prompt')
  const execute = async (args: unknown) => {
    const result = await promisify(execFile)(join(dirname(cli.args[0]), 'uniagent-context'), [session.id, JSON.stringify(args)], { env: process.env })
    return JSON.parse(result.stdout)
  }
  const context = await execute({ name: 'uniagent_query', arguments: { action: 'context' } })
  assert.equal(context.sessionId, session.id); assert.equal(context.agentId, 'fixture-cli')
  assert.equal(context.workspace.workdir, directory)
  assert.equal(context.token, undefined)
  const legacy = await promisify(execFile)(cli.command, [...cli.args, JSON.stringify({ name: 'uniagent_query', arguments: { action: 'context' } })], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  assert.equal(JSON.parse(legacy.stdout).sessionId, session.id, 'existing frozen CLI instructions remain executable')
  await assert.rejects(promisify(execFile)(join(dirname(cli.args[0]), 'uniagent-context'), ['missing-session', '{"action":"read"}']), /Command failed/)
  assert.deepEqual(await execute({ name: 'requirement_context', arguments: { action: 'bootstrap' } }), { caller: session.id, requirementId: 'req-current', action: 'bootstrap' })
  await assert.rejects(execute({ name: 'uniagent_query', arguments: { action: 'context', id: 'other-session' } }), /Command failed/)
  await assert.rejects(execute({ name: 'uniagent_task', arguments: { action: 'create', prompt: 'outside scope' } }), /Command failed/)
  bridge.setMemoryActive(session.id, false)
  assert.equal(runtimeContextCli(session.id), undefined)
  await assert.rejects(execute({ name: 'uniagent_query', arguments: { action: 'context' } }), /Command failed/)
  console.log('PASS CLI current context and requirement entry, caller binding, inactive scope and forbidden task creation')
} finally {
  await bridge.close(); configureAssistantContextRuntime(() => undefined, () => {})
  configureRequirementRuntime(() => undefined); setRequirementsEnabled(false)
}
