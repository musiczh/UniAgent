import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentDef, AgentPref, PrefsData } from '../shared/types'
import { resolveUserDataHome } from './userData.ts'

/**
 * Per-agent UI preferences (Doc5 T2). Persists the user's *last* model / effort
 * / permission choice per agent, plus the last-used agent, so the New Task panel
 * boots straight back to a concrete model instead of the ambiguous "CLI 默认"
 * empty value. Lives next to sessions.json.
 */
export class PrefsStore {
  private file: string
  private ready = false

  constructor(
    fileOverride?: string,
    private getAgent?: (agentId: string) => Pick<AgentDef, 'adapter'> | undefined
  ) {
    this.file = fileOverride || join(resolveUserDataHome(), 'prefs.json')
  }

  private ensureDir(): void {
    if (this.ready) return
    try {
      mkdirSync(join(this.file, '..'), { recursive: true })
    } catch {
      /* ignore */
    }
    this.ready = true
  }

  get(): PrefsData {
    const data = this.read()
    if (this.migrateLegacyPlanPrefs(data)) this.write(data)
    return data
  }

  private read(): PrefsData {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8'))
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          const rawLastByAgent = raw.lastByAgent && typeof raw.lastByAgent === 'object' && !Array.isArray(raw.lastByAgent)
            ? raw.lastByAgent
            : {}
          const lastByAgent = Object.fromEntries(
            Object.entries(rawLastByAgent).filter(([, pref]) => (
              pref !== null && typeof pref === 'object' && !Array.isArray(pref)
            ))
          ) as Record<string, AgentPref>
          return {
            lastByAgent,
            ...(typeof raw.lastAgentId === 'string' ? { lastAgentId: raw.lastAgentId } : {})
          }
        }
      }
    } catch {
      /* fall through */
    }
    return { lastByAgent: {} }
  }

  /** Merge per-agent values; explicit defaults alone must not change the last-used agent. */
  set(agentId: string, pref: AgentPref): PrefsData {
    const data = this.read()
    this.migrateLegacyPlanPrefs(data)
    data.lastByAgent[agentId] = { ...data.lastByAgent[agentId], ...pref }
    this.migrateLegacyPlanPref(agentId, data.lastByAgent[agentId])
    if (Object.keys(pref).some((key) => key !== 'defaultModel' && key !== 'defaultEffort' && key !== 'defaultThinking')) {
      data.lastAgentId = agentId
    }
    this.write(data)
    return data
  }

  private migrateLegacyPlanPrefs(data: PrefsData): boolean {
    let changed = false
    for (const [agentId, pref] of Object.entries(data.lastByAgent)) {
      if (this.migrateLegacyPlanPref(agentId, pref)) changed = true
    }
    return changed
  }

  private migrateLegacyPlanPref(agentId: string, pref: AgentPref): boolean {
    const adapter = this.getAgent?.(agentId)?.adapter
    if ((adapter !== 'codex' && adapter !== 'traex') || pref.permissionMode !== 'plan') {
      return false
    }
    pref.permissionMode = 'read-only'
    pref.collaborationMode = 'plan'
    return true
  }

  private write(data: PrefsData): void {
    this.ensureDir()
    writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf8')
  }
}
