import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TurnRunner } from '../src/main/adapter'
import { handoffMcpServers } from '../src/main/handoff'
import { configureAssistantContextRuntime, configureProjectContext, stripAssistantContext } from '../src/main/assistant/context'
import type { AgentDef, Session } from '../src/shared/types'

const directory = await mkdtemp(join(tmpdir(), 'ua-oneshot-context-'))
const log = join(directory, 'inputs.jsonl'), binary = join(directory, 'fixture.cjs')
await writeFile(binary, `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify({prompt:process.argv.find(arg=>['已取消的请求','新请求','后续原文'].some(text=>arg.endsWith(text))),instructions:process.argv.filter(arg=>arg.startsWith('developer_instructions='))})+'\\n');
process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'fixture-thread'})+'\\n');
process.stdout.write(JSON.stringify({type:'item.completed',item:{id:'reply',type:'agent_message',text:'completed'}})+'\\n');
`, { mode: 0o700 })
const agent = { id: 'codex', adapter: 'codex', name: 'Fixture', bin: binary, models: [], capabilities: { permissionModes: [{ id: 'ask' }] } } as AgentDef
const session = { id: 'oneshot-context', title: 'Fixture', createdAt: 1, status: 'idle', config: { agentId: agent.id, workdir: directory, permissionMode: 'ask' } } as Session
configureAssistantContextRuntime(id => id === session.id ? session : undefined, () => {})
let release!: () => void, entered!: () => void
const loading = new Promise<void>(resolve => { entered = resolve })
const barrier = new Promise<void>(resolve => { release = resolve })
configureProjectContext(async () => { entered(); await barrier; return '固定项目资料' })
const runner = new TurnRunner(session.id, { n: 0 })
const errors: string[] = []
const launches: string[] = []
runner.on('event', event => {
  if (event.type === 'error') errors.push(event.payload.message)
  if (event.payload.kind === 'launch') launches.push(event.payload.text)
})
const waitDone = () => Promise.race([once(runner, 'done'), new Promise<never>((_, reject) => {
  const timer = setTimeout(() => reject(new Error('one-shot delivery timed out')), 5000); timer.unref()
})])
try {
  runner.start(agent, session.config, '已取消的请求')
  await loading
  runner.interrupt()
  const done = waitDone(); runner.start(agent, session.config, '新请求'); release()
  await done
  assert.deepEqual(errors, [], 'initialization and launch must succeed')
  const first = JSON.parse((await readFile(log, 'utf8')).trim())
  assert.equal(stripAssistantContext(first.prompt), '新请求', 'cancelled asynchronous preparation must not start its old prompt')
  assert.match(first.prompt, /当前消息通道：UniAgent App/, 'the exec input receives the first host channel as well as system rules')
  assert.match(first.instructions.join(''), /固定项目资料/)
  assert.doesNotMatch(first.prompt, /固定项目资料/)
  const token = handoffMcpServers(session.id)[0].env.find(row => row.name === 'UNIAGENT_CONTEXT_TOKEN')!.value
  assert.ok(token)
  assert.ok(launches.every(text => !text.includes(token)), 'launch events must redact the new caller capability')
  const next = waitDone(); runner.start(agent, session.config, '后续原文'); await next
  const inputs = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(inputs.length, 2); assert.equal(inputs[1].prompt, '后续原文')
  console.log('PASS one-shot cancellation during initialization, system rules and subsequent raw input')
} finally { configureProjectContext(undefined); configureAssistantContextRuntime(() => undefined, () => {}) }
