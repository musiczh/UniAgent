import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DEFAULT_ENABLED_AGENT_IDS, PERMISSION_MODE_IDS, type AppSettings, type AppSettingsPatch, type FeishuSettings, type LifecycleMetrics, type NotificationMode, type ReasoningEffort, type ThemePreference } from '../shared/types.ts'
import { resolveUserDataHome } from './userData.ts'
import { sanitizeSidebarShortcuts } from '../shared/settingsNavigation.ts'

const DEFAULT_SETTINGS: AppSettings = { schemaVersion: 1, autoUpdateAgentsOnLaunch: false, autoUpdateAgentsWhenIdle: false, enabledAgentIds: [...DEFAULT_ENABLED_AGENT_IDS], autoCheckUpdate: true, theme: 'system', notificationMode: 'unfocused', preventSleep: false, coverSidebar: false, requirementsEnabled: false }

const ALL_EFFORTS: ReasoningEffort[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const ALL_THEMES: ThemePreference[] = ['system', 'dark', 'light']
const ALL_NOTIFICATION_MODES: NotificationMode[] = ['unfocused', 'always', 'off']
const DEFAULT_FEISHU_IDLE_THRESHOLD_SEC = 300
const LEGACY_FEISHU_IDLE_THRESHOLD_SEC = 90

function sanitizeEnabledAgentIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_ENABLED_AGENT_IDS]
  return [...new Set(raw.filter((id): id is string => typeof id === 'string' && id.length > 0))]
}

/**
 * 需求4 — validate/normalize a persisted Feishu block. Returns undefined for an
 * absent/malformed value so the rest of settings still loads (fail-soft). The
 * App Secret stays as-is (persisted 0600); optional defaults are dropped when
 * empty or of the wrong type rather than guessed.
 */
function sanitizeFeishu(raw: any): FeishuSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  if (typeof raw.enabled !== 'boolean') return undefined
  const idle = Number(raw.idleThresholdSec)
  const idleThresholdSec = idle === LEGACY_FEISHU_IDLE_THRESHOLD_SEC
    ? DEFAULT_FEISHU_IDLE_THRESHOLD_SEC
    : idle === 0 || (Number.isFinite(idle) && idle >= 10 && idle <= 3600)
      ? Math.round(idle)
      : DEFAULT_FEISHU_IDLE_THRESHOLD_SEC
  const clean: FeishuSettings = {
    enabled: raw.enabled,
    appId: typeof raw.appId === 'string' ? raw.appId : '',
    appSecret: typeof raw.appSecret === 'string' ? raw.appSecret : '',
    notifyOnlyWhenLocked: typeof raw.notifyOnlyWhenLocked === 'boolean' ? raw.notifyOnlyWhenLocked : true,
    idleThresholdSec
  }
  if (typeof raw.botName === 'string' && raw.botName.trim()) clean.botName = raw.botName.trim()
  if (typeof raw.defaultAgentId === 'string' && raw.defaultAgentId) clean.defaultAgentId = raw.defaultAgentId
  if (typeof raw.defaultModel === 'string' && raw.defaultModel) clean.defaultModel = raw.defaultModel
  if (ALL_EFFORTS.includes(raw.defaultEffort)) clean.defaultEffort = raw.defaultEffort
  if (PERMISSION_MODE_IDS.includes(raw.defaultPermissionMode)) clean.defaultPermissionMode = raw.defaultPermissionMode
  if (typeof raw.defaultProjectId === 'string' && raw.defaultProjectId) clean.defaultProjectId = raw.defaultProjectId
  if (typeof raw.defaultWorkdir === 'string' && raw.defaultWorkdir) clean.defaultWorkdir = raw.defaultWorkdir
  if (typeof raw.notifyChatId === 'string' && raw.notifyChatId) clean.notifyChatId = raw.notifyChatId
  if (clean.notifyChatId) {
    clean.notifyChatType = raw.notifyChatType === 'private' ? 'private' : 'group'
    if (typeof raw.notifyChatName === 'string' && raw.notifyChatName) clean.notifyChatName = raw.notifyChatName
  }
  return clean
}

export class AppSettingsStore {
  private readonly settingsFile: string
  private readonly metricsFile: string
  private readonly initializationFile: string

  constructor(directory = resolveUserDataHome()) {
    this.settingsFile = join(directory, 'app-settings.json')
    this.metricsFile = join(directory, 'lifecycle-metrics.json')
    this.initializationFile = join(directory, 'initialization-jobs.json')
  }

  get(): AppSettings {
    try {
      const raw = JSON.parse(readFileSync(this.settingsFile, 'utf8'))
      if (raw?.schemaVersion === 1 && typeof raw.autoUpdateAgentsOnLaunch === 'boolean') {
        const feishu = sanitizeFeishu(raw.feishu)
        const assistantFeishu = sanitizeFeishu(raw.assistantFeishu)
        return {
          schemaVersion: 1,
          autoUpdateAgentsOnLaunch: raw.autoUpdateAgentsOnLaunch,
          autoUpdateAgentsWhenIdle: typeof raw.autoUpdateAgentsWhenIdle === 'boolean' ? raw.autoUpdateAgentsWhenIdle : false,
          enabledAgentIds: sanitizeEnabledAgentIds(raw.enabledAgentIds),
          autoCheckUpdate: typeof raw.autoCheckUpdate === 'boolean' ? raw.autoCheckUpdate : true,
          theme: ALL_THEMES.includes(raw.theme) ? raw.theme : 'system',
          notificationMode: ALL_NOTIFICATION_MODES.includes(raw.notificationMode) ? raw.notificationMode : 'unfocused',
          preventSleep: typeof raw.preventSleep === 'boolean' ? raw.preventSleep : false,
          coverSidebar: typeof raw.coverSidebar === 'boolean' ? raw.coverSidebar : false,
          sidebarShortcuts: sanitizeSidebarShortcuts(raw.sidebarShortcuts),
          requirementsEnabled: raw.requirementsEnabled === true,
          ...(feishu ? { feishu } : {}),
          ...(assistantFeishu ? { assistantFeishu } : {})
        }
      }
    } catch { /* default on absent/corrupt/future schema */ }
    return { ...DEFAULT_SETTINGS, enabledAgentIds: [...DEFAULT_ENABLED_AGENT_IDS], sidebarShortcuts: sanitizeSidebarShortcuts(undefined) }
  }

  set(patch: AppSettingsPatch): AppSettings {
    const current = this.get()
    // 需求4 — a feishu patch is a shallow merge onto the current block, so the
    // renderer can toggle one field (e.g. enabled / a default) without re-sending
    // the App Secret. Passing `feishu: null` (any falsy) clears the block.
    let feishu: FeishuSettings | undefined = current.feishu
    if ('feishu' in patch) {
      feishu = patch.feishu
        ? sanitizeFeishu({ ...current.feishu, ...patch.feishu })
        : undefined
      if (feishu && patch.feishu && 'defaultProjectId' in patch.feishu) delete feishu.defaultWorkdir
      if (feishu && current.feishu && current.feishu.appId !== feishu.appId) {
        delete feishu.notifyChatId
        delete feishu.notifyChatType
        delete feishu.notifyChatName
      }
    }
    const assistantFeishu = 'assistantFeishu' in patch
      ? patch.assistantFeishu ? sanitizeFeishu({ ...current.assistantFeishu, ...patch.assistantFeishu }) : undefined
      : current.assistantFeishu
    if (feishu?.enabled && assistantFeishu?.enabled && feishu.appId && feishu.appId === assistantFeishu.appId) {
      throw new Error('个人助手需要使用独立的飞书机器人，请选择与飞书远程控制不同的 App ID')
    }
    const next: AppSettings = {
      schemaVersion: 1,
      autoUpdateAgentsOnLaunch: typeof patch.autoUpdateAgentsOnLaunch === 'boolean'
        ? patch.autoUpdateAgentsOnLaunch : current.autoUpdateAgentsOnLaunch,
      autoUpdateAgentsWhenIdle: typeof patch.autoUpdateAgentsWhenIdle === 'boolean'
        ? patch.autoUpdateAgentsWhenIdle : current.autoUpdateAgentsWhenIdle,
      enabledAgentIds: Array.isArray(patch.enabledAgentIds)
        ? sanitizeEnabledAgentIds(patch.enabledAgentIds)
        : sanitizeEnabledAgentIds(current.enabledAgentIds),
      autoCheckUpdate: typeof patch.autoCheckUpdate === 'boolean' ? patch.autoCheckUpdate : current.autoCheckUpdate,
      theme: ALL_THEMES.includes(patch.theme as ThemePreference) ? patch.theme : (current.theme ?? 'system'),
      notificationMode: ALL_NOTIFICATION_MODES.includes(patch.notificationMode as NotificationMode)
        ? patch.notificationMode : (current.notificationMode ?? 'unfocused'),
      preventSleep: typeof patch.preventSleep === 'boolean' ? patch.preventSleep : (current.preventSleep ?? false),
      coverSidebar: typeof patch.coverSidebar === 'boolean' ? patch.coverSidebar : (current.coverSidebar ?? false),
      sidebarShortcuts: sanitizeSidebarShortcuts('sidebarShortcuts' in patch ? patch.sidebarShortcuts : current.sidebarShortcuts),
      requirementsEnabled: typeof patch.requirementsEnabled === 'boolean' ? patch.requirementsEnabled : (current.requirementsEnabled ?? false),
      ...(feishu ? { feishu } : {}),
      ...(assistantFeishu ? { assistantFeishu } : {})
    }
    this.write(this.settingsFile, next)
    return next
  }

  metrics(): LifecycleMetrics {
    try {
      const raw = JSON.parse(readFileSync(this.metricsFile, 'utf8'))
      if (raw?.schemaVersion === 1 && Number.isFinite(raw.firstLaunchAt)) return raw
    } catch { /* initialize below */ }
    const initial: LifecycleMetrics = {
      schemaVersion: 1, firstLaunchAt: Date.now(), initializationAttempts: 0,
      initializationSuccesses: 0, updateFailures: {}
    }
    this.write(this.metricsFile, initial)
    return initial
  }

  updateMetrics(change: (metrics: LifecycleMetrics) => void): LifecycleMetrics {
    const metrics = this.metrics()
    change(metrics)
    this.write(this.metricsFile, metrics)
    return metrics
  }

  beginInitialization(targetAgentId: string): string {
    const id = randomUUID()
    const jobs = this.initializationJobs()
    jobs.push({ id, targetAgentId, state: 'pending', createdAt: Date.now() })
    this.write(this.initializationFile, jobs)
    this.updateMetrics((metrics) => { metrics.initializationAttempts += 1 })
    return id
  }

  attachInitialization(id: string, sessionId: string): void {
    this.write(this.initializationFile, this.initializationJobs().map((job) => job.id === id ? { ...job, sessionId } : job))
  }

  pendingInitialization(sessionId: string): { id: string; targetAgentId: string } | undefined {
    return this.initializationJobs().find((job) => job.sessionId === sessionId && job.state === 'pending')
  }

  pendingInitializations(): Array<{ id: string; targetAgentId: string; sessionId?: string }> {
    return this.initializationJobs().filter((job) => job.state === 'pending')
  }

  settleInitialization(id: string, success: boolean): boolean {
    let changed = false
    const jobs = this.initializationJobs().map((job) => {
      if (job.id !== id || job.state !== 'pending') return job
      changed = true
      return { ...job, state: success ? 'succeeded' : 'failed', settledAt: Date.now() }
    })
    if (!changed) return false
    this.write(this.initializationFile, jobs)
    if (success) this.updateMetrics((metrics) => { metrics.initializationSuccesses += 1 })
    return true
  }

  private initializationJobs(): Array<{ id: string; targetAgentId: string; state: string; createdAt: number; sessionId?: string; settledAt?: number }> {
    try { const value = JSON.parse(readFileSync(this.initializationFile, 'utf8')); return Array.isArray(value) ? value : [] }
    catch { return [] }
  }

  private write(file: string, value: unknown): void {
    try {
      if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
    } catch { /* settings are best effort */ }
  }
}
