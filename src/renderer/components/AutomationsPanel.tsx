import { useEffect, useRef, useState } from 'react'
import { resolveAgentModel, resolveAgentPermission, resolveModelEffort } from '@shared/agentChoices'
import { useAgentPreferences } from '../hooks'
import type { CSSProperties } from 'react'
import type { AgentDef, AutomationDetail, AutomationEditPatch, AutomationTask, NativeAutomationInput, PermissionMode, Project, ReasoningEffort } from '@shared/types'
import { nextScheduleRuns, parseScheduleExpression, type ParsedSchedule, type ScheduleDay, type ScheduleFrequency } from '@shared/automationSchedule'
import { AutomationMutationController } from '../automationControllers'
import { AgentIcon } from './AgentIcon'
import { Chevron, ClockIcon, UiIcon } from './Icons'

// Fix#3 — module-level cache so re-opening the panel shows the last-known list
// instantly instead of a blank "加载中…"; a fresh scan runs in the background and
// only re-renders when the result actually differs (JSON compare).
let cachedAutomations: AutomationTask[] | null = null

export class AutomationDetailRequestController {
  private generation = 0

  invalidate(): void {
    this.generation += 1
  }

  async run<T>(
    request: () => Promise<T>,
    commit: (value: T) => void,
    settle: () => void,
    reject: () => void = () => {}
  ): Promise<void> {
    const generation = ++this.generation
    try {
      const value = await request()
      if (generation === this.generation) commit(value)
    } catch {
      if (generation === this.generation) reject()
    } finally {
      if (generation === this.generation) settle()
    }
  }
}

export { nextScheduleRuns, parseScheduleExpression, type ParsedSchedule, type ScheduleDay, type ScheduleFrequency }

const SCHEDULE_DAYS: ScheduleDay[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
const DAY_NAMES = ['一', '二', '三', '四', '五', '六', '日']
const WORKDAYS: ScheduleDay[] = ['MO', 'TU', 'WE', 'TH', 'FR']
const CRON_DAY: Record<ScheduleDay, string> = { MO: '1', TU: '2', WE: '3', TH: '4', FR: '5', SA: '6', SU: '0' }

/** Build the canonical expression after a visual control changes. */
export function buildScheduleExpression(schedule: ParsedSchedule): string {
  if (schedule.freq === 'custom') return schedule.raw
  if (schedule.cronMode) {
    const dom = schedule.freq === 'monthly'
      ? [...schedule.monthDays].sort((a, b) => a - b).join(',') || '1'
      : '*'
    let dow = '*'
    if (schedule.freq === 'weekly') {
      dow = WORKDAYS.every((day) => schedule.days.has(day)) && schedule.days.size === WORKDAYS.length
        ? '1-5'
        : SCHEDULE_DAYS.filter((day) => schedule.days.has(day)).map((day) => CRON_DAY[day]).join(',') || '1-5'
    }
    const body = `${schedule.minute} ${schedule.hour} ${dom} * ${dow}`
    return schedule.cronFields === 5 ? body : `${schedule.second} ${body}`
  }
  if (schedule.freq === 'daily') return `RRULE:FREQ=DAILY;BYHOUR=${schedule.hour};BYMINUTE=${schedule.minute}`
  if (schedule.freq === 'weekly') {
    const days = SCHEDULE_DAYS.filter((day) => schedule.days.has(day)).join(',') || WORKDAYS.join(',')
    return `RRULE:FREQ=WEEKLY;BYHOUR=${schedule.hour};BYMINUTE=${schedule.minute};BYDAY=${days}`
  }
  const monthDays = [...schedule.monthDays].sort((a, b) => a - b).join(',') || '1'
  return `RRULE:FREQ=MONTHLY;BYHOUR=${schedule.hour};BYMINUTE=${schedule.minute};BYMONTHDAY=${monthDays}`
}

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Human-readable cadence for a parsed schedule, e.g. "每周一至周五 09:00" (补3: never show cron/RRULE). */
export function describeCadence(schedule: ParsedSchedule): string {
  const time = `${pad2(schedule.hour)}:${pad2(schedule.minute)}`
  if (schedule.freq === 'daily') return `每天 ${time}`
  if (schedule.freq === 'weekly') {
    const workdaysOnly = WORKDAYS.every((day) => schedule.days.has(day)) && schedule.days.size === WORKDAYS.length
    if (workdaysOnly) return `每周一至周五 ${time}`
    const labels = SCHEDULE_DAYS.filter((day) => schedule.days.has(day)).map((day) => `周${DAY_NAMES[SCHEDULE_DAYS.indexOf(day)]}`)
    return labels.length ? `每${labels.join('、')} ${time}` : `每周 ${time}`
  }
  if (schedule.freq === 'monthly') {
    const days = [...schedule.monthDays].sort((a, b) => a - b).map((day) => `${day} 号`).join('、')
    return `每月 ${days || '1 号'} ${time}`
  }
  return ''
}

/** Concrete next local run, formatted "YYYY-MM-DD 周X HH:mm" (null when uncomputable). */
export function describeNextRun(schedule: ParsedSchedule, from = new Date()): string | null {
  const [next] = nextScheduleRuns(schedule, 1, from)
  if (!next) return null
  return `${next.getFullYear()}-${pad2(next.getMonth() + 1)}-${pad2(next.getDate())} ${WEEKDAY_NAMES[next.getDay()]} ${pad2(next.getHours())}:${pad2(next.getMinutes())}`
}

/**
 * 补3 — Turn any backing schedule string into a human-readable summary. Strips
 * the readable " · 仅工作日" suffix, parses the cron/RRULE core, and returns
 * both cadence and the next concrete run. Non-cron strings (one-off datetimes
 * such as "2026-08-24 21:16 · Asia/Shanghai") pass through unchanged; genuinely
 * opaque expressions collapse to "自定义调度" so raw cron never surfaces.
 */
export function describeSchedule(raw: string | undefined, from = new Date()): { cadence: string; nextRun: string | null } {
  const value = (raw ?? '').trim()
  if (!value) return { cadence: '', nextRun: null }
  const core = value.split(/\s+·\s+/)[0].trim()
  const parsed = parseScheduleExpression(core)
  if (parsed.ok) return { cadence: describeCadence(parsed), nextRun: describeNextRun(parsed, from) }
  if (/\*|RRULE:|FREQ=/i.test(value)) return { cadence: '自定义调度', nextRun: null }
  return { cadence: value, nextRun: null }
}

function chipStyle(selected: boolean): CSSProperties {
  return {
    minWidth: 34,
    padding: '5px 9px',
    color: selected ? 'var(--blue)' : 'var(--text-dim)',
    borderColor: selected ? 'var(--blue)' : 'var(--border)',
    background: selected ? 'rgba(91, 157, 255, 0.14)' : 'var(--bg-elev2)'
  }
}

/**
 * Scheduled-automation panel (Doc4 需求4). 需求13: rendered INLINE in the main
 * chat area (codex-style), not a floating drawer. Centrally lists cron/automation
 * tasks discovered on disk across codex/traex, and lets the user flip each
 * between active and paused (rewrites the backing `automation.toml` status).
 *
 * Native UniAgent tasks share the list and editor with discovered CLI tasks.
 */
export function AutomationsPanel({ onOpenSession, embedded = false }: { onOpenSession?: (id: string) => void; embedded?: boolean }): JSX.Element {
  const [items, setItems] = useState<AutomationTask[]>(cachedAutomations ?? [])
  const [agentFilter, setAgentFilter] = useState('all')
  const [agents, setAgents] = useState<AgentDef[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [creating, setCreating] = useState(false)
  // Only show the blocking spinner on the very first scan (no cache yet).
  const [loading, setLoading] = useState(cachedAutomations === null)
  // 需求1 — list/detail routing. `selected` holds the row being viewed; `detail`
  // is its lazily-loaded full field set (null while loading).
  const [selected, setSelected] = useState<AutomationTask | null>(null)
  const [detail, setDetail] = useState<AutomationDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [detailDirty, setDetailDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const mutation = useRef(new AutomationMutationController())
  const detailRequest = useRef(new AutomationDetailRequestController())
  const listRequest = useRef(new AutomationDetailRequestController())
  const [listError, setListError] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function reload(): void {
    if (cachedAutomations === null) setLoading(true)
    setListError(false)
    void listRequest.current.run(
      () => window.uniagent.listAutomations(),
      (next) => {
        cachedAutomations = next
        setItems(next)
        setSelected(current => current ? next.find(item => item.id === current.id) ?? current : null)
        setDetail(current => current?.source === 'uniagent'
          ? (next.find(item => item.id === current.id) as AutomationDetail | undefined) ?? current : current)
      },
      () => setLoading(false),
      () => setListError(true)
    )
  }
  useEffect(() => {
    reload()
    const off = window.uniagent.onAutomationsChanged(reload)
    return () => { off(); listRequest.current.invalidate() }
  }, [])
  useEffect(() => {
    const load = (): void => {
      void window.uniagent.listAgents().then(setAgents).catch(() => setAgents([]))
      void window.uniagent.listProjects().then(setProjects).catch(() => setProjects([]))
    }
    load()
    return window.uniagent.onLifecycleProgress(load)
  }, [])
  useEffect(() => () => detailRequest.current.invalidate(), [])

  function canToggle(t: AutomationTask): boolean {
    return automationCanToggle(t)
  }

  function canEdit(t: AutomationTask): boolean {
    return automationCanEdit(t)
  }
  function canDelete(t: AutomationTask): boolean {
    return automationCanDelete(t)
  }

  async function openDetail(t: AutomationTask): Promise<void> {
    setSelected(t)
    setDetail(null)
    setError(null)
    setConfirmDelete(false)
    setDetailDirty(false)
    setDetailLoading(true)
    await detailRequest.current.run(
      () => window.uniagent.getAutomationDetail(t),
      setDetail,
      () => setDetailLoading(false),
      () => setDetail(null)
    )
  }

  function backToList(force = false): void {
    if (!force && detailDirty && !window.confirm('有未保存的修改，确定放弃并返回吗？')) return
    detailRequest.current.invalidate()
    setSelected(null)
    setCreating(false)
    setDetail(null)
    setConfirmDelete(false)
    setDetailDirty(false)
    setError(null)
  }

  async function toggle(t: AutomationTask): Promise<void> {
    if (!canToggle(t)) return
    await mutation.current.run(async () => {
      setBusy(true)
      setError(null)
      const next: 'active' | 'paused' = t.status === 'active' ? 'paused' : 'active'
      // Optimistic flip (also mirrored into the cache); roll back if the write fails.
      const apply = (status: AutomationTask['status']): void => {
        setItems((prev) => {
          const updated = prev.map((x) => (x.id === t.id ? { ...x, status } : x))
          cachedAutomations = updated
          return updated
        })
        // Keep the open detail row in sync.
        setSelected((prev) => (prev && prev.id === t.id ? { ...prev, status } : prev))
        setDetail((prev) => (prev && prev.id === t.id ? { ...prev, status } : prev))
      }
      apply(next)
      try {
        let ok = false
        if (t.path || t.source === 'uniagent') {
          ok = await window.uniagent.setAutomationStatus(t.source === 'uniagent' ? t : t.path!, next)
        }
        if (!ok) {
          apply(t.status)
          setError('启停失败（磁盘写入被拒绝或不支持）')
        }
      } catch (cause) {
        apply(t.status)
        setError(cause instanceof Error ? cause.message : '启停失败')
      } finally {
        setBusy(false)
      }
    })
  }

  async function saveEdit(patch: AutomationEditPatch): Promise<boolean> {
    if (!selected) return false
    return (await mutation.current.run(async () => {
      setBusy(true)
      setError(null)
      try {
        const ok = await window.uniagent.updateAutomation(selected, patch)
        if (!ok) {
          setError('保存失败（磁盘写入被拒绝或不支持）')
          return false
        }
        if (selected.source === 'uniagent') {
          const updated = await window.uniagent.getAutomationDetail(selected)
          if (updated) { setSelected(updated); setDetail(updated) }
          reload()
          return true
        }
        // Merge the patch into both the list row and the open detail.
        const mergeRow = (x: AutomationTask): AutomationTask => ({
          ...x,
          name: patch.name ?? x.name,
          prompt: patch.prompt ?? x.prompt,
          schedule: patch.schedule ?? x.schedule,
          model: patch.model ?? x.model
        })
        setItems((prev) => {
          const updated = prev.map((x) => (x.id === selected.id ? mergeRow(x) : x))
          cachedAutomations = updated
          return updated
        })
        setSelected((prev) => (prev ? mergeRow(prev) : prev))
        setDetail((prev) =>
          prev
            ? {
                ...prev,
                name: patch.name ?? prev.name,
                prompt: patch.prompt ?? prev.prompt,
                schedule: patch.schedule ?? prev.schedule,
                model: patch.model ?? prev.model,
                reasoningEffort: patch.reasoningEffort ?? prev.reasoningEffort,
                weekdayOnly: patch.weekdayOnly ?? prev.weekdayOnly
              }
            : prev
        )
        return true
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '保存失败')
        return false
      } finally {
        setBusy(false)
      }
    })) ?? false
  }

  async function createTask(input: NativeAutomationInput): Promise<boolean> {
    return (await mutation.current.run(async () => {
      setBusy(true)
      setError(null)
      try {
        await window.uniagent.createAutomation(input)
        setAgentFilter('all')
        backToList(true)
        reload()
        return true
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '创建失败')
        return false
      } finally { setBusy(false) }
    })) ?? false
  }

  async function doDelete(): Promise<void> {
    if (!selected) return
    await mutation.current.run(async () => {
      setBusy(true)
      setError(null)
      try {
        const ok = await window.uniagent.deleteAutomation(selected)
        if (!ok) {
          setError('删除失败（该任务不支持删除或写入被拒绝）')
          return
        }
        const id = selected.id
        setItems((prev) => {
          const updated = prev.filter((x) => x.id !== id)
          cachedAutomations = updated
          return updated
        })
        backToList(true)
      } catch {
        setError('删除失败')
      } finally {
        setBusy(false)
      }
    })
  }

  const agentCounts = new Map<string, number>()
  for (const task of items) agentCounts.set(task.agentId, (agentCounts.get(task.agentId) ?? 0) + 1)
  const visibleItems = agentFilter === 'all' ? items : items.filter((task) => task.agentId === agentFilter)

  // ===== Detail page =====
  if (selected || creating) {
    const availableAgent = agents.find(agent => agent.lifecycle?.availability === 'available' && !agent.incompatible)
    const t: AutomationTask = selected ?? {
      id: 'new', source: 'uniagent', agentId: availableAgent?.id ?? '', name: '', prompt: '',
      schedule: 'RRULE:FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0;BYDAY=MO,TU,WE,TH,FR', status: 'active'
    }
    return (
      <div className={embedded ? 'automations-panel automations-embedded' : 'main-panel automations-panel'}>
        <div className="main-panel-head auto-detail-head">
          <button className="auto-back" disabled={busy} onClick={() => backToList()}>
            <UiIcon name="back" size={16} /> 返回
          </button>
          <span className="main-panel-title">{creating ? '新建定时任务' : '任务详情'}</span>
        </div>
        <div className="subagent-detailpage auto-detail">

          {error && <div className="auto-detail-error">{error}</div>}
          {detailLoading ? (
            <div className="panel-loading auto-detail-loading"><span className="loading-spinner" /></div>
          ) : (
            <AutomationEditor
              key={t.id}
              task={t}
              detail={detail}
              busy={busy}
              editable={creating || canEdit(t)}
              deletable={!creating && canDelete(t)}
              toggleable={!creating && canToggle(t)}
              onSave={saveEdit}
              onDelete={() => setConfirmDelete(true)}
              onToggle={() => toggle(t)}
              onDirtyChange={setDetailDirty}
              agents={agents}
              projects={projects}
              creating={creating}
              onCreate={createTask}
              onCancel={() => backToList()}
              onOpenSession={onOpenSession}
            />
          )}
        </div>

        {confirmDelete && (
          <div className="settings-modal-overlay" onClick={() => !busy && setConfirmDelete(false)}>
            <div className="settings-modal auto-confirm" onClick={(e) => e.stopPropagation()}>
              <div className="settings-modal-head">
                <span className="settings-modal-title">删除定时任务</span>
              </div>
              <div className="settings-modal-body">
                <div className="settings-hint-line">
                  {t.source === 'uniagent'
                    ? `确定删除「${t.name}」？之后不再调度，已有执行会话仍保留。`
                    : `确定删除「${t.name}」？此操作将删除本机配置目录（automation.toml 及同级状态），不可恢复。`}
                </div>
              </div>
              <div className="settings-modal-foot">
                <button className="settings-btn ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>
                  取消
                </button>
                <button className="settings-btn primary auto-del-confirm" disabled={busy} onClick={doDelete}>
                  {busy ? '删除中…' : '确认删除'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ===== List page =====
  return (
    <div className={embedded ? 'automations-panel automations-embedded' : 'main-panel automations-panel'}>
      <div className="main-panel-head">
        <span className="main-panel-title">定时任务</span>
        <button className="settings-btn primary" disabled={loading || busy || !agents.some(agent => agent.lifecycle?.availability === 'available')} onClick={() => {
          setCreating(true); setError(null); setDetailDirty(false)
        }}>＋ 新建任务</button>
      </div>
      {error && <div className="auto-detail-error">{error}</div>}
      <div className="auto-agent-tabs" role="tablist" aria-label="按 Agent 筛选定时任务" style={{ display: 'flex', flexWrap: 'wrap', gap: 7, padding: '0 16px 10px' }}>
        <button
          role="tab"
          className={`settings-btn ghost auto-agent-tab${agentFilter === 'all' ? ' active' : ''}`}
          style={chipStyle(agentFilter === 'all')}
          aria-pressed={agentFilter === 'all'}
          aria-selected={agentFilter === 'all'}
          onClick={() => setAgentFilter('all')}
        >
          全部 <span className="auto-agent-count">{items.length}</span>
        </button>
        {[...agentCounts].map(([agentId, count]) => (
          <button
            key={agentId}
            role="tab"
            className={`settings-btn ghost auto-agent-tab${agentFilter === agentId ? ' active' : ''}`}
            style={chipStyle(agentFilter === agentId)}
            data-agent-id={agentId}
            aria-pressed={agentFilter === agentId}
            aria-selected={agentFilter === agentId}
            onClick={() => setAgentFilter(agentId)}
          >
            {agents.find((agent) => agent.id === agentId)?.name ?? agentId} <span className="auto-agent-count">{count}</span>
          </button>
        ))}
      </div>
      <div className="drawer-list auto-list">
        {loading ? (
          <div className="panel-loading auto-loading"><span className="loading-spinner" /></div>
        ) : listError && items.length === 0 ? (
          <div className="drawer-empty">定时任务加载失败，请稍后重试</div>
        ) : items.length === 0 ? (
          <div className="drawer-empty">暂无定时任务，点击「新建任务」设置执行 Agent 和时间</div>
        ) : visibleItems.length === 0 ? (
          <div className="drawer-empty">该 Agent 暂无定时任务</div>
        ) : (
          visibleItems.map((t) => (
            <div key={t.id} className="drawer-item auto-item auto-item-clickable" onClick={() => openDetail(t)}>
              <span className="drawer-item-icon">
                <AgentIcon agentId={t.agentId} size={15} />
              </span>
              <div className="drawer-item-main auto-main">
                <div className="auto-name">
                  {t.name}
                  <span className={`auto-badge auto-${t.status}`}>
                    {t.status === 'active' ? (t.source === 'uniagent' ? '已启用' : '运行中') : t.status === 'paused' ? '已暂停' : '未知'}
                  </span>
                  {t.source === 'uniagent' && <span className="auto-badge auto-source">UniAgent</span>}
                </div>
                {t.schedule && (() => {
                  const schedule = describeSchedule(t.schedule)
                  const cadence = schedule.cadence
                  const nextRun = t.source === 'uniagent'
                    ? t.status === 'active' && t.nextRunAt ? formatRunDate(t.nextRunAt) : null
                    : schedule.nextRun
                  return (
                    <div className="auto-sched">
                      {cadence && <span className="auto-sched-cadence">{cadence}</span>}
                      {nextRun && <span className="auto-sched-next">下次执行 · {nextRun}</span>}
                    </div>
                  )
                })()}
                {t.prompt && <div className="auto-prompt">{t.prompt.slice(0, 120)}</div>}
              </div>
              <button
                className="auto-toggle"
                disabled={busy || !canToggle(t)}
                onClick={(e) => {
                  e.stopPropagation()
                  toggle(t)
                }}
              >
                {t.status === 'active' ? '暂停' : t.status === 'paused' ? '启用' : '—'}
              </button>
              <span className="auto-chev"><Chevron size={14} /></span>
            </div>
          ))
        )}
      </div>
      <div className="drawer-foot">
        共 {items.length} 个任务 · 点击查看详情 / 管理
      </div>
    </div>
  )
}
interface EditorValues {
  name: string
  prompt: string
  schedule: string
  model: string
  effort: ReasoningEffort | ''
  agentId: string
  projectId: string
  permissionMode: PermissionMode | ''
}

function formatRunDate(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${WEEKDAY_NAMES[date.getDay()]} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

export function scheduleForTask(raw: string): ParsedSchedule {
  return { ...parseScheduleExpression(raw), cronMode: false, raw }
}

export function scheduleForSave(schedule: ParsedSchedule): string | null {
  return schedule.ok ? buildScheduleExpression(schedule) : null
}

export function automationCanToggle(task: AutomationTask): boolean {
  return task.status !== 'unknown' && automationCanEdit(task)
}

export function automationCanEdit(task: AutomationTask): boolean {
  return task.source === 'uniagent' || !!task.path
}

export function automationCanDelete(task: AutomationTask): boolean {
  return automationCanEdit(task)
}

function AutomationEditor({
  task, detail, busy, editable, deletable, toggleable, onSave, onDelete, onToggle,
  onDirtyChange, agents, projects, creating, onCreate, onCancel, onOpenSession
}: {
  task: AutomationTask
  detail: AutomationDetail | null
  busy: boolean
  editable: boolean
  deletable: boolean
  toggleable: boolean
  onSave: (patch: AutomationEditPatch) => Promise<boolean>
  onDelete: () => void
  onToggle: () => void
  onDirtyChange: (dirty: boolean) => void
  agents: AgentDef[]
  projects: Project[]
  creating: boolean
  onCreate: (input: NativeAutomationInput) => Promise<boolean>
  onCancel: () => void
  onOpenSession?: (id: string) => void
}): JSX.Element {
  const prefs = useAgentPreferences()
  const native = task.source === 'uniagent'
  const first: EditorValues = {
    name: task.name, prompt: task.prompt ?? '', schedule: task.schedule ?? '', model: task.model ?? '',
    effort: detail?.reasoningEffort ?? '', agentId: task.agentId,
    projectId: detail?.projectId ?? projects.find(project => project.isDefault)?.id ?? '',
    permissionMode: detail?.permissionMode ?? agents.find(agent => agent.id === task.agentId)?.capabilities.permissionModes[0]?.id ?? ''
  }
  const [saved, setSaved] = useState(first)
  const [values, setValues] = useState(first)
  const [schedule, setSchedule] = useState(() => scheduleForTask(first.schedule))
  const agent = agents.find(agent => agent.id === values.agentId)
  const models = agent?.capabilities.modelSelect ? agent.models : []
  const pref = prefs?.lastByAgent[values.agentId]
  const model = resolveAgentModel(agent, values.model, pref?.defaultModel)
  const modes = agent?.capabilities.permissionModes ?? []
  const efforts = agent?.capabilities.reasoningEffort ? model?.efforts || [] : []
  const effort = efforts.length ? resolveModelEffort(model, values.effort, pref?.defaultEffort) : undefined
  const permissionMode = resolveAgentPermission(agent, values.permissionMode)
  const dirty = JSON.stringify({ ...values, schedule: schedule.raw }) !== JSON.stringify(saved)
  const available = agent?.lifecycle?.availability === 'available' && !agent.incompatible
  const valid = !!prefs && values.name.trim() && schedule.ok &&
    (!native || (values.prompt.trim() && available && projects.some(project => project.id === values.projectId) &&
      !!permissionMode && (!agent?.capabilities.modelSelect || !!model)))
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])

  function change(patch: Partial<EditorValues>): void { setValues(current => ({ ...current, ...patch })) }
  function changeAgent(agentId: string): void {
    const next = agents.find(agent => agent.id === agentId)
    change({ agentId, model: '', effort: '', permissionMode: next?.capabilities.permissionModes[0]?.id ?? '' })
  }
  async function submit(): Promise<void> {
    if (!valid) return
    const normalized = scheduleForSave(schedule)
    if (!normalized) return
    const next: EditorValues = { ...values, name: values.name.trim(), prompt: values.prompt.trim(), schedule: normalized,
      model: model?.id || '', effort: effort || '', permissionMode: permissionMode || '' }
    if (creating) {
      await onCreate({ ...next, permissionMode: next.permissionMode as PermissionMode, reasoningEffort: next.effort || undefined })
      return
    }
    const patch: AutomationEditPatch = {}
    if (next.name !== saved.name) patch.name = next.name
    if (next.prompt !== saved.prompt) patch.prompt = next.prompt
    if (next.schedule !== saved.schedule) patch.schedule = next.schedule
    if (next.model !== saved.model) patch.model = next.model
    if (next.effort !== saved.effort) patch.reasoningEffort = next.effort || undefined
    if (native) {
      if (next.agentId !== saved.agentId) patch.agentId = next.agentId
      if (next.projectId !== saved.projectId) patch.projectId = next.projectId
      if (next.permissionMode !== saved.permissionMode) patch.permissionMode = next.permissionMode as PermissionMode
    }
    if (await onSave(patch)) {
      setValues(next); setSaved(next); setSchedule(scheduleForTask(normalized))
    }
  }
  const lastRunLabels = { success: '最近执行成功', error: '最近执行失败', running: '正在执行', 'awaiting-approval': '等待授权', unknown: '执行状态未知' }
  return (
    <div className="auto-config auto-inline-editor">
      <div className="auto-config-scroll">
        <div className="auto-config-intro">
          <div className="auto-config-summary">
            <h2>{creating ? '让 Agent 按计划为你工作' : task.name}</h2>
            <div className="auto-config-hint">
              {creating ? '指定执行 Agent 和时间，结果会保存在独立会话中。' :
                `${agents.find(agent => agent.id === task.agentId)?.name ?? task.agentId} · ${native ? 'UniAgent 原生任务' : 'Agent 本机任务'}`}
            </div>
            {native && detail?.lastRunStatus && (
              <div className={`auto-run-summary auto-run-${detail.lastRunStatus}`}>
                <span>{lastRunLabels[detail.lastRunStatus]}</span>
                {detail.lastRunAt && <span className="auto-config-hint">{formatRunDate(detail.lastRunAt)}</span>}
                {detail.lastSessionId && onOpenSession && <button type="button" className="auto-run-link" disabled={busy || dirty} title={dirty ? '请先保存或放弃修改' : undefined} onClick={() => onOpenSession(detail.lastSessionId!)}>查看执行会话 ↗</button>}
              </div>
            )}
            {native && detail?.lastRunError && <div className="auto-run-error">{detail.lastRunError}</div>}
          </div>
          {creating ? <span className="auto-badge auto-source">UniAgent 原生</span> : (
            <button className="auto-config-status auto-status-btn" role="switch" aria-checked={task.status === 'active'} disabled={busy || !toggleable} onClick={onToggle}>
              <span className={`auto-config-switch${task.status === 'active' ? ' on' : ''}`} />
              {task.status === 'active' ? '已启用' : task.status === 'paused' ? '已暂停' : '状态未知'}
            </button>
          )}
        </div>
        {!editable && <div className="auto-config-hint">该任务没有可编辑的本机配置，目前仅供查看。</div>}
        <section className="auto-config-section">
          <span className="auto-config-label">任务内容</span>
          <div className="auto-config-fields">
            <div className="settings-fld"><label>任务名称</label>
              <input aria-label="任务名称" className="settings-inp auto-name-input" disabled={!editable || busy} value={values.name} onChange={event => change({ name: event.target.value })} />
            </div>
            <div className="settings-fld"><label>指令 / 提示词</label>
              <textarea aria-label="指令 / 提示词" className="settings-inp settings-textarea auto-prompt-input" disabled={!editable || busy} value={values.prompt} placeholder="描述你希望 Agent 定时完成的任务" onChange={event => change({ prompt: event.target.value })} />
            </div>
          </div>
        </section>
        <section className="auto-config-section">
          <span className="auto-config-label">执行配置</span>
          <div className="auto-config-fields">
            <div className="settings-fld-row">
              <div className="settings-fld"><label>执行 Agent</label>
                {native ? <select aria-label="执行 Agent" className="settings-select" value={values.agentId} disabled={busy || !editable} onChange={event => changeAgent(event.target.value)}>
                  {!agents.some(agent => agent.id === values.agentId) && <option value={values.agentId}>{values.agentId || '请选择 Agent'}（不可用）</option>}
                  {agents.map(agent => <option key={agent.id} value={agent.id} disabled={agent.lifecycle?.availability !== 'available' || agent.incompatible}>{agent.name}{agent.lifecycle?.availability !== 'available' || agent.incompatible ? '（未就绪）' : ''}</option>)}
                </select> : <div className="auto-config-readonly">{agent?.name ?? task.agentId}</div>}
              </div>
              <div className="settings-fld"><label>{native ? '空间' : '工作目录'}</label>
                {native ? <select aria-label="空间" className="settings-select" value={values.projectId} disabled={busy || !editable} onChange={event => change({ projectId: event.target.value })}>
                  {!projects.some(project => project.id === values.projectId) && <option value={values.projectId}>请选择有效空间</option>}
                  {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select> : <div className="auto-config-readonly">{detail?.cwds?.join('、') || '由 Agent 配置决定'}</div>}
              </div>
            </div>
            <div className="settings-fld-row">
              <div className="settings-fld"><label>模型</label>
                <select aria-label="模型" className="settings-select auto-model-select" disabled={!editable || busy || !models.length} value={model?.id || ''} onChange={event => change({ model: event.target.value, effort: '' })}>
                  {models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
                </select>
              </div>
              {native && <div className="settings-fld"><label>权限模式</label>
                <select aria-label="权限模式" className="settings-select" disabled={!editable || busy || !modes.length} value={permissionMode || ''} onChange={event => change({ permissionMode: event.target.value as PermissionMode })}>
                  {modes.map(mode => <option key={mode.id} value={mode.id} title={mode.hint}>{mode.label}</option>)}
                </select>
              </div>}
              {efforts.length > 0 && <div className="settings-fld"><label>推理强度</label>
                <select aria-label="推理强度" className="settings-select" disabled={!editable || busy} value={effort || ''} onChange={event => change({ effort: event.target.value as ReasoningEffort })}>
                  {efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
                </select>
              </div>}
            </div>
            {native && <div className="auto-config-hint">{!available ? '所选 Agent 当前未就绪，请重新选择或等待检测完成。' : '需要授权时，任务会等待你在执行会话中处理。模型与权限跟随 Agent 的实际能力。'}</div>}
          </div>
        </section>
        <section className="auto-config-section">
          <span className="auto-config-label">执行计划</span>
          <ScheduleBuilder value={schedule} disabled={!editable || busy} onChange={setSchedule} />
        </section>
        {native && <div className="auto-config-runtime">按本机时区执行，需要 UniAgent 运行。关闭或休眠后恢复时，错过的执行补跑一次；同一任务不重叠。</div>}
      </div>
      <div className="auto-config-savebar">
        {creating ? <span className="auto-config-hint">每次执行创建一个独立会话</span> :
          <button className="settings-btn ghost auto-del-btn" disabled={busy || !deletable} onClick={onDelete}>删除任务</button>}
        <div className="auto-config-actions">
          {!creating && <span className={`auto-dirty${dirty ? ' changed' : ''}`}>{editable ? dirty ? '● 有未保存的修改' : '已保存' : '只读'}</span>}
          <button className="settings-btn ghost auto-discard" disabled={busy || (!creating && !dirty)} onClick={() => {
            if (creating) onCancel()
            else { setValues(saved); setSchedule(scheduleForTask(saved.schedule)) }
          }}>{creating ? '取消' : '放弃修改'}</button>
          {editable && <button className="settings-btn primary auto-save" disabled={busy || !valid || (!creating && !dirty)} onClick={submit}>{busy ? '保存中…' : creating ? '创建并启用' : '保存修改'}</button>}
        </div>
      </div>
    </div>
  )
}

function ScheduleBuilder({
  value,
  disabled,
  onChange
}: {
  value: ParsedSchedule
  disabled: boolean
  onChange: (value: ParsedSchedule) => void
}): JSX.Element {
  const timeValue = `${String(value.hour).padStart(2, '0')}:${String(value.minute).padStart(2, '0')}`

  function commitVisual(next: ParsedSchedule): void {
    const ready = { ...next, ok: true }
    if (ready.freq === 'weekly' && ready.days.size === 0) ready.days = new Set(WORKDAYS)
    if (ready.freq === 'monthly' && ready.monthDays.size === 0) ready.monthDays = new Set([1])
    const raw = buildScheduleExpression(ready)
    onChange({ ...ready, raw })
  }

  function setFrequency(freq: Exclude<ScheduleFrequency, 'custom'>): void {
    const days = new Set(value.days)
    const monthDays = new Set(value.monthDays)
    if (freq === 'weekly' && days.size === 0) WORKDAYS.forEach((day) => days.add(day))
    if (freq === 'monthly' && monthDays.size === 0) monthDays.add(1)
    commitVisual({ ...value, freq, days, monthDays })
  }

  function setTime(next: string): void {
    const [h, m] = next.split(':').map(Number)
    if (!Number.isFinite(h) || !Number.isFinite(m)) return
    commitVisual({ ...value, hour: h, minute: m })
  }

  return (
    <div className="sched-builder auto-config-fields" data-schedule={value.raw}>
      <div className="sched-controls">
      <div className="sched-freq" style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
        {([['daily', '每天'], ['weekly', '每周'], ['monthly', '每月']] as const).map(([freq, label]) => (
          <button key={freq} type="button" className="settings-btn ghost" style={chipStyle(value.freq === freq)} disabled={disabled} aria-pressed={value.freq === freq} onClick={() => setFrequency(freq)}>
            {label}
          </button>
        ))}
      </div>

      {value.freq !== 'custom' && (
        <div className="sched-time settings-fld">
          <label>触发时间</label>
          <div className="sched-time-input" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ClockIcon size={15} />
            <input
              type="time"
              aria-label="触发时间"
              className="settings-inp sched-time-picker"
              disabled={disabled}
              value={timeValue}
              onChange={(e) => setTime(e.target.value)}
              style={{ width: 130 }}
            />
          </div>
        </div>
      )}
      <span className="auto-config-hint sched-timezone">本机时区</span>
      </div>

      {value.freq === 'weekly' && (
        <div className="sched-weekly settings-fld">
          <label>星期</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {SCHEDULE_DAYS.map((day, index) => (
              <button
                key={day}
                type="button"
                className={`settings-btn ghost sched-chip${value.days.has(day) ? ' on' : ''}`}
                style={chipStyle(value.days.has(day))}
                disabled={disabled}
                aria-pressed={value.days.has(day)}
                onClick={() => {
                  const days = new Set(value.days)
                  days.has(day) ? days.delete(day) : days.add(day)
                  if (days.size) commitVisual({ ...value, days })
                }}
              >
                {DAY_NAMES[index]}
              </button>
            ))}
          </div>
        </div>
      )}

      {value.freq === 'monthly' && (
        <div className="settings-fld">
          <label>每月日期</label>
          <div className="sched-dom-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(36px, 1fr))', gap: 5 }}>
            {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
              <button
                key={day}
                type="button"
                className={`settings-btn ghost sched-chip${value.monthDays.has(day) ? ' on' : ''}`}
                style={chipStyle(value.monthDays.has(day))}
                disabled={disabled}
                aria-pressed={value.monthDays.has(day)}
                onClick={() => {
                  const monthDays = new Set(value.monthDays)
                  monthDays.has(day) ? monthDays.delete(day) : monthDays.add(day)
                  if (monthDays.size) commitVisual({ ...value, monthDays })
                }}
              >
                {day}
              </button>
            ))}
          </div>
        </div>
      )}

      {value.freq === 'custom' && (
        <div className="sched-warning">此任务使用自定义调度规则，UniAgent 暂不提供可视化编辑。</div>
      )}

      {value.freq !== 'custom' && value.ok && (() => {
        const next = describeNextRun(value)
        const cadence = describeCadence(value)
        if (!next) return null
        return (
          <div className="auto-next">
            <ClockIcon size={14} />
            <span>下次执行 · <b>{next}</b></span>
            {cadence && <span className="auto-next-dim">（之后{cadence}）</span>}
          </div>
        )
      })()}

    </div>
  )
}
