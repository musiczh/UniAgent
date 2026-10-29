import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'

const directory = await mkdtemp(resolve('out/test/assistant-worker-'))
let worker: Worker | undefined
let timer: ReturnType<typeof setTimeout> | undefined
try {
  const entry = join(directory, 'worker.mjs')
  await build({ entryPoints: ['src/main/assistant/worker.ts'], bundle: true, platform: 'node',
    format: 'esm', packages: 'external', outfile: entry })
  let sequence = 0
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
  await new Promise<void>((resolveReady, rejectReady) => {
    worker = new Worker(entry, { workerData: { path: join(directory, 'assistant.sqlite') } })
    const fail = (error: Error): void => { rejectReady(error); for (const request of pending.values()) request.reject(error) }
    worker.on('error', fail)
    worker.on('message', message => {
      if (message.ready) return resolveReady()
      if (message.fatal) return fail(new Error(message.fatal))
      const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id)
      message.error ? request.reject(new Error(message.error)) : request.resolve(message.value)
    })
    timer = setTimeout(() => fail(new Error('assistant worker timed out')), 10_000)
  })
  const request = (method: string, args: unknown[] = []): Promise<any> => new Promise((resolveReply, reject) => {
    const id = ++sequence
    pending.set(id, { resolve: resolveReply, reject })
    worker!.postMessage({ id, method, args })
  })
  await request('transcript', [
    { id: 'worker-search', title: '历史搜索验证', agentId: 'codex', createdAt: 1, archived: false },
    [{ id: 'message', sessionId: 'worker-search', seq: 1, ts: 1, role: 'user', content: '检索临时记录', visibility: 'live' }]
  ])
  assert.equal((await request('search', [{ query: '临时记录' }])).sessions[0].sessionId, 'worker-search')
  await assert.rejects(request('search', [{ sessionId: 'unbound' }]), /session_out_of_scope/)
  await assert.rejects(request('unlisted_method'), /invalid_store_method/)
  await request('close')
  console.log('assistant store worker search: ok')
} finally {
  clearTimeout(timer)
  await worker?.terminate()
  await rm(directory, { recursive: true, force: true })
}
