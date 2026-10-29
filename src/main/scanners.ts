import { readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AutomationDetail, AutomationEditPatch, AutomationTask, SkillRef } from '../shared/types'
import { parseScheduleExpression } from '../shared/automationSchedule.ts'
import { applySkillPrecedence, discoverSkillRoot, type SkillDiscovery } from './capability-sync/skillDiscovery.ts'

/**
 * On-disk scanners for two "central inventory" features:
 *  - Skill / MCP inventory for isolated tests and compatibility views. Skills live as
 *    `<root>/<name>/SKILL.md` under each CLI's skills dir; MCP servers are
 *    declared in codex/traex `config.toml` under `[mcp_servers.<name>]`.
 *  - Scheduled automations (Doc4 需求4). Codex/TraeX store one cron job per
 *    `<automations>/<id>/automation.toml`.
 *
 * Everything is read straight from the same files the CLIs use, so the UI
 * reflects the real installed inventory — no separate registry to drift.
 */

const HOME = homedir()

const AUTOMATION_DIRS: { agentId: string; dir: string }[] = [
  { agentId: 'codex', dir: join(HOME, '.codex/automations') },
  { agentId: 'traex', dir: join(HOME, '.trae/cli/automations') }
]

export type DiscoveredSkillRef = SkillRef & {
  id?: string
  scope?: 'agent' | 'shared' | 'plugin'
  origin?: string
  source?: string
  plugin?: string
  version?: string
  status?: 'available' | 'invalid' | 'shadowed'
  issueCode?: string
  fingerprint?: string
}

/** Injectable-home variant used by inventory-grade tests and isolated callers. */
export async function listCandidatesAtHome(
  home: string,
  agentId?: string
): Promise<DiscoveredSkillRef[]> {
  const out: DiscoveredSkillRef[] = []
  const seen = new Set<string>()

  const agentRoots = agentId
    ? [{ agentId, dir: agentId === 'codex'
        ? join(home, '.codex/skills')
        : agentId === 'traex'
          ? join(home, '.trae/skills')
          : join(home, '.claude/skills') }]
    : [
        { agentId: 'codex', dir: join(home, '.codex/skills') },
        { agentId: 'traex', dir: join(home, '.trae/skills') },
        { agentId: 'claude', dir: join(home, '.claude/skills') }
      ]
  const local: SkillDiscovery[] = []
  for (const root of agentRoots) local.push(...await discoverSkillRoot(home, root.dir, 'agent'))
  const shared = await discoverSkillRoot(home, join(home, '.agents/skills'), 'shared')
  for (const found of applySkillPrecedence([local, shared])) {
    // The slash menu executes the selected path, so only the effective safe
    // winner is actionable. Inventory retains invalid/shadowed diagnostics.
    if (found.status !== 'available' || !found.manifest) continue
    const key = `skill:${found.name}`
    seen.add(key)
    out.push({
      kind: 'skill', name: found.name, path: found.manifest,
      description: found.description,
      id: found.identity, scope: found.scope, origin: found.scope,
      source: found.source, plugin: found.plugin, version: found.version, status: found.status,
      issueCode: found.issueCode, fingerprint: found.fingerprint
    })
  }

  const configs = [
    { agentId: 'codex', file: join(home, '.codex/config.toml') },
    { agentId: 'traex', file: join(home, '.trae/cli/config.toml') }
  ].filter((c) => !agentId || c.agentId === agentId)
  for (const cfg of configs) {
    if (!existsSync(cfg.file)) continue
    let text = ''
    try {
      text = await readFile(cfg.file, 'utf8')
    } catch {
      continue
    }
    for (const name of parseMcpServerNames(text)) {
      const key = `mcp:${name}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ kind: 'mcp', name, description: 'MCP Server' })
    }
  }

  // Group order: Skill → MCP; alphabetical within each group.
  const rank = (k: SkillRef['kind']): number => (k === 'skill' ? 0 : 1)
  out.sort((a, b) => {
    if (a.kind !== b.kind) return rank(a.kind) - rank(b.kind)
    return a.name.localeCompare(b.name)
  })
  return out
}

/** Extract `[mcp_servers.<name>]` table names from a config.toml. */
function parseMcpServerNames(toml: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  const re = /^\[mcp_servers\.([^.\]]+)\]/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(toml))) {
    const name = m[1].replace(/^"|"$/g, '')
    if (!seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  return names
}

/** All scheduled automations across codex/traex (Doc4 需求4). */
export async function listAutomations(): Promise<AutomationTask[]> {
  const out: AutomationTask[] = []
  for (const { agentId, dir } of AUTOMATION_DIRS) {
    if (!existsSync(dir)) continue
    let entries: string[] = []
    try {
      entries = await readdir(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      const tomlPath = join(dir, entry, 'automation.toml')
      const safePath = resolveAutomationPath(tomlPath)
      if (!safePath) continue
      let text = ''
      try {
        text = await readFile(safePath.path, 'utf8')
      } catch {
        continue
      }
      out.push(parseAutomation(agentId, tomlPath, text))
    }
  }
  return out
}

/** Minimal TOML field extraction for the flat automation.toml schema. */
function parseAutomation(agentId: string, path: string, toml: string): AutomationTask {
  const str = (key: string): string | undefined => {
    const m = toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'))
    return m ? m[1] : undefined
  }
  const rawStatus = (str('status') || '').toUpperCase()
  const status: AutomationTask['status'] =
    rawStatus === 'ACTIVE' || rawStatus === 'ENABLED' || rawStatus === 'RUNNING'
      ? 'active'
      : rawStatus === 'PAUSED' || rawStatus === 'DISABLED'
        ? 'paused'
        : 'unknown'
  return {
    id: `${agentId}:${str('id') || path}`,
    agentId,
    name: str('name') || str('id') || '(未命名任务)',
    prompt: str('prompt'),
    schedule: str('rrule') || str('cron'),
    status,
    model: str('model'),
    path,
    editable: true
  }
}

/** Extract the `cwds = ["a", "b"]` array from a flat automation.toml. */
function parseCwds(toml: string): string[] | undefined {
  const m = toml.match(/^cwds\s*=\s*\[([^\]]*)\]/m)
  if (!m) return undefined
  const items = [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1])
  return items.length ? items : undefined
}

/**
 * 需求1 — full detail of one local (codex/traex) automation, parsed from its
 * backing automation.toml. Returns null when the file can't be read.
 */
export async function getAutomationDetail(path: string): Promise<AutomationDetail | null> {
  const safePath = resolveAutomationPath(path)
  if (!safePath) return null
  let text = ''
  try {
    text = await readFile(safePath.path, 'utf8')
  } catch {
    return null
  }
  const agentId = safePath.root.agentId
  const base = parseAutomation(agentId, path, text)
  const str = (key: string): string | undefined => {
    const m = text.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'))
    return m ? m[1] : undefined
  }
  const num = (key: string): number | undefined => {
    const m = text.match(new RegExp(`^${key}\\s*=\\s*(\\d+)`, 'm'))
    return m ? Number(m[1]) : undefined
  }
  const rrule = str('rrule')
  const cron = str('cron')
  const cronFields = cron?.trim().split(/\s+/)
  const weekdayOnly = /BYDAY=MO,TU,WE,TH,FR/.test(rrule || '') ||
    ((cronFields?.length === 5 || cronFields?.length === 6) && cronFields.at(-1) === '1-5')
  const effort = str('reasoning_effort') as AutomationDetail['reasoningEffort'] | undefined
  const createdAt = num('created_at')
  const updatedAt = num('updated_at')
  return {
    ...base,
    reasoningEffort: effort,
    executionEnvironment: str('execution_environment'),
    cwds: parseCwds(text),
    createdAt: createdAt != null ? String(createdAt) : undefined,
    updatedAt: updatedAt != null ? String(updatedAt) : undefined,
    weekdayOnly,
    timezone: str('timezone')
  }
}

/** Resolve an existing path and prove its canonical location is under a known root. */
function resolveAutomationPath(path: string): {
  path: string
  root: (typeof AUTOMATION_DIRS)[number]
  rootPath: string
} | undefined {
  const lexicalPath = resolve(path)
  let canonicalPath = ''
  try {
    canonicalPath = realpathSync(lexicalPath)
  } catch {
    return undefined
  }
  for (const root of AUTOMATION_DIRS) {
    try {
      const lexicalRoot = resolve(root.dir)
      const fromLexicalRoot = relative(lexicalRoot, lexicalPath)
      if (fromLexicalRoot === '' || fromLexicalRoot === '..' ||
          fromLexicalRoot.startsWith(`..${sep}`) || isAbsolute(fromLexicalRoot)) continue
      const rootPath = realpathSync(lexicalRoot)
      const fromCanonicalRoot = relative(rootPath, canonicalPath)
      if (fromCanonicalRoot !== '' && fromCanonicalRoot !== '..' &&
          !fromCanonicalRoot.startsWith(`..${sep}`) && !isAbsolute(fromCanonicalRoot)) {
        return { path: canonicalPath, root, rootPath }
      }
    } catch {
      // A missing/inaccessible root cannot own an existing automation file.
    }
  }
  return undefined
}

function isWithinAutomationDirs(path: string): boolean {
  return resolveAutomationPath(path) != null
}

function setCronWeekdayOnly(cron: string, weekdayOnly: boolean): string | undefined {
  const fields = cron.trim().split(/\s+/)
  if ((fields.length !== 5 && fields.length !== 6) ||
      fields.some((field) => !/^[0-9A-Za-z*?,/#-]+$/.test(field))) {
    return undefined
  }
  fields[fields.length - 1] = weekdayOnly ? '1-5' : '*'
  return fields.join(' ')
}

/**
 * 需求1 — apply an edit patch to a local automation.toml via targeted
 * line-replace, preserving the rest of the CLI-owned file. Only the provided
 * fields are written. `weekdayOnly` rewrites RRULE BYDAY or a cron day-of-week
 * field. Bumps `updated_at`. Returns false when the file is invalid, missing, or
 * outside the roots.
 */
export async function updateAutomation(
  path: string,
  patch: AutomationEditPatch
): Promise<boolean> {
  if (patch.schedule != null && !parseScheduleExpression(patch.schedule).ok) return false
  const safePath = resolveAutomationPath(path)
  if (!safePath) return false
  let text = ''
  try {
    text = await readFile(safePath.path, 'utf8')
  } catch {
    return false
  }
  const esc = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const setStr = (key: string, value: string): void => {
    const line = `${key} = "${esc(value)}"`
    text = new RegExp(`^${key}\\s*=`, 'm').test(text)
      ? text.replace(new RegExp(`^${key}\\s*=.*$`, 'm'), line)
      : `${text.trimEnd()}\n${line}\n`
  }
  if (patch.name != null) setStr('name', patch.name)
  if (patch.prompt != null) setStr('prompt', patch.prompt)
  if (patch.model != null) setStr('model', patch.model)
  if (patch.reasoningEffort != null) setStr('reasoning_effort', patch.reasoningEffort)
  if (patch.schedule != null) {
    if (/^RRULE:FREQ=/i.test(patch.schedule.trim())) {
      text = text.replace(/^cron\s*=.*(?:\r?\n|$)/gm, '')
      setStr('rrule', patch.schedule)
    } else {
      // Unknown/raw schedules retain the file's existing key deliberately.
      if (/^cron\s*=/m.test(text) && !/^rrule\s*=/m.test(text)) setStr('cron', patch.schedule)
      else setStr('rrule', patch.schedule)
    }
  }
  if (patch.weekdayOnly != null) {
    const rruleLine = text.match(/^rrule\s*=\s*"([^"]*)"/m)
    if (rruleLine) {
      let rr = rruleLine[1]
      rr = rr.replace(/;?BYDAY=[^;"]*/g, '')
      if (patch.weekdayOnly) rr = `${rr};BYDAY=MO,TU,WE,TH,FR`
      setStr('rrule', rr)
    } else {
      const cronLine = text.match(/^cron\s*=\s*"([^"]*)"/m)
      const cron = cronLine && setCronWeekdayOnly(cronLine[1], patch.weekdayOnly)
      if (!cron) return false
      setStr('cron', cron)
    }
  }
  // Bump updated_at (numeric, unquoted in the file).
  text = /^updated_at\s*=/m.test(text)
    ? text.replace(/^updated_at\s*=.*$/m, `updated_at = ${Date.now()}`)
    : `${text.trimEnd()}\nupdated_at = ${Date.now()}\n`
  try {
    await writeFile(safePath.path, text, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 需求1 — delete a local automation. Removes the whole `<automations>/<id>/`
 * directory (the automation.toml plus any sibling state). Guarded to the known
 * automation roots so an arbitrary path can never be removed.
 */
export async function deleteAutomation(path: string): Promise<boolean> {
  const safePath = resolveAutomationPath(path)
  if (!safePath) return false
  const dir = dirname(resolve(path))
  // Never delete a top-level automations root itself.
  if (safePath.rootPath === dir) return false
  try {
    await rm(dir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Flip an automation's `status` field between ACTIVE and PAUSED in place
 * (Doc4 需求4 — 可启用/暂停). Rewrites only the status line to avoid disturbing
 * the rest of the CLI-owned file.
 */
export async function setAutomationStatus(
  path: string,
  status: 'active' | 'paused'
): Promise<boolean> {
  if (!isWithinAutomationDirs(path)) return false
  const safePath = resolveAutomationPath(path)
  if (!safePath) return false
  let text = ''
  try {
    text = await readFile(safePath.path, 'utf8')
  } catch {
    return false
  }
  const value = status === 'active' ? 'ACTIVE' : 'PAUSED'
  const next = /^status\s*=/m.test(text)
    ? text.replace(/^status\s*=.*$/m, `status = "${value}"`)
    : `${text.trimEnd()}\nstatus = "${value}"\n`
  try {
    await writeFile(safePath.path, next, 'utf8')
    return true
  } catch {
    return false
  }
}
