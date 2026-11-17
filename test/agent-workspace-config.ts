import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_AGENTS } from '../src/main/agents'
import { Orchestrator } from '../src/main/orchestrator'
import { ProjectStore } from '../src/main/projectStore'
import { RequirementStore } from '../src/main/requirementStore'
import { SessionStore } from '../src/main/sessionStore'
import { configureRequirementRuntime, prepareRequirementTurn, requirementContextForCaller, setRequirementsEnabled } from '../src/main/requirementRuntime'
import { assistantInitialization, configureAssistantContextRuntime, prepareAssistantInitialization } from '../src/main/assistant/context'
import type { AgentDef, Session, SessionConfig } from '../src/shared/types'

const root = await mkdtemp(join(tmpdir(), 'uniagent-workspace-config-'))
const previousUserData = process.env.UNIAGENT_USER_DATA
process.env.UNIAGENT_USER_DATA = root
setRequirementsEnabled(true)
const hosts: Orchestrator[] = []
try {
  const primary = join(root, 'primary'), extra = join(root, 'extra')
  await Promise.all([mkdir(primary), mkdir(extra)])
  const projects = new ProjectStore(root)
  const project = projects.create({ name: 'Workspace', primaryDirectory: primary, additionalDirectories: [extra] })
  const requirements = new RequirementStore(join(root, 'requirements-home'))
  const requirement = await requirements.create({ name: 'Workspace requirement', projectId: project.id })
  const resolve = (config: SessionConfig, validate = false) => requirements.resolveSessionConfig(projects.resolveSessionConfig(config, validate), validate)
  const originalProjects = await readFile(join(root, 'projects.json'), 'utf8')
  for (const base of BUILTIN_AGENTS) {
    const agent = { ...base, installed: true } as AgentDef
    const host = new Orchestrator(id => id === agent.id ? agent : undefined, new SessionStore(join(root, agent.id, 'sessions.json')), join(root, agent.id, 'artifacts'), undefined, resolve)
    hosts.push(host)
    const session = (host as any).createSessionRecord({ agentId: agent.id, projectId: project.id, requirementId: requirement.id, workdir: primary, permissionMode: 'ask' }, 'Workspace fixture').session as Session
    assert.equal(session.config.workdir, primary)
    assert.deepEqual(session.config.additionalDirectories, agent.capabilities.additionalDirectoriesNew ? [extra] : [], agent.id + ' only receives supported source roots')
    assert.equal(session.config.requirementId, requirement.id)
    assert.equal(session.config.requirementDocPath, requirement.docPath)
    if (agent.id === 'codex') {
      const forked = { ...session, forkedFrom: { exportId: 'fixture' } }
      const workspace = (host as any).resolveSessionWorkspace(forked, session.config)
      assert.equal((host as any).resolveSessionWorkspace(forked, workspace), workspace, 'repeated workspace checks do not trigger redundant config writes for forks')
    }
    let contextReads = 0
    configureRequirementRuntime(id => id === session.id ? session : undefined, async (id, request) => {
      assert.equal(id, session.id)
      assert.equal(request.action, 'bootstrap')
      contextReads++
      return { requirement: { name: 'Workspace requirement' }, revision: 'fixture', overview: { goal: 'Context remains available' }, readingStatus: 'ready', navigation: [] }
    })
    configureAssistantContextRuntime(id => id === session.id ? session : undefined, () => {})
    await prepareAssistantInitialization(session)
    assert.deepEqual(JSON.parse(assistantInitialization(session.id)), {
      requirement: { id: requirement.id, name: 'Workspace requirement', overview: { goal: 'Context remains available' }, readingStatus: 'ready' }
    }, agent.id + ' retains the requirement identity and short goal in initialization')
    const prepared = prepareRequirementTurn(session, 'continue')
    assert.equal(await prepared.ready, 'continue', agent.id + ' preserves the followup input')
    assert.equal(contextReads, 1, 'ordinary input does not refresh requirement facts')
    assert.equal(prepared.current(), true)
    prepared.complete()
    assert.equal(prepared.current(), false)
    const onDemand = await requirementContextForCaller(session.id, { action: 'bootstrap' }) as { overview: { goal: string } }
    assert.equal(onDemand.overview.goal, 'Context remains available', agent.id + ' can still read requirement context through its bound tool')
    assert.equal(contextReads, 2)
  }
  assert.equal(await readFile(join(root, 'projects.json'), 'utf8'), originalProjects, 'Agent capabilities never change the space configuration')

  for (const [newSupported, resumeSupported] of [[true, false], [false, true], [false, false], [true, true]]) {
    const base = BUILTIN_AGENTS.find(agent => agent.id === 'codex')!
    const agent = { ...base, capabilities: { ...base.capabilities, additionalDirectoriesNew: newSupported, additionalDirectoriesResume: resumeSupported } }
    const file = join(root, `restore-${newSupported}-${resumeSupported}`, 'sessions.json')
    const store = new SessionStore(file, resolve)
    const persisted: Session = { id: 'restored', title: 'Restored', status: 'idle', createdAt: 1, nativeSessionId: 'native-fixture', config: { agentId: 'codex', projectId: project.id, requirementId: requirement.id, workdir: primary, permissionMode: 'ask' } }
    store.saveOrThrow([persisted])
    const host = new Orchestrator(() => agent, store, join(root, 'restore-artifacts'), undefined, resolve)
    hosts.push(host)
    await host.loadPersisted()
    const session = host.getSessionById(persisted.id)!
    assert.deepEqual(session.config.additionalDirectories, resumeSupported ? [extra] : [], 'restoration uses the resume capability')
    await host.updateSessionConfig(session.id, { effort: 'high', additionalDirectories: [extra, requirement.dir] })
    assert.deepEqual(session.config.additionalDirectories, resumeSupported ? [extra] : [], 'config updates keep requirement roots out of the native workspace')
  }
  console.log('agent-workspace-config: all nine adapters, requirement context, persistent space configuration, restoration and config updates passed')
} finally {
  for (const host of hosts) { host.disposeAll(); await host.closeSessionLogs() }
  configureRequirementRuntime(() => undefined)
  configureAssistantContextRuntime(() => undefined, () => {})
  setRequirementsEnabled(false)
  if (previousUserData === undefined) delete process.env.UNIAGENT_USER_DATA
  else process.env.UNIAGENT_USER_DATA = previousUserData
  await rm(root, { recursive: true, force: true })
}
