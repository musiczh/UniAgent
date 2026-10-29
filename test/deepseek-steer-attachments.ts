import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { GrokACPRunner } from '../src/main/grokACPRunner.ts'
import { buildTextPromptBlocks } from '../src/main/acp/acpPromptBlocks.ts'
import type { AgentDef, Attachment } from '../src/shared/types.ts'

const root = await mkdtemp(join(tmpdir(), 'uniagent-deepseek-steer-attachments-'))
const image = join(root, 'picked.png'), textFile = join(root, 'picked.txt'), log = join(root, 'rpc.jsonl'), bin = join(root, 'dsh')
await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCzgAAAAASUVORK5CYII=', 'base64'))
await writeFile(textFile, 'User selected text file\n')
await writeFile(bin, `#!${process.execPath}\nrequire(${JSON.stringify(resolve('test/fixtures/fake-deepseek-extensions.cjs'))})\n`, { mode: 0o700 })
const agent: AgentDef = { id: 'deepseek', name: 'DeepSeek Harness', adapter: 'deepseek', bin, builtin: true, icon: '', models: [], capabilities: { modelSelect: true, reasoningEffort: true, permissionModes: [] } }
const runner = new GrokACPRunner('deepseek-steer-attachments', { n: 0 }, agent, { agentId: 'deepseek', workdir: root, permissionMode: 'ask' }, undefined, { FAKE_DEEPSEEK_EXT_LOG: log })
const attachments: Attachment[] = [{ kind: 'image', path: image, name: 'picked.png', mime: 'image/png' }, { kind: 'file', path: textFile, name: 'picked.txt', mime: 'text/plain' }]
try {
  await runner.probeSession(false)
  ;(runner as any).contract.imageAttachments = true
  const started = new Promise<void>(resolve => runner.once('event', event => { if (event.type === 'turn_started') resolve() }))
  const turn = runner.startTurn('hold ordinary turn')
  await started
  const calls: any[] = []
  const connection = (runner as any).connection
  const request = connection.request.bind(connection)
  connection.request = async (method: string, params: any, timeout?: number) => {
    if (method === '_uniagent/steer') { calls.push(params); return { accepted: true } }
    return request(method, params, timeout)
  }
  await runner.steer('Read the selected image and file', attachments)
  assert.deepEqual(calls[0], { sessionId: 'native-extension-session', prompt: await buildTextPromptBlocks('Read the selected image and file', attachments, { provider: 'deepseek', imageAttachments: true, fileAttachments: true }) },
    'steer must share ordinary ACP attachment conversion and target the active native session')
  ;(runner as any).contract.imageAttachments = false
  await assert.rejects(runner.steer('unsupported image', attachments), /不支持图片/)
  assert.equal(calls.length, 1, 'rejected model image inputs must not reach native steer')
  ;(runner as any).contract.imageAttachments = true
  const oldTurn = (runner as any).activeTurn
  const preparing = runner.steer('stale prepared attachment', attachments)
  ;(runner as any).activeTurn++
  await assert.rejects(preparing, /运行回合/)
  assert.equal(calls.length, 1, 'attachment read awaiting across native turn ownership must not send to the new turn')
  ;(runner as any).activeTurn = oldTurn
  connection.notify('_uniagent/fixture_release')
  await turn
  await assert.rejects(runner.steer('idle steer', attachments), /运行回合/)
  assert.ok((await readFile(log, 'utf8')).includes('hold ordinary turn'))
} finally { await runner.disposeAndWait(); await rm(root, { recursive: true, force: true }) }
console.log('deepseek-steer-attachments: ordinary ACP conversion, active session ownership and model image gate passed')
