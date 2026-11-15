import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { TaskCreation, validateTaskAttachments } from '../src/main/taskCreation'
import { atomicWriteFile } from '../src/main/sessionStore'
import { pendingTaskRequest, finishTaskRequest } from '../src/shared/taskRequest'

const root = await mkdtemp(join(tmpdir(), 'task-creation-'))
const payload = { config: { agentId: 'codex', projectId: 'space', permissionMode: 'ask' }, prompt: '原始输入' }
let checks = 0
try {
  const store = new TaskCreation(join(root, 'normal')), id = randomUUID()
  let starts = 0
  const hooks = { execute: async (receipt: any, accept: () => Promise<void>) => { await accept(); starts++; return receipt.sessionId }, existing: async (receipt: any) => receipt.sessionId }
  const results = await Promise.all(Array.from({ length: 12 }, () => store.run(id, 'message', payload, payload.prompt, hooks)))
  assert.equal(new Set(results).size, 1); assert.equal(starts, 1)
  assert.equal(await new TaskCreation(join(root, 'normal')).run(id, 'message', payload, payload.prompt, hooks), results[0]); assert.equal(starts, 1)
  await assert.rejects(store.run(id, 'message', { ...payload, prompt: '冲突内容' }, '冲突内容', hooks), /不同内容/)
  assert.deepEqual((await store.get(id))?.events.map(item => item.state), ['registered','accepted','dispatching','dispatched'])
  assert.equal(await store.run(id.toUpperCase(), 'message', payload, payload.prompt, hooks), results[0])
  assert.equal(starts, 1)
  checks++

  for (const failAt of [1, 2, 3, 4]) {
    let writes = 0, dispatched = 0, firstId: string | undefined
    const dir = join(root, 'write-' + failAt), requestId = randomUUID()
    const failing = new TaskCreation(dir, async (path, text) => { if (++writes === failAt) throw new Error('disk failure'); await atomicWriteFile(path, text) })
    const callbacks = { execute: async (record: any, accept: () => Promise<void>) => { firstId ||= record.sessionId; await accept(); dispatched++; return record.sessionId }, existing: async (record: any) => record.sessionId }
    await assert.rejects(failing.run(requestId, 'message', payload, payload.prompt, callbacks))
    const before = await new TaskCreation(dir).get(requestId)
    const result = await new TaskCreation(dir).run(requestId, 'message', payload, payload.prompt, callbacks)
    if (firstId) assert.equal(result, firstId)
    assert.ok(dispatched <= 1)
    if (before?.state === 'unknown') assert.equal(dispatched, failAt === 4 ? 1 : 0)
    checks++
  }

  // A separate process dies without catch/finally, after real fsync boundaries.
  const child = join(root, 'crash.mjs')
  await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
    import {TaskCreation} from './src/main/taskCreation';import{atomicWriteFile}from'./src/main/sessionStore';import{writeFileSync}from'node:fs';
    const [dir,id,step]=process.argv.slice(2);let writes=0;
    const store=new TaskCreation(dir,async(path,text)=>{await atomicWriteFile(path,text);if(++writes===Number(step))process.exit(19)});
    await store.run(id,'message',${JSON.stringify(payload)},'原始输入',{execute:async(r,accept)=>{writeFileSync(dir+'/identity',r.sessionId);await accept();writeFileSync(dir+'/executed','once');return r.sessionId},existing:async r=>r.sessionId});
  ` }, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: child, nodePaths: [resolve('node_modules')] })
  // External dependencies of the child resolve through the repository's modules.
  for (const boundary of [1, 2, 3, 4]) {
    const dir = join(root, 'crash-' + boundary), requestId = randomUUID()
    const result = spawnSync(process.execPath, [child, dir, requestId, String(boundary)], { encoding: 'utf8', env: { ...process.env, NODE_PATH: resolve('node_modules') } })
    assert.equal(result.status, 19, result.stderr)
    const restarted = new TaskCreation(dir), before = await restarted.get(requestId)
    let retried = 0
    const resultId = await restarted.run(requestId, 'message', payload, payload.prompt, {
      execute: async (receipt, accept) => { await accept(); retried++; return receipt.sessionId }, existing: async receipt => receipt.sessionId
    })
    assert.equal(resultId, before!.sessionId)
    assert.equal(retried, boundary <= 2 ? 1 : 0, 'an uncertain/dispatched input must never be replayed')
    checks++
  }

  const values = new Map<string, string>(), storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value) } }
  const pending = await pendingTaskRequest(storage, payload)
  assert.equal(await pendingTaskRequest(storage, structuredClone(payload)), pending)
  assert.notEqual(await pendingTaskRequest(storage, { ...payload, config: { ...payload.config, permissionMode: 'full-access' } }), pending)
  assert.ok(!storage.getItem('uniagent.pending-task-requests')!.includes(payload.prompt), 'the client identity cache stores no prompt text')
  finishTaskRequest(storage, pending); assert.notEqual(await pendingTaskRequest(storage, payload), pending)
  await assert.rejects(pendingTaskRequest({getItem:()=>'{',setItem:()=>{}},payload),/停止创建/)
  checks++

  const worktreePayload = { ...payload, config: { ...payload.config, workdir: '/main', workspaceSelection: { mode: 'worktree', baseRef: 'HEAD', requestId: randomUUID() } } }
  const worktreeId = await pendingTaskRequest(storage, worktreePayload)
  let fixedSession: string | undefined, prepareFails = true
  const worktreeHooks = { execute: async (record: any, accept: () => Promise<void>) => {
    fixedSession ||= record.sessionId
    assert.equal(record.sessionId, fixedSession); assert.equal(record.payload.config.workdir, '/main')
    if (prepareFails) { prepareFails = false; throw new Error('preparation interrupted') }
    await accept(); return record.sessionId
  }, existing: async (record: any) => record.sessionId }
  await assert.rejects(store.run(worktreeId, 'message', worktreePayload, payload.prompt, worktreeHooks), /preparation interrupted/)
  const preparedPayload = { ...worktreePayload, config: { ...worktreePayload.config, workdir: '/main.worktrees/ready', workspaceSelection: { ...worktreePayload.config.workspaceSelection, requestId: randomUUID() } } }
  assert.equal(await pendingTaskRequest(storage, preparedPayload), worktreeId, 'a derived worktree directory must not change retry identity')
  assert.equal(await store.run(worktreeId, 'message', preparedPayload, payload.prompt, worktreeHooks), fixedSession)
  assert.notEqual(await pendingTaskRequest(storage, { ...preparedPayload, config: { ...preparedPayload.config, workspaceSelection: { ...preparedPayload.config.workspaceSelection, baseRef: 'develop' } } }), worktreeId)
  checks++

  const attachment = join(root, 'file.txt'); await writeFile(attachment, 'sample')
  await validateTaskAttachments([{ path: attachment, name: 'sample', kind: 'file' } as any])
  await rm(attachment)
  await assert.rejects(validateTaskAttachments([{ path: attachment, name: 'sample', kind: 'file' } as any]), /失效/)
  await assert.rejects(validateTaskAttachments([{ path: root, name: 'folder', kind: 'file' } as any]), /不是文件/)
  checks++
  const broken = randomUUID(); await writeFile(join(root, 'normal', broken + '.json'), '{}')
  await assert.rejects(store.run(broken, 'message', payload, payload.prompt, hooks), /损坏/)
  checks++
  console.log('PASS Task creation: ' + checks + ' durability, hard-crash, conflict, retry, cache and attachment checks')
} finally { await rm(root, { recursive: true, force: true }) }
