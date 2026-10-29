import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { additionalDirectoryArgs, appServerAdditionalDirectoryArgs } from '../src/main/adapter.ts'
import { DEFAULT_PROJECT_ID, ProjectStore } from '../src/main/projectStore.ts'
import { SessionStore } from '../src/main/sessionStore.ts'

test('default project is stable and always points at HOME', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'uniagent-projects-'))
  t.after(() => rm(directory, { recursive: true, force: true }))

  const project = new ProjectStore(directory).defaultProject()

  assert.equal(project.id, DEFAULT_PROJECT_ID)
  assert.equal(project.name, '默认项目')
  assert.equal(project.primaryDirectory, homedir())
  assert.deepEqual(project.additionalDirectories, [])
  assert.equal(project.isDefault, true)
})

test('legacy workdirs migrate once into reusable single-directory projects', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'uniagent-projects-'))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new ProjectStore(directory)

  const first = store.ensureProjectForDirectory(workspace)
  const second = store.ensureProjectForDirectory(workspace + '/')

  assert.equal(first.id, second.id)
  assert.equal(first.name, 'workspace')
  assert.equal(store.list().length, 2)
})

test('legacy session workdir is rewritten as project identity during load', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'uniagent-projects-'))
  const workspace = join(directory, 'workspace')
  const sessionsFile = join(directory, 'sessions.json')
  await mkdir(workspace)
  await writeFile(sessionsFile, JSON.stringify([{
    id: 'legacy-session',
    title: 'Legacy',
    config: { agentId: 'codex', workdir: workspace },
    status: 'idle',
    createdAt: 1
  }]))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const projects = new ProjectStore(directory)
  const sessions = new SessionStore(sessionsFile, (config) => projects.resolveSessionConfig(config)).load()

  assert.ok(sessions[0].config.projectId)
  const persisted = JSON.parse(await readFile(sessionsFile, 'utf8'))
  assert.equal(persisted[0].config.projectId, sessions[0].config.projectId)
  assert.equal('workdir' in persisted[0].config, false)
})

test('project updates reject duplicate and missing directories without corrupting disk', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'uniagent-projects-'))
  const primary = join(directory, 'primary')
  const extra = join(directory, 'extra')
  await Promise.all([mkdir(primary), mkdir(extra)])
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new ProjectStore(directory)
  const project = store.create({ name: 'Workspace', primaryDirectory: primary, additionalDirectories: [extra] })
  const before = await readFile(join(directory, 'projects.json'), 'utf8')

  assert.throws(() => store.update(project.id, {
    name: 'Broken', primaryDirectory: primary, additionalDirectories: [primary]
  }), /project_directory_duplicate/)
  assert.equal(await readFile(join(directory, 'projects.json'), 'utf8'), before)
})

test('agent directory arguments keep order and remove the primary directory', () => {
  assert.deepEqual(
    additionalDirectoryArgs('/repo/main', ['/repo/docs', '/repo/main', '/repo/api', '/repo/docs']),
    ['--add-dir', '/repo/docs', '--add-dir', '/repo/api']
  )
})

test('app-server directory arguments remain router-compatible', () => {
  assert.deepEqual(
    appServerAdditionalDirectoryArgs('/repo/main', ['/repo/docs', '/repo/main', '/repo/api', '/repo/docs']),
    ['-c', 'sandbox_workspace_write.writable_roots=["/repo/docs","/repo/api"]']
  )
})
