import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindDeepSeekHostContext, registerDeepSeekHostContext, deepseekHostContextPlugin } from '../src/main/deepseekHostContext.ts'
import type { DeepSeekHostClient } from '../src/main/deepseekHostClient.ts'

const root = await mkdtemp(join(tmpdir(), 'ua-host-context-'))
try {
  await mkdir(join(root, 'uniagent-context'))
  const plugin = await import('data:text/javascript;base64,' + Buffer.from(deepseekHostContextPlugin).toString('base64'))
  let handler: any, busy = false, fail = false
  const mounts: any[] = [], disposals: any[] = []
  await plugin.apply({ loader: { import: async (name: string) => { assert.equal(name, '@deepseek-ai/dsh-mcp-client'); return {} } }, commands: { register: (definition: any) => { handler = definition.handler } } }, {
    directory: join(root, 'uniagent-context')
  })
  const agent = { session: { id: '../../native/path' },
    runMaintenance: async (callback: any) => { if (busy) throw new Error('busy'); return callback() },
    ctx: { plugin: (_module: any, config: any) => {
      mounts.push(config)
      const fiber = { dispose: async () => { disposals.push(config) } }
      return Object.assign(fail ? Promise.reject(new Error('startup failed')) : Promise.resolve(fiber), fiber)
    } }
  }
  const client = { call: async (_method: string, args: any) => {
    assert.equal(args.agentId, agent.session.id)
    assert.equal(args.line, '/uniagent-bind-context')
    return { result: await handler({ agent, rawInput: '' }) }
  } } as unknown as DeepSeekHostClient
  registerDeepSeekHostContext(client, root, id => [{ name: 'uniagent', command: '/node', args: ['server.js'], env: [{ name: 'UNIAGENT_CALLER_SESSION', value: id }] }])
  await bindDeepSeekHostContext(client, agent.session.id, 'local-one', root)
  assert.equal(mounts[0].env.UNIAGENT_CALLER_SESSION, 'local-one')
  assert.equal(mounts[0].failOnStartupError, true)
  await bindDeepSeekHostContext(client, agent.session.id, 'local-one', root)
  assert.equal(mounts.length, 1, 'same context does not create duplicate MCP tools')
  await bindDeepSeekHostContext(client, agent.session.id, 'local-two', root)
  assert.equal(disposals.length, 1, 'old caller scope is disposed before rebinding')
  assert.equal(mounts[1].env.UNIAGENT_CALLER_SESSION, 'local-two')
  busy = true
  await assert.rejects(bindDeepSeekHostContext(client, agent.session.id, 'local-three', root), /busy/)
  assert.equal(mounts.length, 2, 'running native agents cannot rebind tools')
  busy = false; fail = true
  await assert.rejects(bindDeepSeekHostContext(client, agent.session.id, 'local-three', root), /startup failed/)
  assert.equal(disposals.length, 3, 'both previous and failed partial mounts are cleaned up')
  fail = false
  await bindDeepSeekHostContext(client, agent.session.id, 'local-three', root)
  assert.equal(mounts.length, 4, 'failed activation does not masquerade as a bound context')
  assert.equal((await handler({ agent, rawInput: 'arbitrary-command' })).kind, 'error')
  await assert.rejects(readFile(join(root, 'path.json')), { code: 'ENOENT' })
  console.log('DeepSeek Host context: exact caller, idempotence, rebind cleanup, busy and failed activation passed')
} finally { await rm(root, { recursive: true, force: true }) }
