import { useEffect, useRef, useState } from 'react'
import { resolveAgentModel, resolveAgentPermission, resolveModelEffort } from '@shared/agentChoices'
import { useAgentPreferences } from '../hooks'
import type { AgentDef, AutomationDetail, AutomationEditPatch, AutomationTask, NativeAutomationInput, PermissionMode, Project, ReasoningEffort } from '@shared/types'
import { nextScheduleRuns, parseScheduleExpression, type AutomationDayMode, type ParsedSchedule, type ScheduleDay, type ScheduleFrequency } from '@shared/automationSchedule'
import { CHINA_WORK_CALENDAR_YEARS } from '@shared/chinaWorkCalendar'
import { AutomationMutationController } from '../automationControllers'
import type { Requirement } from '@shared/requirementTypes'
import type { TaskScope } from '@shared/task'
import { useRequirements } from '../useRequirements'
import { ProjectPicker } from './ProjectPicker'
import { AgentIcon } from './AgentIcon'
import { Chevron, ClockIcon, ToggleSwitch, UiIcon } from './Icons'
import { AutomationTimePicker } from './AutomationTimePicker'
import { AutomationDatePicker } from './AutomationDatePicker'
import { Markdown } from './Markdown'
import './AutomationsPanel.css'

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
const DAY_MODE_LABELS = { all: '不限', workday: '法定工作日', 'non-workday': '非法定工作日' } as const
const CRON_DAY: Record<ScheduleDay, string> = { MO: '1', TU: '2', WE: '3', TH: '4', FR: '5', SA: '6', SU: '0' }

/** Build the canonical expression after a visual control changes. */
export function buildScheduleExpression(schedule: ParsedSchedule): string {
  if (schedule.freq === 'custom') return schedule.raw
  if (schedule.freq === 'once') {
    if (schedule.onceAt === undefined || !Number.isFinite(schedule.onceAt)) return ''
    return parseScheduleExpression(schedule.raw).onceAt === schedule.onceAt
      ? schedule.raw : `ONCE:${new Date(schedule.onceAt).toISOString()}`
  }
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
  if (schedule.freq === 'once') return schedule.onceAt === undefined ? '一次性' : `一次性 ${formatRunDate(schedule.onceAt)}`
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
export function describeNextRun(schedule: ParsedSchedule, from = new Date(), dayMode: AutomationDayMode = 'all'): string | null {
  const [next] = nextScheduleRuns(schedule, 1, from, dayMode)
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
export function describeSchedule(raw: string | undefined, from = new Date(), dayMode: AutomationDayMode = 'all'): { cadence: string; nextRun: string | null } {
  const value = (raw ?? '').trim()
  if (!value) return { cadence: '', nextRun: null }
  const core = value.split(/\s+·\s+/)[0].trim()
  const parsed = parseScheduleExpression(core)
  if (parsed.ok) return { cadence: describeCadence(parsed) + (dayMode === 'all' ? '' : ` · ${DAY_MODE_LABELS[dayMode]}`), nextRun: describeNextRun(parsed, from, dayMode) }
  if (/\*|RRULE:|FREQ=/i.test(value)) return { cadence: '自定义调度', nextRun: null }
  return { cadence: value, nextRun: null }
}

/**
 * Scheduled-automation panel (Doc4 需求4). 需求13: rendered INLINE in the main
 * chat area (codex-style), not a floating drawer. Centrally lists cron/automation
 * tasks discovered on disk across codex/traex, and lets the user flip each
 * between active and paused (rewrites the backing `automation.toml` status).
 *
 * Native UniAgent tasks share the list and editor with discovered CLI tasks.
 */
export function AutomationsPanel({ onOpenSession, embedded = false, requirementsEnabled = false }: { onOpenSession?: (id: string) => void; embedded?: boolean; requirementsEnabled?: boolean }): JSX.Element {
  const [items, setItems] = useState<AutomationTask[]>(cachedAutomations ?? [])
  const [agentFilter, setAgentFilter] = useState('all')
  const [agents, setAgents] = useState<AgentDef[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const requirementData = useRequirements(requirementsEnabled)
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
          {creating ? <span className="auto-badge auto-source auto-head-right">UniAgent 原生</span> :
            <span className="auto-header-status auto-head-right"><ToggleSwitch checked={t.status === 'active'}
              label={'启停 ' + t.name} disabled={busy || !canToggle(t)} onChange={() => void toggle(t)} />
              {automationStatusLabel(t.status)}</span>}
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
              onProjectsChange={setProjects}
              requirements={requirementData.requirements}
              requirementsLoading={requirementData.loading}
              requirementsError={requirementData.error}
              onRequirementsRetry={requirementData.retry}
              requirementsEnabled={requirementsEnabled}
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
      <div className="auto-agent-tabs" role="tablist" aria-label="按 Agent 筛选定时任务">
        <button
          role="tab"
          className={`settings-btn ghost auto-agent-tab${agentFilter === 'all' ? ' active' : ''}`}
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
            data-agent-id={agentId}
            aria-pressed={agentFilter === agentId}
            aria-selected={agentFilter === agentId}
            onClick={() => setAgentFilter(agentId)}
          >
            <AgentIcon agentId={agentId} size={14} /> {agents.find((agent) => agent.id === agentId)?.name ?? agentId} <span className="auto-agent-count">{count}</span>
          </button>
        ))}
      </div>
      <div className="drawer-list auto-list">
        {visibleItems.length > 0 && <div className="auto-list-table-head" aria-hidden="true">
          <span>任务</span><span>执行计划</span><span>下次执行</span><span>最近运行</span><span>启用</span><span />
        </div>}
        {loading ? (
          <div className="panel-loading auto-loading"><span className="loading-spinner" /></div>
        ) : listError && items.length === 0 ? (
          <div className="drawer-empty">定时任务加载失败，请稍后重试</div>
        ) : items.length === 0 ? (
          <div className="drawer-empty">暂无定时任务，点击「新建任务」设置执行 Agent 和时间</div>
        ) : visibleItems.length === 0 ? (
          <div className="drawer-empty">该 Agent 暂无定时任务</div>
        ) : (
          visibleItems.map(t => <AutomationListRow key={t.id} task={t} busy={busy} projects={projects} requirements={requirementData.requirements}
            onOpen={() => void openDetail(t)} onToggle={() => void toggle(t)} onOpenSession={onOpenSession} />)
        )}
      </div>
      <div className="drawer-foot">
        共 {items.length} 个任务 · 点击查看详情 / 管理
      </div>
    </div>
  )
}
interface EditorValues {
  dayMode: AutomationDayMode
  name: string
  prompt: string
  schedule: string
  model: string
  effort: ReasoningEffort | ''
  agentId: string
  taskScope: TaskScope
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
  return (task.status === 'active' || task.status === 'paused') && automationCanEdit(task)
}

export function automationCanEdit(task: AutomationTask): boolean {
  return task.source === 'uniagent' || !!task.path
}

export function automationCanDelete(task: AutomationTask): boolean {
  return automationCanEdit(task)
}

function AutomationEditor({
  task, detail, busy, editable, deletable, toggleable, onSave, onDelete, onToggle,
  onDirtyChange, agents, projects, onProjectsChange, requirements, requirementsLoading, requirementsError, onRequirementsRetry, requirementsEnabled,
  creating, onCreate, onCancel, onOpenSession
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
  onProjectsChange: (projects: Project[]) => void
  requirements: Requirement[]
  requirementsLoading: boolean
  requirementsError: string
  onRequirementsRetry: () => void
  requirementsEnabled: boolean
  creating: boolean
  onCreate: (input: NativeAutomationInput) => Promise<boolean>
  onCancel: () => void
  onOpenSession?: (id: string) => void
}): JSX.Element {
  const prefs = useAgentPreferences()
  const native = task.source === 'uniagent'
  const first: EditorValues = {
    dayMode: detail?.dayMode ?? task.dayMode ?? 'all',
    name: task.name, prompt: task.prompt ?? '', schedule: task.schedule ?? '', model: task.model ?? '',
    effort: detail?.reasoningEffort ?? '', agentId: task.agentId,
    taskScope: detail?.taskScope ?? task.taskScope ?? { kind: 'space', projectId: detail?.projectId ?? task.projectId ?? projects.find(project => project.isDefault)?.id ?? '' },
    permissionMode: detail?.permissionMode ?? agents.find(agent => agent.id === task.agentId)?.capabilities.permissionModes[0]?.id ?? ''
  }
  const [saved, setSaved] = useState(first)
  const [values, setValues] = useState(first)
  const [promptMode, setPromptMode] = useState<'edit' | 'preview'>(creating ? 'edit' : 'preview')
  const [schedule, setSchedule] = useState(() => scheduleForTask(first.schedule))
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  const changedPlan = schedule.raw !== saved.schedule || values.dayMode !== saved.dayMode
  const nextRuns = nextScheduleRuns(schedule, 3, new Date(now), values.dayMode)
  const futureRequired = native && (creating || changedPlan)
  const scheduleError = schedule.freq === 'once' && !schedule.ok ? '请选择有效的执行日期和时间' :
    futureRequired && schedule.ok && nextRuns.length === 0
      ? schedule.freq === 'once' ? '执行时间已过，请选择未来的日期和时间' : '已确认的调休日历内没有后续执行日期，请更新年历或更改计划'
      : ''
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
  const requirementId = values.taskScope.kind === 'requirement' ? values.taskScope.requirementId : undefined
  const requirement = requirements.find(item => item.id === requirementId)
  const projectId = values.taskScope.kind === 'space' ? values.taskScope.projectId : requirement?.projectId ?? ''
  const scopeError = requirementId ? !requirementsEnabled ? '需求功能已停用，请改选项目后保存' : requirementsLoading ? '正在读取需求…' : requirementsError ? '需求读取失败，请重试或改选项目' :
    !requirement || requirement.status === 'archived' ? '所选需求已不可用，请重新选择' :
    !projects.some(project => project.id === projectId) ? '需求未绑定有效主项目，请先编辑需求' : '' :
    !projects.some(project => project.id === projectId) ? '请选择有效项目' : ''
  const valid = !!prefs && values.name.trim() && schedule.ok && !scheduleError && (native || schedule.freq !== 'once') &&
    (!native || (values.prompt.trim() && available && !scopeError &&
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
      if (next.dayMode !== saved.dayMode) patch.dayMode = next.dayMode
      if (next.agentId !== saved.agentId) patch.agentId = next.agentId
      if (JSON.stringify(next.taskScope) !== JSON.stringify(saved.taskScope)) patch.taskScope = next.taskScope
      if (next.permissionMode !== saved.permissionMode) patch.permissionMode = next.permissionMode as PermissionMode
    }
    if (await onSave(patch)) {
      setValues(next); setSaved(next); setSchedule(scheduleForTask(normalized))
    }
  }
  const missing = [!values.name.trim() && '任务名称', native && !values.prompt.trim() && '指令 / 提示词'].filter(Boolean)
  const feedback = scheduleError || (missing.length ? '还需填写：' + missing.join('、') :
    !prefs ? '正在加载配置' : native && !available ? '所选 Agent 尚未就绪' :
    native && scopeError ? scopeError :
    !schedule.ok ? '请选择有效的执行计划' : '')
  return <div className="auto-config auto-inline-editor">
    <div className="auto-config-scroll">
      {!creating && <div className="auto-task-hero">
        <span className="auto-hero-icon"><AgentIcon agentId={task.agentId} size={24} /></span>
        <div className="auto-hero-main"><h2>{task.name}<span className="auto-badge auto-source">{native ? 'UniAgent 原生' : '本机任务'}</span></h2></div>
      </div>}
      {!editable && <div className="auto-config-hint">该任务没有可编辑的本机配置，目前仅供查看。</div>}
      <div className="auto-editor-layout"><div className="auto-main-form">
        <section className="auto-card">
          <h3 className="auto-card-head">任务内容</h3>
          <div className="auto-config-fields">
            <div className="settings-fld"><label>任务名称</label>
              <input aria-label="任务名称" placeholder="例如：工作日晨间简报" className="settings-inp auto-name-input" disabled={!editable || busy} value={values.name} onChange={event => change({ name: event.target.value })} />
            </div>
            <div className="settings-fld">
              <div className="auto-prompt-heading"><label>指令 / 提示词</label>
                <div className="auto-prompt-switch" role="group" aria-label="提示词显示方式">
                  <button type="button" aria-pressed={promptMode === 'edit'} disabled={!editable || busy} onClick={() => setPromptMode('edit')}>编辑</button>
                  <button type="button" aria-pressed={promptMode === 'preview'} disabled={busy} onClick={() => setPromptMode('preview')}>预览</button>
                </div>
              </div>
              <textarea aria-label="指令 / 提示词" className="settings-inp settings-textarea auto-prompt-input" hidden={promptMode !== 'edit'} disabled={!editable || busy} value={values.prompt} placeholder="描述你希望 Agent 定时完成的任务" onChange={event => change({ prompt: event.target.value })} />
              {promptMode === 'preview' && <div className="settings-inp auto-prompt-preview" role="region" aria-label="指令 / 提示词预览" tabIndex={0}><Markdown text={values.prompt} /></div>}
            </div>
          </div>
        </section>
        <section className="auto-card">
          <h3 className="auto-card-head">执行配置</h3>
          <div className="auto-config-fields">
            <div className="settings-fld-row">
              <div className="settings-fld"><label>执行 Agent</label>
                {native ? <div className="auto-agent-select"><AgentIcon agentId={values.agentId} size={15} /><select aria-label="执行 Agent" className="settings-select" value={values.agentId} disabled={busy || !editable} onChange={event => changeAgent(event.target.value)}>
                  {!agents.some(agent => agent.id === values.agentId) && <option value={values.agentId}>{values.agentId || '请选择 Agent'}（不可用）</option>}
                  {agents.map(agent => <option key={agent.id} value={agent.id} disabled={agent.lifecycle?.availability !== 'available' || agent.incompatible}>{agent.name}{agent.lifecycle?.availability !== 'available' || agent.incompatible ? '（未就绪）' : ''}</option>)}
                </select><span className={available ? 'auto-agent-available' : 'auto-agent-unavailable'}>{available ? '可用' : '未就绪'}</span></div> : <div className="auto-config-readonly">{agent?.name ?? task.agentId}</div>}
              </div>
              <div className={'settings-fld' + (native ? ' auto-ownership' : '')}><label>{native ? '任务归属' : '工作目录'}{native && requirementsEnabled && <small>项目／需求二选一</small>}</label>
                {native ? <>
                  <ProjectPicker projects={projects} projectId={projectId} disabled={busy || !editable}
                    onProjectsChange={onProjectsChange} onSelect={project => change({ taskScope: { kind: 'space', projectId: project.id } })}
                    requirements={requirementsEnabled ? requirements : undefined} requirementId={requirementId}
                    requirementsLoading={requirementsLoading} requirementsError={requirementsError}
                    onRequirementSelect={item => change({ taskScope: { kind: 'requirement', requirementId: item.id } })} />
                  {requirementId && <small className="auto-ownership-space" title={scopeError || projects.find(project => project.id === projectId)?.name}>执行项目：{projects.find(project => project.id === projectId)?.name ?? '主项目不可用'} · 随需求主项目</small>}
                  {requirementsError && requirementsEnabled && <div className="auto-ownership-error" role="alert">需求读取失败 <button type="button" disabled={busy} onClick={onRequirementsRetry}>重试</button></div>}
                  {scopeError && !requirementsError && <div className="auto-ownership-error" role="alert">{scopeError}</div>}
                </> : <div className="auto-config-readonly">{detail?.cwds?.join('、') || '由 Agent 配置决定'}</div>}
              </div>
            </div>
            <div className="settings-fld-row auto-config-models">
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
            {native && !available && <div className="sched-warning">所选 Agent 当前未就绪，请重新选择或等待检测完成。</div>}
          </div>
        </section>
        <section className="auto-card">
          <h3 className="auto-card-head">执行计划<small><UiIcon name="globe" size={13} />本机时区</small></h3>
          <ScheduleBuilder value={schedule} disabled={!editable || busy} onChange={setSchedule}
            allowOnce={native} dayMode={values.dayMode} error={scheduleError}
            onDayModeChange={native ? dayMode => change({ dayMode }) : undefined} />
        </section>
      </div><aside className="auto-editor-aside">
        <AutomationPlanPreview schedule={schedule} runs={nextRuns} dayMode={values.dayMode} error={scheduleError} task={task} changedPlan={changedPlan} />
        {!creating && <section className="auto-card auto-last-run"><h3>上次执行情况</h3>
          <AutomationRunSummary task={detail ?? task} showError disabled={busy || dirty} onOpenSession={onOpenSession} />
        </section>}
      </aside></div>
    </div>
    <div className="auto-config-savebar">
      {creating ? <span className={'auto-footer-feedback' + (feedback ? ' warning' : '')}><UiIcon name={feedback ? 'diagnostics' : 'check'} size={14} />
        {feedback || (nextRuns[0] ? '将于 ' + formatRunDate(nextRuns[0].getTime()) + (schedule.freq === 'once' ? ' 执行一次' : ' 首次执行') : '每次执行创建一个独立会话')}
      </span> : <button className="settings-btn ghost auto-del-btn" disabled={busy || !deletable} onClick={onDelete}>删除任务</button>}
      <div className="auto-config-actions">
        {!creating && <span className={'auto-dirty' + (dirty ? ' changed' : '')}>{editable ? dirty ? '● 有未保存的修改' : '已保存' : '只读'}</span>}
        <button className="settings-btn ghost auto-discard" disabled={busy || (!creating && !dirty)} onClick={() => {
          if (creating) onCancel()
          else { setValues(saved); setSchedule(scheduleForTask(saved.schedule)) }
        }}>{creating ? '取消' : '放弃修改'}</button>
        {editable && <button className="settings-btn primary auto-save" disabled={busy || !valid || (!creating && !dirty)} onClick={submit}>{busy ? '保存中…' : creating ? '创建并启用' : '保存修改'}</button>}
      </div>
    </div>
  </div>
}

function ScheduleBuilder({ value, disabled, onChange, dayMode = 'all', onDayModeChange, allowOnce, error }: {
  value: ParsedSchedule
  disabled: boolean
  onChange: (value: ParsedSchedule) => void
  dayMode?: AutomationDayMode
  onDayModeChange?: (value: AutomationDayMode) => void
  allowOnce: boolean
  error: string
}): JSX.Element {
  const once = value.freq === 'once'
  const timeValue = pad2(value.hour) + ':' + pad2(value.minute)
  function commitVisual(next: ParsedSchedule): void {
    const raw = buildScheduleExpression(next)
    onChange({ ...next, raw, ok: parseScheduleExpression(raw).ok })
  }
  function setFrequency(freq: Exclude<ScheduleFrequency, 'custom'>): void {
    const next = { ...value, freq, days: new Set(value.days), monthDays: new Set(value.monthDays) }
    if (freq === 'weekly' && next.days.size === 0) next.days = new Set(WORKDAYS)
    if (freq === 'monthly' && next.monthDays.size === 0) next.monthDays.add(1)
    if (freq === 'once') {
      if (next.onceAt === undefined) next.onceAt = nextScheduleRuns({ ...next, freq: 'daily', ok: true }, 1, new Date(Date.now()))[0]?.getTime()
      onDayModeChange?.('all')
    }
    commitVisual(next)
  }
  function setTime(next: string): void {
    const [hour, minute] = next.split(':').map(Number)
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return
    const date = new Date(value.onceAt ?? NaN)
    date.setHours(hour, minute, value.second, 0)
    commitVisual({ ...value, hour, minute, onceAt: once && date.getHours() === hour && date.getMinutes() === minute ? date.getTime() : undefined })
  }
  function setDate(day: string): void {
    const date = new Date(day + 'T' + timeValue + ':00')
    const valid = Number.isFinite(date.getTime()) && formatRunDate(date.getTime()).slice(0, 10) === day && date.getHours() === value.hour && date.getMinutes() === value.minute
    commitVisual({ ...value, second: 0, onceAt: valid ? date.getTime() : undefined })
  }
  return <div className="sched-builder auto-config-fields" data-schedule={value.raw}>
    <div className="sched-freq sched-frequency" role="group" aria-label="执行频率">
      {([['once', '一次性'], ['daily', '每天'], ['weekly', '每周'], ['monthly', '每月']] as const).filter(([freq]) => freq !== 'once' || allowOnce).map(([freq, label]) =>
        <button key={freq} type="button" disabled={disabled} aria-pressed={value.freq === freq} onClick={() => setFrequency(freq)}>{label}</button>)}
    </div>
    {value.freq !== 'custom' && <div className={'sched-plan-row' + (value.freq === 'daily' ? ' daily' : '')}>
      {once && <div className="settings-fld"><label>日期</label><AutomationDatePicker disabled={disabled} value={value.onceAt === undefined ? '' : formatRunDate(value.onceAt).slice(0, 10)} onChange={setDate} invalid={!!error} /></div>}
      {value.freq === 'weekly' && <div className="settings-fld sched-weekly"><label>星期 <small>可多选</small></label><div className="sched-week-grid">
        {SCHEDULE_DAYS.map((day, index) => <button key={day} type="button" className="sched-chip" disabled={disabled} aria-pressed={value.days.has(day)} onClick={() => {
          const days = new Set(value.days); days.has(day) ? days.delete(day) : days.add(day)
          if (days.size) commitVisual({ ...value, days })
        }}>周{DAY_NAMES[index]}</button>)}</div></div>}
      {value.freq === 'monthly' && <div className="settings-fld"><label>每月日期 <small>可多选，当月没有该日期时跳过</small></label><div className="sched-dom-grid">
        {Array.from({ length: 31 }, (_, i) => i + 1).map(day => <button key={day} type="button" className="sched-chip" disabled={disabled} aria-pressed={value.monthDays.has(day)} onClick={() => {
          const monthDays = new Set(value.monthDays); monthDays.has(day) ? monthDays.delete(day) : monthDays.add(day)
          if (monthDays.size) commitVisual({ ...value, monthDays })
        }}>{day}</button>)}</div></div>}
      <div className="sched-time settings-fld"><label>触发时间</label><AutomationTimePicker value={timeValue} disabled={disabled} onChange={setTime} /></div>
    </div>}
    {error && <div className="sched-warning" role="alert">{error}</div>}
    {!once && onDayModeChange && <div className="settings-fld sched-day-mode"><label>执行日期</label>
      <div className="sched-freq" role="group" aria-label="执行日期">{(Object.keys(DAY_MODE_LABELS) as AutomationDayMode[]).map(mode =>
        <button key={mode} type="button" disabled={disabled} aria-pressed={dayMode === mode} onClick={() => onDayModeChange(mode)}>{DAY_MODE_LABELS[mode]}</button>)}</div>
      {dayMode !== 'all' ? <div className="auto-schedule-rule">
        <div><span>{describeCadence(value).replace(/\s+\d{2}:\d{2}$/, '')}</span><b>∩</b><span>{DAY_MODE_LABELS[dayMode]}</span>同时满足才执行</div>
        <p>{dayMode === 'workday' ? '法定工作日：周一至周五及调休补班日，排除节假日。' : '非法定工作日：普通周末和节假日，排除调休补班日。'}
          {value.freq === 'weekly' && dayMode === 'workday' && '未选择相应星期的补班日不会执行；要覆盖全部补班日，请选择“每天”。'}
          {value.freq === 'monthly' && '所选日期不满足条件时跳过，不顺延。'}</p>
        <p>按中国大陆放假调休安排判断。已确认年历：{CHINA_WORK_CALENDAR_YEARS.join('、')} 年；未确认年份停止调度，更新年历后恢复。</p>
      </div> : <div className="auto-config-hint">不限：按所选频率执行；改选工作日筛选时，须与计划同时满足才执行。</div>}
    </div>}
    {once && <div className="auto-config-hint">一次性任务只在所选日期和时间触发一次，不使用工作日筛选；结果保留在执行会话中。</div>}
    {value.freq === 'custom' && <div className="sched-warning">此任务使用自定义调度规则，UniAgent 暂不提供可视化编辑。</div>}
  </div>
}

const RUN_LABELS = { success: '执行成功', error: '执行失败', running: '正在执行', 'awaiting-approval': '等待授权', unknown: '状态未知' }
function automationStatusLabel(status: AutomationTask['status']): string {
  return status === 'active' ? '已启用' : status === 'paused' ? '已暂停' : status === 'completed' ? '已结束' : '状态未知'
}
function AutomationRunSummary({ task, disabled, onOpenSession, showError = false }: { task: AutomationTask; disabled?: boolean; onOpenSession?: (id: string) => void; showError?: boolean }): JSX.Element {
  const notStarted = task.source === 'uniagent' && task.lastRunStatus === 'error' && !task.lastSessionId
  return <div className={'auto-run-summary auto-run-' + (task.lastRunStatus ?? 'unknown')} title={task.lastRunStatus === 'error' ? task.lastRunError : undefined}>
    <span>{notStarted ? '未能启动' : task.lastRunStatus ? RUN_LABELS[task.lastRunStatus] : task.source === 'uniagent' ? '尚未运行' : '—'}</span>
    {task.lastRunAt !== undefined && <small>{formatRunDate(task.lastRunAt)}</small>}
    {showError && task.lastRunStatus === 'error' && task.lastRunError && <div className="auto-run-error-detail"><span>错误原因</span><p>{task.lastRunError}</p></div>}
    {task.lastSessionId && onOpenSession && <button type="button" className="auto-run-link" disabled={disabled} title={disabled ? '请先保存或放弃修改' : undefined}
      onClick={event => { event.stopPropagation(); onOpenSession(task.lastSessionId!) }}>查看执行会话 ↗</button>}
  </div>
}
function automationOwnershipLabel(scope: TaskScope, projects: Project[], requirements: Requirement[]): string {
  return scope.kind === 'requirement' ? '需求：' + (requirements.find(item => item.id === scope.requirementId)?.name ?? '需求不可用')
    : '项目：' + (projects.find(item => item.id === scope.projectId)?.name ?? '项目不可用')
}
function AutomationListRow({ task, busy, projects, requirements, onOpen, onToggle, onOpenSession }: { task: AutomationTask; busy: boolean; projects: Project[]; requirements: Requirement[]; onOpen: () => void; onToggle: () => void; onOpenSession?: (id: string) => void }): JSX.Element {
  const parsed = parseScheduleExpression(task.schedule ?? '')
  const description = describeSchedule(task.schedule, new Date(), task.dayMode)
  const next = task.source === 'uniagent' ? task.status === 'active' && task.nextRunAt ? formatRunDate(task.nextRunAt) : null : description.nextRun
  const waitingCalendar = task.source === 'uniagent' && task.status === 'active' && task.dayMode && task.dayMode !== 'all' && !task.nextRunAt
  return <div className={'auto-item auto-task-row' + (task.status === 'paused' ? ' paused' : '')} onClick={onOpen}>
    <div className="auto-task-content"><span className="auto-row-icon"><AgentIcon agentId={task.agentId} size={18} /></span><div className="auto-main">
      <button className="auto-name" onClick={event => { event.stopPropagation(); onOpen() }}>{task.name}</button>
      <span className={'auto-badge' + (task.source === 'uniagent' ? ' auto-source' : '')}>{task.source === 'uniagent' ? 'UniAgent' : '本机任务'}</span>
      {task.source === 'uniagent' && <small className="auto-row-scope">{automationOwnershipLabel(task.taskScope ?? { kind: 'space', projectId: task.projectId ?? '' }, projects, requirements)}</small>}</div></div>
    <div className="auto-list-plan"><span className="auto-sched-cadence">{parsed.freq === 'once' ? '一次性' : description.cadence.replace(/ · .*$/, '')}</span><small>{parsed.freq === 'once' ? '仅触发一次' : DAY_MODE_LABELS[task.dayMode ?? 'all']}</small></div>
    <div className="auto-list-next">{task.status === 'paused' ? '已暂停' : task.status === 'completed' ? '已结束' : waitingCalendar ? <span className="auto-calendar-wait">等待年历更新<small>已确认年历内无匹配日期</small></span>
      : next ?? (task.lastRunStatus === 'running' || task.lastRunStatus === 'awaiting-approval' ? '本次执行中' : '—')}</div>
    <div className="auto-list-run"><AutomationRunSummary task={task} disabled={busy} onOpenSession={onOpenSession} /></div>
    <span className="auto-list-switch" onClick={event => event.stopPropagation()}><ToggleSwitch checked={task.status === 'active'} label={'启停 ' + task.name} disabled={busy || !automationCanToggle(task)} onChange={onToggle} /></span>
    <span className="auto-chev"><Chevron size={14} /></span>
  </div>
}
function AutomationPlanPreview({ schedule, runs, dayMode, error, task, changedPlan }: { schedule: ParsedSchedule; runs: Date[]; dayMode: AutomationDayMode; error: string; task: AutomationTask; changedPlan: boolean }): JSX.Element {
  const once = schedule.freq === 'once'
  const completed = task.status === 'completed' && !changedPlan
  const date = once && schedule.onceAt !== undefined ? new Date(schedule.onceAt) : runs[0]
  return <div className={'auto-plan-preview' + (error ? ' invalid' : '')}>
    <div className="auto-preview-label"><ClockIcon size={14} />{error ? '执行时间不可用' : completed ? '已结束' : once ? '执行时间' : '下次执行'}</div>
    {date ? <><div className="auto-preview-date">{formatRunDate(date.getTime()).slice(0, 14)}</div><div className="auto-preview-time">{pad2(date.getHours())}:{pad2(date.getMinutes())}</div></> : <p>{error || '暂无可计算的执行时间'}</p>}
    <div className="auto-preview-tags"><span>{once ? '一次性 · 仅触发一次' : describeCadence(schedule)}</span>{!once && dayMode !== 'all' && <span>{DAY_MODE_LABELS[dayMode]}</span>}</div>
    {error ? <p className="auto-preview-warning">{error}</p> : once ? <div className="auto-upcoming-runs"><p>触发后不再安排下次执行</p><p>执行结果保留在执行会话中</p></div> :
      <div className="auto-upcoming-runs">{runs.slice(1).map(date => <p key={date.getTime()}>• {formatRunDate(date.getTime())}</p>)}{dayMode !== 'all' && runs.length < 3 && <p className="auto-calendar-wait">后续年份尚无已确认年历，更新后恢复</p>}</div>}
    <div className="auto-preview-timezone"><UiIcon name="globe" size={13} />本机时区 · {Intl.DateTimeFormat().resolvedOptions().timeZone}</div>
  </div>
}
