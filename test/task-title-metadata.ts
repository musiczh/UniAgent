import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore, SessionStoreWriteError, atomicWriteFile } from '../src/main/sessionStore.ts'
import { TaskMetadataStore } from '../src/main/taskMetadataStore.ts'
import { taskDisplayTitle } from '../src/shared/taskTitle.ts'
import type { Session } from '../src/shared/types.ts'

function session(id: string, title = '临时标题'): Session {
  return {
    id,
    title,
    status: 'idle',
    createdAt: 1,
    config: { agentId: 'codex', workdir: '/repo' }
  }
}

const root = await mkdtemp(join(tmpdir(), 'task-title-metadata-'))
try {
  const store = new TaskMetadataStore(join(root, 'metadata'))

  const fresh = session('fresh', '自动派生标题')
  store.initialize(fresh, false)
  assert.equal(store.current(fresh).source, 'fallback')
  assert.equal(taskDisplayTitle(fresh), '自动派生标题')

  const legacy = { ...session('legacy', '历史锁定标题'), titleLocked: true }
  store.initialize(legacy, true)
  assert.equal(store.current(legacy).source, 'legacy-preserved')
  assert.equal(taskDisplayTitle(legacy), '历史锁定标题')

  const editable = session('editable', '初始标题')
  store.initialize(editable, false)
  const base = store.current(editable)
  const manual = await store.change(editable, base.version, (metadata) => {
    metadata.title = '手动标题'
    metadata.source = 'manual'
    metadata.generationState = 'ready'
    metadata.lastErrorCode = undefined
    metadata.seed = { primaryIntent: '原始任务意图', assistantResponse: '主 AI 对图片对象的解释', clarifications: ['补充'], images: [{ kind: 'image', path: '/fixture/image.png', name: 'image.png' }] }
  })
  assert.equal(manual.source, 'manual')
  assert.equal(manual.seed?.primaryIntent, '原始任务意图')
  assert.equal(editable.taskMetadata?.seed, undefined, 'runtime session projection omits plaintext seed')
  assert.equal(taskDisplayTitle(editable), '手动标题')
  await assert.rejects(
    store.change(editable, base.version, (metadata) => {
      metadata.title = '迟到生成'
      metadata.source = 'generated'
      metadata.generationState = 'ready'
    }),
    /已变化/
  )
  await store.flush()

  const restored = session('editable', '初始标题')
  const rebooted = new TaskMetadataStore(join(root, 'metadata'))
  await rebooted.hydrate([restored])
  assert.equal(rebooted.current(restored).source, 'manual')
  assert.equal(taskDisplayTitle(restored), '手动标题')
  assert.equal(rebooted.current(restored).seed?.assistantResponse, '主 AI 对图片对象的解释', 'bounded response survives metadata hydration')
  assert.equal(rebooted.current(restored).seed?.images?.[0].path, '/fixture/image.png', 'image references survive recovery without embedding bytes')
  assert.equal(restored.taskMetadata?.seed, undefined, 'hydrated output remains private to the title store')
  const hashedId = createHash('sha256').update(editable.id).digest('hex') + '.json'
  assert.ok((await readdir(join(root, 'metadata'))).includes(hashedId))

  const broken = session('broken', '失败前标题')
  const brokenStore = new TaskMetadataStore(join(root, 'broken'), async () => { throw new Error('disk full') })
  brokenStore.initialize(broken, false)
  await assert.rejects(
    brokenStore.change(broken, brokenStore.current(broken).version, (metadata) => {
      metadata.title = '不会提交'
      metadata.source = 'generated'
      metadata.generationState = 'ready'
    }),
    /disk full/
  )
  assert.equal(brokenStore.current(broken).version, 0)
  assert.equal(taskDisplayTitle(broken), '失败前标题')

  const uncertain = session('uncertain', '提交前标题')
  const uncertainStore = new TaskMetadataStore(join(root, 'uncertain'), async (file, data) => {
    await atomicWriteFile(file, data)
    throw new SessionStoreWriteError('fsync uncertain', 'committed-durability-uncertain', new Error('fsync'))
  })
  uncertainStore.initialize(uncertain, false)
  await assert.rejects(
    uncertainStore.change(uncertain, uncertainStore.current(uncertain).version, (metadata) => {
      metadata.title = '已提交标题'
      metadata.source = 'generated'
      metadata.generationState = 'ready'
      metadata.generator = { agentId: 'codex', model: 'gpt-5.6-luna' }
    }),
    /fsync/
  )
  assert.equal(uncertainStore.current(uncertain).title, '已提交标题')
  const uncertainFiles = await readdir(join(root, 'uncertain'))
  assert.equal(uncertainFiles.length, 1)
  const persisted = JSON.parse(await readFile(join(root, 'uncertain', uncertainFiles[0]!), 'utf8'))
  assert.equal(persisted.title, '已提交标题')

  await rebooted.remove(restored.id)
  assert.equal(rebooted.current(restored).source, 'fallback')
  assert.equal(taskDisplayTitle(restored), '初始标题')

  const persistedSession = session('serialize', '只在会话里可见')
  persistedSession.taskMetadata = {
    formatVersion: 1,
    taskId: persistedSession.id,
    version: 3,
    title: '运行时标题',
    source: 'generated',
    generationState: 'ready',
    contextGeneration: 1,
    attempts: 1
  }
  const sessionsFile = join(root, 'sessions.json')
  const sessionStore = new SessionStore(sessionsFile)
  sessionStore.save([persistedSession])
  const rawSessions = await readFile(sessionsFile, 'utf8')
  assert.doesNotMatch(rawSessions, /taskMetadata/, 'runtime task metadata never leaks into sessions.json')
  assert.equal((sessionStore.load()[0] as Session | undefined)?.taskMetadata, undefined)
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('task-title-metadata: ok')
