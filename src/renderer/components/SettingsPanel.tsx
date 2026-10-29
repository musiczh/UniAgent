import { SetGroup, SetRow, SetSelect } from './SettingsPrimitives'
import { INTERNAL_DISTRIBUTION, APP_REPOSITORY, APP_NAME } from '@shared/distribution'
import { resolveAgentModel, resolveAgentPermission, resolveModelEffort, resolveModelThinking } from '@shared/agentChoices'
import { useAgentPreferences } from '../hooks'
import { AssistantSettings } from './AssistantSettings'
import { FeishuBinding } from './AssistantFeishuBinding'
import { FeishuNotificationSettings } from './FeishuNotificationSettings'
import { TeamManagement } from './TeamManagement'
import type { TeamDefinition } from '@shared/teamTypes'
import { RequirementSettings } from './RequirementSettings'
import { CodexModelSettings } from './CodexModelSettings'

import { DeepSeekSettings } from './DeepSeekSettings'
import { MCodeSettings } from './MCodeSettings'
import { CliAgentSettings } from './CliAgentSettings'

import { isCliSetupId } from '@shared/agentSetup'
import { agentExternalStatus, agentRuntimeStatus, type AgentStatusView } from '@shared/agentStatusView'
import { agentQuotaConsole, quotaRemainingWindow, quotaSummaryText, type AgentQuotaSnapshot } from '@shared/agentQuota'
import { ZCodeSettings } from './ZCodeSettings'
import { KimiSettings } from './KimiSettings'
import { kimiErrorCopy } from '@shared/kimiErrors'
import { ZCODE_MODEL_SERVICES, type ZCodeConfigurationSnapshot, type ZCodeModelService } from '@shared/zcode'
import { useEffect, useRef, useState, type Dispatch, type SetStateAction, type MutableRefObject, type ReactNode } from 'react'
import type {
  AgentDef,
  AgentPref,
  AgentRole,
  AgentRoleCatalogEntry,
  AppSettings,
  AppUpdateState,
  DiagnosticEntry,
  FeishuStatus,
  HandoffPreset,
  HistoryForkPoint,
  PermissionModeId,
  PrefsData,
  Project,
  QueueWaitEvaluation,
  QueueWaitQualityReport,
  ReasoningEffort,
  CodexRateLimits
} from '@shared/types'
import { DEFAULT_ENABLED_AGENT_IDS } from '@shared/types'
import { DEFAULT_SIDEBAR_SHORTCUTS, isSettingsPagePanel, MAX_SIDEBAR_SHORTCUTS, DISTRIBUTION_SETTINGS_CATEGORIES as SETTINGS_CATEGORIES, type SettingsCategory } from '@shared/settingsNavigation'
import type { CapabilityInventorySyncRequest } from '@shared/capabilitySync'
import { orderedWindows, quotaView } from '../codexRateLimits'
import { AgentIcon } from './AgentIcon'
import { AgentBetaBadge } from './AgentBetaBadge'
import { AgentCapabilitiesPanel } from './AgentCapabilitiesPanel'
import { ResumePanel } from './ResumePanel'
import { TokenUsagePanel } from './TokenUsagePanel'
import { AutomationsPanel } from './AutomationsPanel'
import { ClockIcon, RefreshIcon, ToggleSwitch, UiIcon } from './Icons'
import { ProjectEditorDialog } from './ProjectEditorDialog'
import { ProjectWorktrees } from './ProjectWorktrees'

/** Actionable copy for a failed update check, keyed by the error code from appUpdater. */
const APP_UPDATE_ERROR_TEXT: Record<NonNullable<AppUpdateState['error']>, string> = INTERNAL_DISTRIBUTION ? {
  auth_required: '无法访问 Bits，请先在终端完成 Bits Git 登录后重试。',
  git_unavailable: '未找到 Git，无法检查 Bits 更新。',
  network: '无法连接 Bits，请检查网络或代理后重试。',
  invalid_manifest: 'Bits 中的更新清单格式无效，请联系维护者。',
  no_asset: '最新版本缺少 arm64 DMG，请联系维护者。',
  no_release: '当前 Bits 仓库尚未发布可下载版本。'
} : {
  auth_required: '无法读取公开版本，请稍后重试。',
  git_unavailable: '无法读取公开版本，请稍后重试。',
  network: '无法连接 GitHub 更新源，请检查网络或代理后重试。',
  invalid_manifest: '公开更新清单格式无效，请联系维护者。',
  no_asset: '最新版本缺少 arm64 DMG，请联系维护者。',
  no_release: '当前尚未发布可下载的公开版本。'
}

/** 推理强度中文标签（与 NewTaskPanel / Composer 保持一致）。 */
const EFFORT_LABEL: Record<string, string> = {
  off: '关闭', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大', ultra: 'Ultra'
}

export function ZCodeConfigurationGroup({ onRedetect, disabled = false }: { onRedetect: () => unknown; disabled?: boolean }): JSX.Element {
  const [snapshot, setSnapshot] = useState<ZCodeConfigurationSnapshot>()
  const [service, setService] = useState<ZCodeModelService>('bigmodel-coding')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<ZCodeConfigurationSnapshot['phase']>('unconfigured')
  const [message, setMessage] = useState('')
  const requestVersion = useRef(0)
  useEffect(() => {
    let current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const version = requestVersion.current
    const load = () => {
      void window.uniagent.getZCodeConfiguration().then(value => {
        if (!current || version !== requestVersion.current) return
        setSnapshot(value); setService(value.service); setPhase(value.phase); setMessage(value.message || '')
        setBusy(value.phase === 'checking')
        if (value.phase === 'checking') timer = setTimeout(load, 1000)
      }).catch(() => { if (current && version === requestVersion.current) { setBusy(false); setPhase('failed'); setMessage('配置状态读取失败，请重新打开详情页') } })
    }
    load()
    return () => { current = false; if (timer) clearTimeout(timer) }
  }, [])
  const hasKey = snapshot?.hasKey && snapshot.service === service
  const changed = () => { setPhase(hasKey ? 'saved' : 'unconfigured'); setMessage('') }
  const detect = async () => {
    requestVersion.current++
    setBusy(true); setPhase('checking'); setMessage('正在获取模型列表…')
    try {
      const result = await window.uniagent.checkZCodeConfiguration({ service, ...(apiKey.trim() ? { apiKey } : {}) })
      setSnapshot(result); setPhase(result.phase); setMessage(result.message || '')
      if (result.phase === 'ready') {
        setApiKey(''); setService(result.service)
        try { await onRedetect() }
        catch { setMessage('模型列表获取成功，默认配置刷新失败，请点击“刷新状态”重试') }
      }
    } catch {
      setPhase('failed'); setMessage('检测未完成，请确认 ZCode 任务与更新已结束后重试')
    } finally { setBusy(false) }
  }
  const label = { unconfigured: '未配置', saved: '待检测', checking: '检测中', ready: '配置完成', failed: '检测失败' }[phase]
  const tone = phase === 'ready' ? 'ok' : phase === 'failed' ? 'warn' : 'off'
  return <SetGroup title="授权配置">
    <SetRow label="模型服务" sub={ZCODE_MODEL_SERVICES.find(item => item.id === service)?.description} control={
      <SetSelect ariaLabel="ZCode 模型服务" value={service} disabled={busy || disabled} onChange={value => {
        setService(value as ZCodeModelService); setPhase(snapshot?.hasKey && snapshot.service === value ? 'saved' : 'unconfigured'); setMessage(''); setApiKey('')
      }}>
        {ZCODE_MODEL_SERVICES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </SetSelect>
    } />
    <SetRow label="API Key" sub={hasKey ? '已保存 · 输入新 Key 可替换' : '检测通过后保存，仅保存在本机'} control={
      <input className="set-fld-inp" style={{ width: 260 }} aria-label="ZCode API Key" type="password" autoComplete="off" spellCheck={false}
        value={apiKey} placeholder={hasKey ? '已保存，留空重新检测' : '输入 API Key'} onChange={event => { setApiKey(event.target.value); changed() }} disabled={busy || disabled} />
    } />
    <SetRow label="配置状态" sub={busy ? '正在获取模型列表…' : message || '仅获取模型列表，不发起模型对话'} control={<>
      <button className="set-mini-btn primary" disabled={disabled || busy || !snapshot || (!apiKey.trim() && !hasKey)} onClick={() => void detect()}>
        {busy && <RefreshIcon size={13} className="is-spinning" />}{busy ? '检测中…' : '检测配置'}
      </button>
      {!busy && <span className="status-pill" role="status"><span className={`dot ${tone}`} /><span className={`txt-${tone}`}>{label}</span></span>}
    </>} />
  </SetGroup>
}

/* ------------------------------------------------------------------ *
 * 补8 — 设置页共用的「分组标题 + 行卡片」原子组件（对齐 mockup 设计系统）。 *
 * ------------------------------------------------------------------ */
function SetBackTop({ label, onBack, children }: { label: string; onBack: () => void; children: ReactNode }): JSX.Element {
  return (
    <div className="set-detail-top">
      <button className="set-back" onClick={onBack}>
        <span className="set-caret"><UiIcon name="chevron-right" size={15} /></span>{label}
      </button>
      {children}
    </div>
  )
}

function queueWaitSeconds(value: number | null | undefined, signed = false): string {
  if (value == null) return '—'
  return (signed && value > 0 ? '+' : '') + (value / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + 's'
}

const QUEUE_WAIT_OUTCOME: Record<QueueWaitEvaluation['outcome'], string> = {
  acquired: '成功出队', cancelled: '已取消', failed: '失败', disconnected: '断线', unknown: '结束原因未知', replaced: '阶段变更'
}

function QueueWaitQuality({ detail = false, onOpen, onBack }: {
  detail?: boolean
  onOpen?: () => void
  onBack?: () => void
}): JSX.Element {
  const [report, setReport] = useState<QueueWaitQualityReport | null>(null)
  const [model, setModel] = useState('')
  const [algorithmVersion, setAlgorithmVersion] = useState<string | undefined>()
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [action, setAction] = useState('')
  const [copying, setCopying] = useState(false)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setAction('')
    window.uniagent.getQueueWaitQuality({ model: model || undefined, algorithmVersion }).then((value) => {
      if (!cancelled) setReport(value)
    }).catch(() => {
      if (!cancelled) setError('核验数据读取失败，请刷新重试')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [model, algorithmVersion, refresh])

  if (!detail) return (
    <SetGroup title="排队预估">
      <SetRow icon={<ClockIcon size={15} />} label="等待时间预测质量"
        sub={error || (report?.evaluatedCount ? '近 30 天 · 首次预估与实际剩余等待对比' : '近 30 天 · 尚无完成核验的预估样本')}
        control={<span className="ver">{loading ? '读取中…' : error ? '读取失败' : report?.meanAbsoluteErrorMs != null ? '平均误差 ' + queueWaitSeconds(report.meanAbsoluteErrorMs) : '积累中'}</span>}
        onClick={onOpen} />
    </SetGroup>
  )

  const available = !loading && !error ? report : null
  async function copyReport(): Promise<void> {
    setCopying(true)
    try {
      await window.uniagent.copyQueueWaitQuality({ model: model || undefined, algorithmVersion })
      setAction('报告已复制')
    } catch { setAction('复制失败，请重试') }
    finally { setCopying(false) }
  }
  async function openLogs(): Promise<void> {
    try { await window.uniagent.openQueueWaitQualityLogs() }
    catch { setAction('日志目录打开失败，请重试') }
  }

  return (
    <>
      <SetBackTop label="返回通用" onBack={() => onBack?.()}>
        <div className="set-detail-headrow">
          <div className="set-detail-title"><div className="sdt-main">
            <h2>等待时间预测质量</h2>
            <div className="set-detail-sub">近 30 天 · 每段排队的首次预估{available && ' · ' + new Date(available.generatedAt).toLocaleString('zh-CN') + ' 更新'}</div>
          </div></div>
          <div className="set-detail-top-actions">
            <button className="set-mini-btn" disabled={loading} onClick={() => setRefresh((n) => n + 1)}>{loading ? '读取中…' : '刷新'}</button>
            <button className="set-mini-btn" disabled={!available || copying} onClick={() => void copyReport()}>{copying ? '复制中…' : '复制报告'}</button>
          </div>
        </div>
      </SetBackTop>
      <div className="queue-quality-filters">
        <label>模型 <select aria-label="核验模型" value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">全部模型</option>
          {[...new Set([...(report?.models ?? []), ...(model ? [model] : [])])].map((value) => <option key={value}>{value}</option>)}
        </select></label>
        <label>算法 <select aria-label="核验算法版本" value={algorithmVersion ?? report?.currentAlgorithmVersion ?? ''} onChange={(e) => setAlgorithmVersion(e.target.value)}>
          <option value="">全部版本</option>
          {(report?.algorithmVersions ?? []).map((value) => <option key={value} value={value}>{value}{value === report?.currentAlgorithmVersion ? '（当前）' : ''}</option>)}
        </select></label>
      </div>
      {(error || action || report?.storageError) && <div className="queue-quality-notice" role="status">{[error, action, report?.storageError].filter(Boolean).join(' · ')}</div>}
      <SetGroup title="预估误差">
        <SetRow label="平均绝对误差" sub="预估与实际剩余等待之差的绝对值；越低越好"
          control={<span className="queue-quality-primary">{queueWaitSeconds(available?.meanAbsoluteErrorMs)}</span>} />
        <SetRow label="P90 绝对误差" sub="90% 的有效样本误差不超过此值"
          control={<span className="queue-quality-value">{queueWaitSeconds(available?.p90AbsoluteErrorMs)}</span>} />
        <SetRow label="平均偏差" sub="预估 − 实际；负数代表低估等待时间"
          control={<span className="queue-quality-value">{queueWaitSeconds(available?.meanErrorMs, true)}{available?.meanErrorMs ? available.meanErrorMs < 0 ? ' · 偏低' : ' · 偏高' : ''}</span>} />
        <SetRow label="预估覆盖率"
          sub={available ? available.evaluatedCount + ' 段有效预估 / ' + available.successfulCount + ' 段成功出队；另有 ' + available.interruptedCount + ' 段中断，不计入误差' : '成功出队中具备有效预估的比例'}
          control={<span className="queue-quality-value">{available?.coverage == null ? '—' : (available.coverage * 100).toFixed(1) + '%'}</span>} />
        {available && (available.invalidCount > 0 || available.unfinishedCount > 0) && <div className="queue-quality-notice">
          {available.unfinishedCount} 段等待结束结果，{available.invalidCount} 段时间数据无效；均不计入误差。
        </div>}
        {available && !available.evaluatedCount && <div className="set-empty">尚无有效核验样本；排队产生预估并成功出队后自动积累。</div>}
      </SetGroup>
      <SetGroup title="最近核验记录">
        {!available?.recent.length ? <div className="set-empty">{loading ? '读取中…' : error || '暂无核验记录'}</div> : (
          <div className="queue-quality-table-wrap"><table className="queue-quality-table log-card">
            <thead><tr><th>结束时间 / 模型</th><th>首次预估</th><th>实际剩余</th><th>偏差</th></tr></thead>
            <tbody>{available.recent.map((entry) => <tr key={entry.phaseId}>
              <td>{new Date(entry.endedAt).toLocaleString('zh-CN')} · {entry.model}
                <div className="queue-quality-record-sub">{QUEUE_WAIT_OUTCOME[entry.outcome]} · {entry.algorithmVersion}{entry.outcome === 'acquired' && !entry.firstPrediction ? ' · 无预估' : ''}</div>
              </td>
              <td>{queueWaitSeconds(entry.firstPrediction?.estimatedRemainingMs)}</td>
              <td>{queueWaitSeconds(entry.actualRemainingMs)}</td>
              <td>{queueWaitSeconds(entry.errorMs, true)}</td>
            </tr>)}</tbody>
          </table></div>
        )}
      </SetGroup>
      <SetGroup title="专属日志">
        <SetRow label="排队预估核验日志" sub="预估发布、预估修正、成功出队及中断均独立留存；按算法版本标记"
          control={<button className="set-mini-btn" onClick={() => void openLogs()}>打开日志目录</button>} />
        <SetRow label={'保留 ' + (report?.logRetentionDays ?? 90) + ' 天'} sub="queue-wait-evaluations.jsonl · 清空运行诊断日志不会删除核验记录" />
      </SetGroup>
    </>
  )
}

/**
 * Codex 用量额度 — the account rate-limit windows (weekly + optional 5-hour)
 * read from the newest on-disk rollout. Only rendered on the Codex Agent detail
 * page; shows a placeholder until a Codex session has run at least one turn.
 */
function CodexQuotaGroup(): JSX.Element {
  const [rl, setRl] = useState<CodexRateLimits | null>(null)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let cancelled = false
    const off = window.uniagent.onCodexRateLimits((data) => {
      if (!cancelled) { setRl(data); setLoaded(true) }
    })
    window.uniagent.getCodexRateLimits().then(
      (data) => { if (!cancelled) { setRl(data); setLoaded(true) } },
      () => { if (!cancelled) setLoaded(true) }
    )
    return () => { cancelled = true; off() }
  }, [])
  const windows = orderedWindows(rl)
  return (
    <SetGroup title="用量额度">
      {windows.length === 0 ? (
        <div className="row"><div className="r-main"><div className="r-sub">
          {loaded ? '暂无用量数据，运行一次 Codex 会话后自动获取' : '读取中…'}
        </div></div></div>
      ) : (
        windows.map((win) => {
          const q = quotaView(win)
          const cls = q.level === 'ok' ? '' : q.level === 'danger' ? ' danger' : ' warn'
          return (
            <div className={`row set-quota-row${cls}`} key={win.windowMinutes}>
              <div className="r-main">
                <div className="r-label">{q.label}</div>
                <div className="r-sub">{q.sub}</div>
              </div>
              <div className="r-control set-quota-ctl">
                <span className={`set-remain${cls}`}>剩余 {Math.round(q.remainPercent)}%</span>
                <span className="set-bar"><i style={{ width: `${q.usedPercent}%` }} /></span>
                <span className="set-sub-r">{q.resetRelative} · {q.resetAbsolute}</span>
              </div>
            </div>
          )
        })
      )}
      {rl?.planType && (
        <div className="set-quota-foot">数据随会话运行自动更新 · 计划类型 <span className="set-quota-plan">{rl.planType}</span></div>
      )}
    </SetGroup>
  )
}

export class AppUpdateRequestController {
  private generation = 0

  invalidate(): void {
    this.generation += 1
  }

  async run(
    request: () => Promise<AppUpdateState>,
    commit: (value: AppUpdateState) => void,
    settle: () => void = () => {},
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

/**
 * 需求6 — 设置页 (settings), reworked per docs/settings-refactor-ui-mockup.html:
 *   1. CLI 状态 — moved out of the sidebar footer into settings; lists each
 *      detected agent's install state with a 重新探测 action. (No per-agent model
 *      table — the "当前 Agent" section was removed by design.)
 *   2. 迁移诊断 — moved out of the sidebar nav; a compact rollup (error/warn
 *      counts + latest rows) with 复制全部日志 / 清空 actions and a link to the
 *      full log panel.
 *   3. 任务模板 — reusable handoff templates with manual 添加 / 编辑 / 删除 via a
 *      modal that persists through PresetStore (presets:save / presets:delete).
 *
 * All data comes from existing IPC (detectAgents / listDiagnostics /
 * listPresets / savePreset / deletePreset / copyDiagnosticsReport).
 */
export function SettingsPanel({
  agents,
  detecting = false,
  onRedetect,
  onInitialize,
  onAgentsChanged,
  onAgentEnabledChange,
  onOpenSync,
  onBack, initialCategory = 'general', initialTeamId, windowed = false,
  onCategoryChange, onSidebarShortcutsChange, navigationGuard, navigationKey, onOpenSession,
  onRequirementsEnabledChange, e2eFixtures = false, onForkSame = () => {}, onImport = () => {}, onForkCross = () => {}
}: {
  initialCategory?: SettingsCategory
  initialTeamId?: string
  /** 全窗模式（左侧侧边栏快捷入口打开）：去掉设置内侧栏与「‹ 设置」头部，标题为分类名。 */
  windowed?: boolean
  onCategoryChange?: (category: SettingsCategory) => void
  onSidebarShortcutsChange?: (shortcuts: SettingsCategory[]) => void
  onRequirementsEnabledChange?: (enabled: boolean) => void
  onOpenSession?: (id: string) => void
  /** 页内「导入会话」的分叉 / 导入动作（与全窗 ResumePanel 同一套回调）。 */
  e2eFixtures?: boolean
  onForkSame?: (agentId: string, nativeId: string, cwd?: string, point?: HistoryForkPoint, compatibilityMode?: boolean) => void | Promise<void>
  onImport?: (agentId: string, nativeId: string, cwd?: string, historyTitle?: string) => void | Promise<void>
  onForkCross?: (sourceAgentId: string, nativeId: string, targetAgentId: string, point?: HistoryForkPoint) => void | Promise<void>
  navigationGuard?: MutableRefObject<(() => boolean) | null>
  navigationKey?: number
  agents: AgentDef[]
  detecting?: boolean
  onRedetect: () => void
  onInitialize: (targetAgentId: string) => void
  onAgentsChanged: Dispatch<SetStateAction<AgentDef[]>>
  onAgentEnabledChange?: (enabledAgentIds: string[]) => void
  onOpenSync: (request: CapabilityInventorySyncRequest) => void
  onBack: () => void
}): JSX.Element {
  const [category, setCategory] = useState<SettingsCategory>(initialCategory)
  const fallbackNavigationGuard = useRef<(() => boolean) | null>(null)
  const sourceNavigationGuard = navigationGuard ?? fallbackNavigationGuard
  // 补8 — 每个分类的「主页面 / 详情页」二级结构。null = 主页面；字符串标识打开的详情项。
  const [detailView, setDetailView] = useState<string | null>(initialCategory === 'teams' ? initialTeamId || null : null)
  const [diag, setDiag] = useState<DiagnosticEntry[]>([])
  const [teams, setTeams] = useState<TeamDefinition[]>([])
  const [teamError, setTeamError] = useState('')
  const refreshTeams = () => { void window.uniagent.teamCatalog().then(c => { setTeams(c.teams); setTeamError(c.errors.join('；')) }).catch(e => setTeamError(String(e))) }
  useEffect(() => { refreshTeams(); return window.uniagent.onTeamChanged(refreshTeams) }, [])
  const [roles, setRoles] = useState<AgentRoleCatalogEntry[]>([])
  const [rolesError, setRolesError] = useState('')
  useEffect(() => window.uniagent.onUniAgentManagementChanged(resource => {
    if (resource === 'roles') void window.uniagent.listRoles().then(next => { setRoles(next); setRolesError('') }).catch(error => setRolesError(String(error)))
    if (['settings','agents'].includes(resource)) void window.uniagent.getAppSettings().then(setAppConfig).catch(() => {})
  }), [])
  const [presets, setPresets] = useState<HandoffPreset[]>([])
  const [copied, setCopied] = useState(false)
  const [logFilter, setLogFilter] = useState<'all' | 'error' | 'warn'>('all')
  const [selectedDiagnostics, setSelectedDiagnostics] = useState<string[]>([])
  const [appConfig, setAppConfig] = useState<AppSettings | null>(null)
  const [shortcutSaving, setShortcutSaving] = useState(false)
  const [shortcutError, setShortcutError] = useState('')
  const [appVersion, setAppVersion] = useState('')
  const [appUpdate, setAppUpdate] = useState<AppUpdateState | null>(null)
  const [appUpdateBusy, setAppUpdateBusy] = useState(false)
  const appUpdateRequest = useRef(new AppUpdateRequestController())
  const [prefs, setPrefs] = useState<PrefsData | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [prefsError, setPrefsError] = useState<Record<string, string>>({})
  const [busyAgent, setBusyAgent] = useState<string | null>(null)
  const [bulkUpdate, setBulkUpdate] = useState<{ current: number; total: number } | null>(null)
  const [checkingAgent, setCheckingAgent] = useState<string | null>(null)
  const [lifecycleError, setLifecycleError] = useState<Record<string, string>>({})
  const [redetectingAgents, setRedetectingAgents] = useState<string[]>([])
  const redetectFlights = useRef(new Set<string>())
  // 外部行的额度在后台查询，不阻塞列表和开关。
  const [quotaByAgent, setQuotaByAgent] = useState<Record<string, AgentQuotaSnapshot | null>>({})
  const quotaRequested = useRef(new Set<string>())
  const quotaMounted = useRef(true)
  const [updateBlocked, setUpdateBlocked] = useState(false)
  // Session settings follow the persisted bot binding and live connection status.
  const [feishu, setFeishu] = useState<FeishuStatus | null>(null)
  const [assistantPage, setAssistantPage] = useState<'config' | 'feishu'>('config')
  const configuredAgentIds: readonly string[] = appConfig?.enabledAgentIds ?? DEFAULT_ENABLED_AGENT_IDS
  const sidebarShortcuts = appConfig?.sidebarShortcuts ?? DEFAULT_SIDEBAR_SHORTCUTS

  useEffect(() => {
    setCategory(initialCategory)
    setAssistantPage('config')
    setDetailView(initialCategory === 'teams' ? initialTeamId || null : null)
  }, [initialCategory, initialTeamId, navigationKey])

  async function toggleSidebarShortcut(id: SettingsCategory): Promise<void> {
    if (!appConfig || shortcutSaving) return
    const selected = sidebarShortcuts.includes(id)
    if (!selected && sidebarShortcuts.length >= MAX_SIDEBAR_SHORTCUTS) return
    const nextShortcuts = selected ? sidebarShortcuts.filter(value => value !== id) : [...sidebarShortcuts, id]
    setShortcutSaving(true)
    setShortcutError('')
    try {
      const next = await window.uniagent.setAppSettings({ sidebarShortcuts: nextShortcuts })
      setAppConfig(next)
      onSidebarShortcutsChange?.(next.sidebarShortcuts ?? [...DEFAULT_SIDEBAR_SHORTCUTS])
    } catch {
      setShortcutError('快捷入口保存失败，请重试。')
    } finally {
      setShortcutSaving(false)
    }
  }

  useEffect(() => {
    // 迁移诊断 only surfaces anomalies — never a success line. We no longer record
    // the old `export_ok` "搬运完成" entry, but filter any legacy one out of the
    // count / list so a clean import never badges the panel.
    window.uniagent.listDiagnostics().then((d) => setDiag(d.filter((e) => e.code !== 'export_ok')))
    window.uniagent.listPresets().then(setPresets)
    window.uniagent.getAppSettings().then((settings) => {
      setAppConfig(settings)
      if (settings.autoCheckUpdate) {
        void appUpdateRequest.current.run(
          () => window.uniagent.checkAppUpdate(),
          setAppUpdate
        )
      }
    })
    window.uniagent.getPrefs().then(setPrefs)
    window.uniagent.listProjects().then(setProjects)
    window.uniagent.getAppVersion().then(setAppVersion)
    // 需求4 — pull the current bridge status and subscribe to install/connection
    // progress so the badge + wizard reflect the main process live.
    window.uniagent.feishuStatus().then(setFeishu).catch(() => {})
    const off = window.uniagent.onFeishuInstallProgress((status) => {
      setFeishu(status)
      if (!status.configuring) {
        window.uniagent.getAppSettings().then(setAppConfig)
      }
    })
    const offDiagnostic = window.uniagent.onDiagnostic((entry) => {
      if (entry.code !== 'export_ok') setDiag((current) => [entry, ...current.filter((item) => item.id !== entry.id)])
    })
    return () => {
      appUpdateRequest.current.invalidate()
      off()
      offDiagnostic()
    }
  }, [])

  useEffect(() => {
    window.uniagent.listRoles().then((next) => { setRoles(next); setRolesError('') }).catch(() => {
      setRoles([])
      setRolesError('角色读取失败，请重新打开设置后重试')
    })
  }, [agents])

  useEffect(() => {
    quotaMounted.current = true
    return () => { quotaMounted.current = false }
  }, [])

  // 控制台是查询失败时的回退入口，不影响支持原生额度查询的 Agent。
  useEffect(() => {
    if (category !== 'agent') return
    const targets = agents.filter(agent => agent.lifecycle?.availability === 'available' &&
      configuredAgentIds.includes(agent.id) && !quotaRequested.current.has(agent.id) &&
      !['nika', 'mcode', 'generic'].includes(agent.adapter))
    if (!targets.length) return
    for (const target of targets) quotaRequested.current.add(target.id)
    void Promise.allSettled(targets.map(async target => {
      const quota = await window.uniagent.getAgentQuota(target.id)
      if (!quotaMounted.current) return
      setQuotaByAgent(current => ({ ...current, [target.id]: quota }))
    }))
  }, [agents, category, configuredAgentIds])

  const appUpdateError = appUpdate?.error
  const pendingAgents = agents.filter(agent => agent.lifecycle?.detectionStatus === 'detecting')
  const detectingFallback = detecting && pendingAgents.length === 0
  const preparingAgents = detecting || pendingAgents.length > 0
  const installed = agents.filter((a) => a.lifecycle?.availability === 'available')
  const customCount = presets.filter((p) => !p.id.startsWith('builtin-')).length
  const updatableAgents = agents.filter((agent) =>
    agent.lifecycle?.availability === 'available' &&
    agent.lifecycle.updateStatus === 'available' &&
    agent.lifecycle.selfUpdateSupported !== false
  )

  async function handleSavePreset(p: HandoffPreset): Promise<void> {
    const next = await window.uniagent.savePreset(p)
    setPresets(next)
    window.dispatchEvent(new Event('uniagent-presets-changed'))
  }
  async function handleDeletePreset(id: string): Promise<void> {
    const next = await window.uniagent.deletePreset(id)
    setPresets(next)
    window.dispatchEvent(new Event('uniagent-presets-changed'))
  }
  async function handleSaveRole(role: AgentRole): Promise<void> {
    setRoles(await window.uniagent.saveRole(role))
    setRolesError('')
  }
  async function handleDeleteRole(id: string): Promise<void> {
    setRoles(await window.uniagent.deleteRole(id))
    setRolesError('')
  }
  async function handleCopyDiag(ids?: string[]): Promise<void> {
    await window.uniagent.copyDiagnosticsReport(ids)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  async function handleRemoveDiag(ids: string[]): Promise<void> {
    if (!ids.length) return
    await window.uniagent.removeDiagnostics(ids)
    setDiag((current) => current.filter((entry) => !ids.includes(entry.id)))
    setSelectedDiagnostics((current) => current.filter((id) => !ids.includes(id)))
  }
  async function handleClearDiag(): Promise<void> {
    if (!window.confirm('确定清空全部诊断日志吗？')) return
    await window.uniagent.clearDiagnostics()
    setDiag([])
    setSelectedDiagnostics([])
  }
  async function patchAgentDefault(agentId: string, patch: AgentPref): Promise<void> {
    try {
      const next = await window.uniagent.setPrefs(agentId, patch)
      setPrefs(next)
      setPrefsError((old) => ({ ...old, [agentId]: '' }))
    } catch {
      setPrefsError((old) => ({ ...old, [agentId]: '默认配置保存失败，请重试' }))
    }
  }
  async function patchAgentEnabled(agentId: string, enabled: boolean): Promise<void> {
    const enabledIds = new Set(configuredAgentIds)
    if (enabled) enabledIds.add(agentId)
    else enabledIds.delete(agentId)
    const next = await window.uniagent.setAppSettings({ enabledAgentIds: [...enabledIds] })
    setAppConfig(next)
    onAgentEnabledChange?.(next.enabledAgentIds ?? [...DEFAULT_ENABLED_AGENT_IDS])
  }
  async function openQuotaConsole(agent: AgentDef): Promise<void> {
    const service = agent.adapter === 'zcode' ? (await window.uniagent.getZCodeConfiguration()).service : undefined
    const target = agentQuotaConsole(agent, agent.mcode?.region, service)
    if (!target) return
    await window.uniagent.openExternal(target.url)
  }
  async function handleDetectAgent(agentId: string): Promise<void> {
    if (redetectFlights.current.has(agentId)) return
    redetectFlights.current.add(agentId)
    setRedetectingAgents([...redetectFlights.current])
    try {
      const detected = await window.uniagent.detectAgent(agentId)
      onAgentsChanged(current => current.map(agent => agent.id === agentId ? detected : agent))
    } catch (error) {
      const detectionError = String(error).replace(/^Error:\s*/, '') || '检测请求失败，请重试。'
      onAgentsChanged(current => current.map(agent => agent.id === agentId ? {
        ...agent, lifecycle: { ...agent.lifecycle!, availability: 'unhealthy', detectionStatus: 'failed', detectionError }
      } : agent))
    } finally {
      redetectFlights.current.delete(agentId)
      setRedetectingAgents([...redetectFlights.current])
    }
  }
  async function handleCheckAppUpdate(): Promise<void> {
    setAppUpdateBusy(true)
    await appUpdateRequest.current.run(
      () => window.uniagent.checkAppUpdate(true),
      setAppUpdate,
      () => setAppUpdateBusy(false),
      () => setAppUpdate((previous) => ({
        currentVersion: previous?.currentVersion || appVersion,
        hasUpdate: false,
        releaseUrl: previous?.releaseUrl || APP_REPOSITORY,
        checkedAt: Date.now(),
        error: 'network'
      }))
    )
  }
  async function performAgentUpdate(agentId: string): Promise<'updated' | 'blocked' | 'failed'> {
    setBusyAgent(agentId)
    let outcome: 'updated' | 'blocked' | 'failed' = 'updated'
    try {
      await window.uniagent.updateAgent(agentId)
      setLifecycleError((old) => ({ ...old, [agentId]: '' }))
    } catch (error) {
      if (String(error).includes('active_session')) {
        outcome = 'blocked'
        setLifecycleError((old) => ({ ...old, [agentId]: '' }))
      } else {
        outcome = 'failed'
        setLifecycleError((old) => ({ ...old, [agentId]: String(error).replace(/^Error:\s*/, '') }))
      }
    }
    try {
      onAgentsChanged(await window.uniagent.getLifecycleSnapshot())
    } catch {
      setLifecycleError((old) => ({ ...old, [agentId]: old[agentId] || 'Agent 状态刷新失败，请重新探测' }))
    } finally {
      setBusyAgent(null)
    }
    return outcome
  }
  async function handleUpdate(agentId: string): Promise<void> {
    if (bulkUpdate) return
    if (await performAgentUpdate(agentId) === 'blocked') setUpdateBlocked(true)
  }
  async function handleUpdateAll(): Promise<void> {
    if (bulkUpdate || busyAgent || !updatableAgents.length) return
    const targetIds = updatableAgents.map((agent) => agent.id)
    let blocked = false
    setBulkUpdate({ current: 0, total: targetIds.length })
    try {
      await Promise.all(targetIds.map(async (agentId) => {
        if (await performAgentUpdate(agentId) === 'blocked') blocked = true
        setBulkUpdate((current) => current && ({ ...current, current: current.current + 1 }))
      }))
    } finally {
      setBulkUpdate(null)
      if (blocked) setUpdateBlocked(true)
    }
  }
  async function handleCheckAgentUpdate(agentId: string): Promise<void> {
    setCheckingAgent(agentId)
    try {
      await window.uniagent.checkAgentUpdate(agentId)
      onAgentsChanged(await window.uniagent.getLifecycleSnapshot())
      setLifecycleError((old) => ({ ...old, [agentId]: '' }))
    } catch {
      onAgentsChanged(await window.uniagent.getLifecycleSnapshot())
      setLifecycleError((old) => ({ ...old, [agentId]: '检查更新失败，请根据更新状态提示重试' }))
    } finally { setCheckingAgent(null) }
  }

  async function patchFeishu(patch: Record<string, unknown>): Promise<void> {
    const next = await window.uniagent.setAppSettings({ feishu: patch })
    setAppConfig(next)
    setFeishu(await window.uniagent.feishuStatus())
  }

  return (
    <div className="main-panel settings-panel">
      {/* 页内模式：返回箭头 + 「设置」；全窗模式：标题为分类名，与全窗页面面板同构。
          main-panel-head 提供窗口拖拽 & no-drag 命中区 */}
      {windowed ? (
        <div className="main-panel-head">
          <span className="main-panel-title">{SETTINGS_CATEGORIES.find((c) => c.id === category)?.label ?? ''}</span>
        </div>
      ) : (
        <div className="main-panel-head settings-head">
          <button className="settings-back" onClick={() => { if (sourceNavigationGuard.current?.() !== false) onBack() }} title="返回" aria-label="返回"><UiIcon name="back" size={15} /></button>
          <span className="main-panel-title">设置</span>
        </div>
      )}

      <div className="settings-inner">
        {/* 左侧分类导航（macOS 系统设置风格）— 一次只看一个分类；全窗模式不显示 */}
        {!windowed && (
        <nav className="set-nav">
          {SETTINGS_CATEGORIES.map((c) => (
            <button
              key={c.id}
              className={`set-nav-item ${category === c.id ? 'active' : ''}`}
              onClick={() => {
                if (c.id !== category && sourceNavigationGuard.current?.() === false) return
                setCategory(c.id)
                setDetailView(null)
                onCategoryChange?.(c.id)
              }}
            >
              <span className="ic"><UiIcon name={c.icon} /></span>
              <span className="lbl">{c.label}</span>
            </button>
          ))}
        </nav>
        )}

        {/* 右侧内容区：五个常规分类常驻（隐藏非激活项），自带滚动壳的页面面板按需挂载 */}
        <div className={`set-content ${isSettingsPagePanel(category) ? 'set-content-cap' : ''}`}>
          {/* ---- 通用：应用更新 / 通知 / 电源 / 文件浏览与审查 ---- */}
          <div className="set-page" hidden={category !== 'general'}>
            {!detailView ? (
              <>
                <SetGroup title="应用更新">
                  <SetRow
                    label={`${APP_NAME} 版本`}
                    sub={`当前 ${appVersion || '读取中…'}${appUpdate?.checkedAt ? ` · ${new Date(appUpdate.checkedAt).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 检查过` : ''}`}
                    control={<>
                      <span className="ver">v{appVersion || '—'}</span>
                      {appUpdate?.hasUpdate && appUpdate.latestVersion && <span className="txt-warn">可更新至 v{appUpdate.latestVersion}</span>}
                    </>}
                    onClick={() => setDetailView('update')}
                  />
                  <SetRow
                    label="自动检查更新"
                    sub={INTERNAL_DISTRIBUTION ? '启动时后台检查 Bits 版本目录' : '启动时后台检查 GitHub 公开版本'}
                    control={<ToggleSwitch checked={appConfig?.autoCheckUpdate ?? true} label="自动检查更新" onChange={(checked) => { void window.uniagent.setAppSettings({ autoCheckUpdate: checked }).then(setAppConfig) }} />}
                  />
                </SetGroup>
                <SetGroup title="通知">
                  <SetRow
                    label="桌面通知"
                    sub="任务完成、失败、提问或等待批准时发送 macOS 通知"
                    control={<SetSelect ariaLabel="桌面通知" value={appConfig?.notificationMode ?? 'unfocused'} onChange={(v) => { void window.uniagent.setAppSettings({ notificationMode: v as AppSettings['notificationMode'] }).then(setAppConfig) }}>
                      <option value="unfocused">离开 {APP_NAME} 时通知</option>
                      <option value="always">始终通知</option>
                      <option value="off">关闭通知</option>
                    </SetSelect>}
                  />
                </SetGroup>
                <SetGroup title="电源">
                  <SetRow
                    label="防止电脑休眠"
                    sub={`${APP_NAME} 运行期间阻止电脑自动休眠，屏幕仍可熄灭；关闭开关或退出应用后恢复。`}
                    control={<ToggleSwitch checked={appConfig?.preventSleep ?? false} label="防止电脑休眠" onChange={(checked) => { void window.uniagent.setAppSettings({ preventSleep: checked }).then(setAppConfig) }} />}
                  />
                </SetGroup>
                <SetGroup title="文件浏览与审查">
                  <SetRow
                    label="默认覆盖左侧侧栏"
                    sub="打开文件浏览器或代码审查时是否直接铺满整个窗口；关闭则保留左侧会话侧栏。可在标题栏按钮随时切换。"
                    control={<ToggleSwitch checked={appConfig?.coverSidebar ?? false} label="默认覆盖左侧侧栏" onChange={(checked) => { void window.uniagent.setAppSettings({ coverSidebar: checked }).then(setAppConfig) }} />}
                  />
                </SetGroup>
                <SetGroup title="诊断与日志">
                  <SetRow
                    icon={<UiIcon name="warn" size={15} />}
                    label="Session 导入错误"
                    sub="导入、预览、同 Agent 分叉及跨 Agent 迁移中的异常"
                    control={(() => {
                      const err = diag.filter((e) => e.category === 'session_import' && e.level === 'error').length
                      const warn = diag.filter((e) => e.category === 'session_import' && e.level === 'warn').length
                      return (
                        <>
                          {err > 0 && <span className="diag-stat err">{err} 错误</span>}
                          {warn > 0 && <span className="diag-stat warn">{warn} 警告</span>}
                        </>
                      )
                    })()}
                    onClick={() => { setLogFilter('all'); setSelectedDiagnostics([]); setDetailView('session_import') }}
                  />
                  <SetRow
                    icon={<UiIcon name="diagnostics" size={15} />}
                    label="App 运行错误日志"
                    sub="Agent、主进程、渲染、更新、飞书及能力同步异常"
                    control={(() => {
                      const err = diag.filter((e) => e.category === 'app_runtime' && e.level === 'error').length
                      const warn = diag.filter((e) => e.category === 'app_runtime' && e.level === 'warn').length
                      return (
                        <>
                          {err > 0 && <span className="diag-stat err">{err} 错误</span>}
                          {warn > 0 && <span className="diag-stat warn">{warn} 警告</span>}
                        </>
                      )
                    })()}
                    onClick={() => { setLogFilter('all'); setSelectedDiagnostics([]); setDetailView('app_runtime') }}
                  />
                  <SetRow icon={<UiIcon name="diagnostics" size={15} />} label="工具能力排查日志"
                    sub="各 Agent 的工具扫描、读取来源与配置异常" control={<span>查看日志</span>}
                    onClick={() => setDetailView('capabilities_log')} />
                  <SetRow label="清空全部日志" sub={`当前共 ${diag.length} 条`} control={<button className="set-mini-btn danger" disabled={!diag.length} onClick={handleClearDiag}>清空全部</button>} />
                </SetGroup>
                {category === 'general' && <QueueWaitQuality key="queue-quality-summary" onOpen={() => setDetailView('queue_wait_quality')} />}
                <SetGroup title="侧栏快捷入口" action={<span className="set-shortcut-count">已选 {sidebarShortcuts.length} / {MAX_SIDEBAR_SHORTCUTS}</span>} pad>
                  <p className="set-shortcut-hint">选择要显示在左侧的功能，最多 {MAX_SIDEBAR_SHORTCUTS} 个；选择后自动保存。</p>
                  <div className="set-shortcut-options">
                    {SETTINGS_CATEGORIES.map(item => {
                      const checked = sidebarShortcuts.includes(item.id)
                      const disabled = !appConfig || shortcutSaving || (!checked && sidebarShortcuts.length >= MAX_SIDEBAR_SHORTCUTS)
                      return <label key={item.id} className={`set-shortcut-option${disabled ? ' is-disabled' : ''}`}>
                        <UiIcon name={item.icon} />
                        <span>{item.label}</span>
                        <input type="checkbox" checked={checked} disabled={disabled} onChange={() => void toggleSidebarShortcut(item.id)} />
                      </label>
                    })}
                  </div>
                  <p className="set-shortcut-hint" role="status">{shortcutError || (shortcutSaving ? '保存中…' : sidebarShortcuts.length >= MAX_SIDEBAR_SHORTCUTS ? '已选满 5 个，取消一项后可添加其它功能。' : '按设置菜单顺序显示；全部入口统一计入 5 个上限。')}</p>
                </SetGroup>
              </>
            ) : detailView === 'update' ? (
              <>
                <SetBackTop label="返回通用" onBack={() => setDetailView(null)}>
                  <div className="set-detail-title">
                    <div className="sdt-main">
                      <h2>应用更新</h2>
                      <div className="set-detail-sub">查看当前版本、更新通道与最近一次检查结果</div>
                    </div>
                  </div>
                </SetBackTop>
                <SetGroup title="当前状态">
                  <SetRow
                    label="已安装版本"
                    sub="Apple Silicon (arm64)"
                    control={<span className="ver">v{appVersion || '—'}</span>}
                  />
                  <SetRow
                    label="自动检查更新"
                    sub={INTERNAL_DISTRIBUTION ? '启动时后台检查 Bits 版本目录' : '启动时后台检查 GitHub 公开版本'}
                    control={<ToggleSwitch checked={appConfig?.autoCheckUpdate ?? true} label="自动检查更新" onChange={(checked) => { void window.uniagent.setAppSettings({ autoCheckUpdate: checked }).then(setAppConfig) }} />}
                  />
                </SetGroup>
                <div className="set-group">
                  <div className="set-group-t">检查结果</div>
                  {appUpdateError && appUpdateError !== 'no_release' ? (
                    <div className="update-alert">
                      <div className="update-alert-ic"><UiIcon name="warn" size={16} className="txt-warn" /></div>
                      <div className="update-alert-body">
                        <div className="update-alert-title">暂时无法检查更新</div>
                        <div className="update-alert-sub">{APP_UPDATE_ERROR_TEXT[appUpdateError] ?? '无法检查更新，请稍后重试或打开发布页查看。'}</div>
                        <div className="update-alert-actions">
                          <button className="set-mini-btn" onClick={() => void handleCheckAppUpdate()} disabled={appUpdateBusy}>
                            <UiIcon name="refresh" size={13} />{appUpdateBusy ? '检查中…' : '重试'}
                          </button>
                          <button className="set-mini-btn ghost" onClick={() => void window.uniagent.openExternal(appUpdate?.releaseUrl || APP_REPOSITORY)}>
                            <UiIcon name="external-link" size={13} />{INTERNAL_DISTRIBUTION ? '打开 Bits 仓库' : '打开 GitHub 发布页'}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : appUpdate?.hasUpdate ? (
                    <div className="update-alert">
                      <div className="update-alert-ic"><UiIcon name="arrow-down" size={16} className="txt-warn" /></div>
                      <div className="update-alert-body">
                        <div className="update-alert-title">发现新版本{appUpdate.latestVersion ? ` v${appUpdate.latestVersion}` : ''}</div>
                        <div className="update-alert-sub">{INTERNAL_DISTRIBUTION ? '从 Bits 下载最新 arm64 DMG 并手动覆盖安装。' : '从 GitHub 下载最新 arm64 DMG，替换 Applications 中的 UniAgent Public.app。'}</div>
                        <div className="update-alert-actions">
                          <button className="set-mini-btn" onClick={() => void window.uniagent.openExternal(appUpdate.downloadUrl || appUpdate.releaseUrl)}>
                            <UiIcon name="external-link" size={13} />下载 DMG
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="update-alert ok">
                      <div className="update-alert-ic"><UiIcon name="check" size={16} className="txt-ok" /></div>
                      <div className="update-alert-body">
                        <div className="update-alert-title">{appUpdateError === 'no_release' ? INTERNAL_DISTRIBUTION ? '当前 Bits 仓库尚未发布可下载版本' : '当前尚未发布可下载的公开版本' : '已是最新版本'}</div>
                        <div className="update-alert-sub">{appUpdate?.checkedAt ? `最近检查：${new Date(appUpdate.checkedAt).toLocaleString('zh-CN')}` : '尚未检查更新。'}</div>
                        <div className="update-alert-actions">
                          <button className="set-mini-btn" onClick={() => void handleCheckAppUpdate()} disabled={appUpdateBusy}>
                            <UiIcon name="refresh" size={13} />{appUpdateBusy ? '检查中…' : '立即检查'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </>
            ) : detailView === 'capabilities_log' ? (
              <AgentCapabilitiesPanel embedded logOnly agents={agents.filter(agent => agent.builtin)} onOpenSync={onOpenSync} onBack={() => setDetailView(null)} />
            ) : detailView === 'queue_wait_quality' ? (
              <QueueWaitQuality key="queue-quality-detail" detail onBack={() => setDetailView(null)} />
            ) : detailView === 'session_import' || detailView === 'app_runtime' ? (() => {
              const visibleRows = diag.filter((e) =>
                e.category === detailView && (logFilter === 'all' || e.level === logFilter)
              )
              const visibleIds = visibleRows.map((e) => e.id)
              const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedDiagnostics.includes(id))
              return (
              <>
                <div className="set-detail-top">
                  <button className="set-back" onClick={() => { setDetailView(null); setSelectedDiagnostics([]) }}>
                    <span className="set-caret"><UiIcon name="chevron-right" size={15} /></span>返回通用
                  </button>
                  <div className="set-detail-headrow">
                    <div className="set-detail-title">
                      <div className="sdt-main">
                        <h2>{detailView === 'session_import' ? 'Session 导入错误' : 'App 运行错误日志'}</h2>
                        <div className="set-detail-sub">错误与警告 · 可逐条或多选复制、删除</div>
                      </div>
                    </div>
                    <div className="set-detail-top-actions">
                      <span className="seg mini">
                        {(['all', 'error', 'warn'] as const).map((lv) => (
                          <button key={lv} className={`seg-btn ${logFilter === lv ? 'active' : ''}`} onClick={() => setLogFilter(lv)}>
                            {lv === 'all' ? '全部' : lv === 'error' ? '错误' : '警告'}
                          </button>
                        ))}
                      </span>
                      <button
                        className={`set-mini-btn ${allSelected ? 'on' : ''}`}
                        onClick={() => setSelectedDiagnostics((current) =>
                          allSelected
                            ? current.filter((id) => !visibleIds.includes(id))
                            : Array.from(new Set([...current, ...visibleIds]))
                        )}
                        disabled={visibleIds.length === 0}
                      >
                        {allSelected ? '取消全选' : '全选'}
                      </button>
                    </div>
                  </div>
                </div>
                {selectedDiagnostics.length > 0 && (
                  <div className="diag-selection-bar">
                    已选择 {selectedDiagnostics.length} 条
                    <span className="diag-selection-grow" />
                    <button className="set-mini-btn" onClick={() => void handleCopyDiag(selectedDiagnostics)}>复制所选</button>
                    <button className="set-mini-btn danger" onClick={() => {
                      if (window.confirm(`确定删除所选 ${selectedDiagnostics.length} 条日志吗？`)) void handleRemoveDiag(selectedDiagnostics)
                    }}>删除所选</button>
                  </div>
                )}
                <SetGroup>
                  {(() => {
                    const rows = visibleRows
                    if (rows.length === 0) return <div className="set-empty">暂无{logFilter === 'all' ? '' : logFilter === 'error' ? '错误' : '警告'}记录 — 目前没有遇到未处理的数据 👍</div>
                    return (
                      <div className="log-card">
                        {rows.map((e) => {
                          const selected = selectedDiagnostics.includes(e.id)
                          return (
                          <div key={e.id} className={`log-row ${e.level === 'error' ? 'err' : e.level === 'warn' ? 'warn' : ''}${selected ? ' sel' : ''}`}>
                            <label className="log-ck">
                              <input
                                type="checkbox"
                                aria-label={`选择 ${e.code}`}
                                checked={selected}
                                onChange={(event) => setSelectedDiagnostics((current) =>
                                  event.target.checked ? [...current, e.id] : current.filter((id) => id !== e.id)
                                )}
                              />
                              <span className="log-ck-box"><UiIcon name="check" size={11} /></span>
                            </label>
                            <span className={`log-lv ${e.level === 'error' ? 'err' : e.level === 'warn' ? 'warn' : ''}`}>{e.level === 'error' ? 'ERROR' : e.level === 'warn' ? 'WARN' : 'INFO'}</span>
                            <span className="log-time">{new Date(e.ts).toLocaleTimeString()}</span>
                            <span className="log-msg">
                              {e.code} · {e.message}{e.count > 1 ? ` ×${e.count}` : ''}
                              {e.sample && <details className="log-details"><summary>查看详情</summary><pre>{e.sample}</pre></details>}
                            </span>
                            <span className="log-agent">{e.source}</span>
                            <span className="log-row-actions">
                              <button className="log-icon-btn" title="复制" aria-label="复制" onClick={() => void handleCopyDiag([e.id])}><UiIcon name="copy" size={13} /></button>
                              <button className="log-icon-btn danger" title="删除" aria-label="删除" onClick={() => void handleRemoveDiag([e.id])}><UiIcon name="trash" size={13} /></button>
                            </span>
                          </div>
                          )
                        })}
                      </div>
                    )
                  })()}
                </SetGroup>
              </>
              )
            })() : null}
          </div>

          {category === 'assistants' && <div className="set-page">
            <div className="assistant-page-tabs" role="tablist" aria-label="飞书与助手页面">
              {([['config', '个人助手'], ['feishu', 'session飞书管理']] as const).map(([page, label]) => (
                <button key={page} type="button" role="tab" aria-selected={assistantPage === page} className={assistantPage === page ? 'active' : ''} onClick={() => {
                  if (page !== assistantPage && sourceNavigationGuard.current?.() === false) return
                  setAssistantPage(page)
                }}>{label}</button>
              ))}
            </div>
            <p className="assistant-hint">{assistantPage === 'config' ? '配置助手身份、工作规则和长期记忆；可在 App 中使用，也可绑定专属飞书机器人对话。' : '将普通会话（session）接入飞书，在私聊或群聊话题中远程操作 Agent，并接收会话进展和结果通知。'}</p>
            {assistantPage === 'config' ? <AssistantSettings agents={agents} navigationGuard={sourceNavigationGuard} /> : <FeishuSection
              agents={agents}
              projects={projects}
              config={appConfig?.feishu}
              status={feishu}
              onStatus={setFeishu}
              onPatch={patchFeishu}
            />}
          </div>}
          {category === 'codex-sources' && <div className="set-page"><CodexModelSettings navigationGuard={sourceNavigationGuard} onModelsChanged={async () => onAgentsChanged(await window.uniagent.getLifecycleSnapshot())} /></div>}
          
          {category === 'teams' && <div className="set-page">{teamError && <p className="team-error">{teamError}</p>}<TeamManagement kind="teams" initialTeamId={detailView || undefined} teams={teams} agents={agents} spaces={projects} onChanged={refreshTeams} /></div>}
          {category === 'requirements'  && <div className="set-page"><RequirementSettings
            enabled={appConfig?.requirementsEnabled === true}
            onToggle={(checked) => {
              void window.uniagent.setAppSettings({ requirementsEnabled: checked }).then(setAppConfig).then(() => onRequirementsEnabledChange?.(checked))
            }}
          /></div>}
          <div className="set-page" hidden={category !== 'projects'}>
            <ProjectSettings projects={projects} onProjectsChange={setProjects} onOpenSession={onOpenSession} />
          </div>

          {/* ---- Agent：CLI 状态（主页面） / 单 Agent 详情 ---- */}
          <div className="set-page" hidden={category !== 'agent'}>
            {(() => {
              const detailAgent = installed.find((a) => a.id === detailView) || agents.find((a) => a.id === detailView)
              if (detailView && detailAgent) {
                const a = detailAgent
                // 全量「重新探测」同样覆盖当前 Agent：详情页忙碌态并入全局 detecting，避免按钮显示空闲却触发并发检测
                const retrying = detectingFallback || redetectingAgents.includes(a.id) || a.lifecycle?.detectionStatus === 'detecting'
                const progress = agentDetectionProgress(a)
                const detectionError = !retrying && a.lifecycle?.detectionStatus === 'failed' ? a.lifecycle.detectionError || '检测失败，请重试。' : ''
                const detectionCopy = kimiErrorCopy(detectionError)
                const detectionText = detectionError ? detectionCopy?.hint || detectionError : ''
                const runtimeStatus = retrying ? { label: progress.label, tone: 'off' } : detectionError ? { label: '检测失败', tone: 'warn' } : agentRuntimeStatus(a)
                const updateAvailable = a.lifecycle?.updateStatus === 'available' && a.lifecycle.selfUpdateSupported !== false
                const updating = busyAgent === a.id || a.lifecycle?.updateStatus === 'updating'
                const checkingUpdate = checkingAgent === a.id
                const updateStatus = checkingUpdate
                  ? { label: '检查中', tone: 'off' }
                  : agentUpdateStatus(a)
                const pref = prefs?.lastByAgent[a.id]
                const effectiveModel = resolveAgentModel(a, pref?.defaultModel)
                const defaultModel = effectiveModel?.id || ''
                const nativeThinking = a.adapter === 'kimi' || a.adapter === 'zcode'
                const efforts = nativeThinking ? effectiveModel?.thinkingOptions || [] : effectiveModel?.efforts || []
                const defaultEffort = (nativeThinking ? resolveModelThinking(effectiveModel, pref?.defaultThinking, pref?.defaultEffort) : resolveModelEffort(effectiveModel, pref?.defaultEffort)) || ''
                const installation = (
                    <SetGroup
                      title="安装信息"
                      action={
                        <button className="set-mini-btn" onClick={() => void handleDetectAgent(a.id)} disabled={retrying || updating}>
                          <RefreshIcon size={12} className={retrying ? 'is-spinning' : ''} />{retrying ? progress.label : detectionError ? '重试' : '刷新状态'}
                        </button>
                      }
                    >
                      {a.bin && <SetRow label="可执行路径" sub={<code className="set-code set-code-path">{a.bin}</code>} />}
                      <SetRow
                        label="版本"
                        control={<>
                          <span className="ver">{agentVersionLabel(a)}</span>
                          {updating ? <>
                            {a.lifecycle?.availableVersion && <><span className="ver">→</span><span className="ver txt-warn">{agentVersionLabel(a, true)}</span></>}
                            <button className="set-mini-btn" disabled><RefreshIcon size={13} className="is-spinning" />更新中…</button>
                          </> : updateAvailable ? <>
                            <span className="ver">→</span>
                            <span className="ver txt-warn">{agentVersionLabel(a, true)}</span>
                            <button className="set-mini-btn" onClick={() => void handleUpdate(a.id)} disabled={retrying || bulkUpdate !== null || busyAgent === a.id}>更新</button>
                          </> : a.lifecycle?.selfUpdateSupported !== false ? (
                            <button className="set-mini-btn" onClick={() => void handleCheckAgentUpdate(a.id)} disabled={retrying || bulkUpdate !== null || checkingUpdate || busyAgent === a.id}>
                              <RefreshIcon size={13} className={checkingUpdate ? 'is-spinning' : ''} />
                              {checkingUpdate ? '检查中…' : a.lifecycle?.updateStatus === 'failed' ? '重试检查' : '检查更新'}
                            </button>
                          ) : null}
                        </>}
                      />
                      <SetRow
                        label="运行状态"
                        sub={retrying ? progress.text : detectionText || a.lifecycle?.message}
                        control={<span className={`status-pill${retrying ? ' settings-agent-progress' : ''}`} role={retrying ? 'status' : undefined}>{retrying ? <RefreshIcon size={12} className="is-spinning" /> : <span className={`dot ${runtimeStatus.tone}`} />}<span className={`txt-${runtimeStatus.tone}`}>{runtimeStatus.label}</span></span>}
                      />
                      <SetRow
                        label="更新状态"
                        sub={agentUpdateStatusSub(a)}
                        control={ <span className="status-pill"><span className={`dot ${updateStatus.tone}`} /><span className={`txt-${updateStatus.tone}`}>{updateStatus.label}</span></span>}
                      />
                      {!retrying && a.adapter === 'generic' && (a.lifecycle?.availability === 'needs-auth' || a.lifecycle?.availability === 'unhealthy') && (
                        <SetRow
                          label={a.lifecycle?.availability === 'needs-auth' ? '登录状态' : '运行状态'}
                          sub="按官方教程完成配置后即可使用该 Agent · 登录后会自动刷新"
                          control={<>
                            <button className="set-mini-btn" onClick={() => void handleDetectAgent(a.id)} disabled={retrying || updating}>
                              <RefreshIcon size={13} className={retrying ? 'is-spinning' : ''} />{retrying ? '检测中…' : '刷新状态'}
                            </button>
                            <button className="set-mini-btn" onClick={() => onInitialize(a.id)} disabled={!installed.length}>{a.lifecycle?.availability === 'needs-auth' ? '继续配置' : '重新配置'}</button>
                          </>}
                        />
                      )}
                    </SetGroup>
                )
                const defaultParameters = (
                    <SetGroup title="该 Agent 默认参数">
                      <SetRow
                        label="默认模型"
                        control={<SetSelect ariaLabel="默认模型" value={defaultModel} disabled={retrying || !prefs || !a.capabilities.modelSelect || a.models.length === 0} onChange={(v) => {
                          const model = resolveAgentModel(a, v)
                          void patchAgentDefault(a.id, { defaultModel: model?.id,
                            defaultEffort: nativeThinking ? undefined : resolveModelEffort(model, pref?.defaultEffort),
                            defaultThinking: nativeThinking ? resolveModelThinking(model, pref?.defaultThinking, pref?.defaultEffort) : undefined })
                        }}>
                          {a.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                        </SetSelect>}
                      />
                      <SetRow
                        label={nativeThinking ? '默认思考级别' : '默认推理强度'}
                        control={<SetSelect ariaLabel={nativeThinking ? '默认思考级别' : '默认推理强度'} value={defaultEffort} disabled={retrying || !prefs || (!nativeThinking && !a.capabilities.reasoningEffort) || efforts.length === 0} onChange={(v) => void patchAgentDefault(a.id, nativeThinking ? { defaultThinking: v } : { defaultEffort: v as ReasoningEffort })}>
                          {efforts.map((e) => <option key={e} value={e}>{EFFORT_LABEL[e] ?? e}</option>)}
                        </SetSelect>}
                      />
                    </SetGroup>
                )
                return (
                  <>
                    <SetBackTop label="返回 Agent" onBack={() => setDetailView(null)}>
                      <div className="set-detail-title">
                        <span className="agent-ic lg"><AgentIcon agentId={a.id} adapter={a.adapter} size={20} /></span>
                        <div className="sdt-main">
                          <div className="agent-detail-name"><h2>{a.name}</h2><AgentBetaBadge agentId={a.id} /></div>
                          <div className="set-detail-sub">{ `${a.adapter} · 命令行驱动`}</div>
                        </div>
                      </div>
                    </SetBackTop>
                    {retrying && <div className="settings-agent-pending" aria-busy="true">{installation}{(a.lifecycle?.availability === 'available' || a.lifecycle?.lastReadyAt) && defaultParameters}</div>}
                    <div hidden={retrying}>
                    { isCliSetupId(a.id) ? <CliAgentSettings key={a.id} agent={a} onRedetect={() => handleDetectAgent(a.id)} installation={installation} defaultParameters={defaultParameters} onOpenModels={() => setCategory('codex-sources')} /> : a.adapter === 'deepseek' ? <DeepSeekSettings agent={a} onRedetect={() => handleDetectAgent(a.id)} installation={installation} defaultParameters={defaultParameters} /> : a.adapter === 'mcode' ? <MCodeSettings agent={a} onRedetect={() => handleDetectAgent(a.id)} installation={installation} defaultParameters={defaultParameters} /> : a.adapter === 'zcode' ?
                      <ZCodeSettings agent={a} onRedetect={() => handleDetectAgent(a.id)}>
                        {(present, ready) => <>{installation}{!ready && <ZCodeConfigurationGroup onRedetect={() => window.uniagent.getLifecycleSnapshot().then(onAgentsChanged)} disabled={!present} />}{ready && defaultParameters}</>}
                      </ZCodeSettings> : a.adapter === 'kimi' ? <KimiSettings agent={a} installation={installation} defaultParameters={defaultParameters} /> : <>
                      {installation}
                      {defaultParameters}
                    </>}
                    {a.adapter === 'codex' && (a.lifecycle?.availability === 'available' || a.lifecycle?.lastReadyAt) && <CodexQuotaGroup />}
                    </div>
                    {!retrying && prefsError[a.id] && <div className="settings-cli-error">{prefsError[a.id]}</div>}
                    {!retrying && lifecycleError[a.id] && <div className="settings-cli-error">{lifecycleError[a.id]}</div>}
                  </>
                )
              }
              const notInstalled = agents.filter((a) => a.lifecycle?.availability === 'not-installed' && !a.lifecycle.detectionStatus && !redetectingAgents.includes(a.id))
              return (
                <>
                  <div className="set-group">
                    <div className="set-group-t" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span className="settings-agent-heading"><span>CLI 状态</span>{preparingAgents && <small>正在准备 Agent，已就绪的 Agent 可正常使用</small>}</span>
                      <span className="settings-agent-actions">
                        {(bulkUpdate || updatableAgents.length > 0) && (
                          <button className="set-mini-btn primary" onClick={() => void handleUpdateAll()} disabled={preparingAgents || bulkUpdate !== null || busyAgent !== null}>
                            {bulkUpdate
                              ? <><RefreshIcon size={12} className="is-spinning" />{`更新中 ${bulkUpdate.current}/${bulkUpdate.total}…`}</>
                              : <><UiIcon name="arrow-down" size={13} />{`更新全部（${updatableAgents.length}）`}</>}
                          </button>
                        )}
                        <button className="set-mini-btn" onClick={() => void onRedetect()} disabled={preparingAgents || bulkUpdate !== null}>
                          <RefreshIcon size={12} className={preparingAgents ? 'is-spinning' : ''} />{preparingAgents ? '检测中…' : '重新探测'}
                        </button>
                      </span>
                    </div>
                    <div className="set-card">
                      {agents.filter((a) => !notInstalled.includes(a)).map((a) => {
                        const retrying = detectingFallback || redetectingAgents.includes(a.id) || a.lifecycle?.detectionStatus === 'detecting'
                        const progress = agentDetectionProgress(a)
                        const detectionError = !retrying && a.lifecycle?.detectionStatus === 'failed' ? a.lifecycle.detectionError || '检测失败，请重试。' : ''
                        const detectionText = detectionError ? kimiErrorCopy(detectionError)?.hint || detectionError : ''
                        const st = retrying ? { label: progress.label, tone: 'off' } : detectionError ? { label: '检测失败', tone: 'warn' } : agentExternalStatus(a)
                        const canConfigure = a.lifecycle?.availability === 'needs-auth' || a.lifecycle?.availability === 'unhealthy'
                        const enabled = configuredAgentIds.includes(a.id)
                        const quota = quotaByAgent[a.id]
                        const remaining = quotaRemainingWindow(quota)
                        const quotaTarget = remaining ? null : agentQuotaConsole(a)
                        const quotaHint = [quotaSummaryText(quota), quota?.stale ? '额度刷新失败，显示上次结果' : ''].filter(Boolean).join(' · ')
                        const quotaTone = remaining && (remaining.remainPercent <= 5 ? 'danger' : remaining.remainPercent <= 20 ? 'warn' : 'ok')
                        const version = a.lifecycle?.currentVersion || a.version || ''
                        const subText = [version, canConfigure ? '待配置' : ''].filter(Boolean).join(' · ') || '已安装'
                        return (
                          <div key={a.id} className="row rowlink settings-agent-row" aria-busy={retrying} onClick={() => setDetailView(a.id)}>
                            <button type="button" className="settings-agent-open" aria-label={`查看 ${a.name} 详情`}>
                              <span className="agent-ic"><AgentIcon agentId={a.id} adapter={a.adapter} size={15} /></span>
                              <span className="r-main">
                                <span className="r-label">{a.name}<AgentBetaBadge agentId={a.id} /></span>
                                <span className={`r-sub${!retrying && detectionError ? ' settings-agent-error' : ''}`}>
                                  {retrying ? progress.text : detectionText || subText}
                                </span>
                              </span>
                            </button>
                            <span className="r-control settings-agent-controls">
                              {detectionError && <button
                                type="button" className="set-mini-btn primary" aria-label={`重试检测 ${a.name}`}
                                disabled={busyAgent === a.id || a.lifecycle?.updateStatus === 'updating'}
                                onClick={event => { event.stopPropagation(); void handleDetectAgent(a.id) }}
                              ><RefreshIcon size={12} />重试</button>}
                              <span className={`settings-agent-quota${quotaTone ? ` ${quotaTone}` : ''}`}>
                                {remaining ? <span className="settings-agent-meter" role="progressbar"
                                  aria-label={`${a.name} 剩余额度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining.remainPercent}
                                  title={`${remaining.label} · ${quotaHint}`}>
                                  <span className="settings-agent-quota-bar"><i style={{ width: `${remaining.remainPercent}%` }} /></span>
                                  <span className="settings-agent-quota-percent">{Math.round(remaining.remainPercent)}%</span>
                                </span> : quotaTarget ? <button
                                  type="button" className="set-mini-btn settings-agent-console" aria-label={quotaTarget.ariaLabel}
                                  title={[quotaHint, '在浏览器中查看额度'].filter(Boolean).join(' · ')}
                                  onClick={event => { event.stopPropagation(); void openQuotaConsole(a).catch(() => {}) }}
                                >{quotaTarget.label}<UiIcon name="external-link" size={11} /></button>
                                  : <span className="settings-agent-quota-empty" title={quotaHint || '暂无可用的额度数据'}>—</span>}
                              </span>
                              <span className={`status-pill settings-agent-status${retrying ? ' settings-agent-progress' : ''}`} title={st.label} role={retrying ? 'status' : undefined}>{retrying ? <RefreshIcon size={12} className="is-spinning" /> : <span className={`dot ${st.tone}`} />}<span className={`txt-${st.tone}`}>{st.label}</span></span>
                              <span className="settings-agent-toggle" onClick={(event) => event.stopPropagation()}>
                                <ToggleSwitch checked={enabled} label={`启用 ${a.name}`} onChange={(checked) => { void patchAgentEnabled(a.id, checked) }} />
                              </span>
                              <span className="set-caret"><UiIcon name="chevron-right" size={16} /></span>
                            </span>
                          </div>
                        )
                      })}
                      {notInstalled.map((a) => {
                        const enabled = configuredAgentIds.includes(a.id)
                        // Managed CLIs ship their own installer; their detail view
                        // is the only place the full setup flow lives.
                        const managedSetup = isCliSetupId(a.id) || ['deepseek', 'kimi', 'zcode', 'mcode', 'nika'].includes(a.adapter)
                        return (
                          <SetRow
                            key={a.id}
                            icon={<span className="agent-ic" style={{ opacity: .5 }}><AgentIcon agentId={a.id} adapter={a.adapter} size={15} /></span>}
                            label={<>{a.name}<AgentBetaBadge agentId={a.id} /></>}
                            control={<span className="settings-agent-controls">
                              <span className="settings-agent-quota"><button className="set-mini-btn" onClick={() => managedSetup ? setDetailView(a.id) : onInitialize(a.id)} disabled={!managedSetup && !installed.length}>{managedSetup ? '配置与安装' : '初始化'}</button></span>
                              <span className="status-pill settings-agent-status"><span className="dot off" /><span className="txt-off">未安装</span></span>
                              <ToggleSwitch checked={enabled} label={`启用 ${a.name}`} onChange={(checked) => { void patchAgentEnabled(a.id, checked) }} />
                              <span className="settings-agent-caret-spacer" aria-hidden="true" />
                            </span>}
                          />
                        )
                      })}
                    </div>
                  </div>
                  <SetGroup title="默认配置">
                    <SetRow
                      label="启动时自动更新 Agent CLI"
                      sub="仅更新已确认存在新版本且支持无人值守更新的 Agent（默认关闭）"
                      control={<ToggleSwitch checked={appConfig?.autoUpdateAgentsOnLaunch || false} label="启动时自动更新 Agent CLI" onChange={(checked) => { void window.uniagent.setAppSettings({ autoUpdateAgentsOnLaunch: checked }).then(setAppConfig) }} />}
                    />
                    <div style={{ borderTop: '1px solid var(--border-soft)', margin: '0 15px' }} />
                    <SetRow
                      label="闲时自动更新 Agent CLI"
                      sub="无任务运行或排队连续 5 分钟时，检查并更新已启用的 Agent（默认关闭）"
                      control={<ToggleSwitch checked={appConfig?.autoUpdateAgentsWhenIdle || false} label="闲时自动更新 Agent CLI" onChange={(checked) => { void window.uniagent.setAppSettings({ autoUpdateAgentsWhenIdle: checked }).then(setAppConfig) }} />}
                    />
                  </SetGroup>
                </>
              )
            })()}
          </div>

          {/* ---- 角色（独立于任务模板；列表 rowlink → 详情编辑器） ---- */}
          <div className="set-page" hidden={category !== 'roles'}>
            {(() => {
              const roleDetailId = detailView?.startsWith('role:') ? detailView.slice(5) : null
              if (roleDetailId) {
                const entry = roleDetailId === 'new'
                  ? null
                  : roles.find((item) => item.role.id === roleDetailId) || null
                if (roleDetailId === 'new' || entry) {
                  const defaultAgent = installed[0] || agents[0]
                  const defaultPermission = defaultAgent?.capabilities.permissionModes[0]?.id || 'read-only'
                  return (
                    <RoleDetail
                      key={detailView}
                      agents={agents}
                      projects={projects}
                      entry={entry}
                      role={entry?.role || {
                        id: '',
                        name: '',
                        agentId: defaultAgent?.id || '',
                        permissionMode: defaultPermission
                      }}
                      onBack={() => setDetailView(null)}
                      onSave={async (role) => { await handleSaveRole(role); setDetailView(null) }}
                      onDelete={entry ? async () => { await handleDeleteRole(entry.role.id); setDetailView(null) } : undefined}
                    />
                  )
                }
              }
              return (
                <>
                  <div className="set-detail-top set-role-list-head">
                    <div className="set-detail-title">
                      <div className="sdt-main">
                        <h2>角色</h2>
                        <div className="set-detail-sub">定义可被其它 Agent 通过 MCP 枚举并调用的执行画像</div>
                      </div>
                      <button className="set-add-btn" onClick={() => setDetailView('role:new')}><UiIcon name="plus" size={13} />添加角色</button>
                    </div>
                  </div>
                  <SetGroup title={`已配置 · ${roles.length}`}>
                    {roles.length === 0 ? (
                      <div className="set-empty">{rolesError || '暂无角色 — 点击「添加角色」创建第一个。'}</div>
                    ) : roles.map((entry) => {
                      const role = entry.role
                      const roleAgent = agents.find((item) => item.id === role.agentId)
                      const modelLabel = roleAgent?.models.find((item) => item.id === role.model)?.label || role.model || '默认模型'
                      const permissionLabel = roleAgent?.capabilities.permissionModes.find((item) => item.id === role.permissionMode)?.label || role.permissionMode
                      const skillsLabel = role.skills === undefined
                        ? '全部 Skills'
                        : role.skills.length === 0 ? '禁用 Skills' : `仅 ${role.skills.length} 个 Skills`
                      const toolsLabel = !role.toolPolicy
                        ? '继承工具'
                        : role.toolPolicy.mode === 'allow-only' && role.toolPolicy.tools.length === 0
                          ? '禁用全部工具'
                          : `${role.toolPolicy.mode === 'allow-only' ? '仅允许' : '禁止'} ${role.toolPolicy.tools.length} 个工具`
                      return (
                        <SetRow
                          key={role.id}
                          icon={
                            <span
                              className="set-role-avatar"
                              role="img"
                              aria-label={`角色 ${role.name} 标识`}
                            >
                              {roleAvatarLabel(role.name)}
                            </span>
                          }
                          label={role.name}
                          sub={<>
                            {agentName(agents, role.agentId)} · {modelLabel}{role.kimiThinking || role.zcodeThinking || role.effort ? ` · ${EFFORT_LABEL[role.kimiThinking || role.zcodeThinking || role.effort!] || role.kimiThinking || role.zcodeThinking || role.effort}` : ''} · {permissionLabel}
                            <br />
                            {role.projectId ? projects.find((project) => project.id === role.projectId)?.name || '空间不可用' : '跟随调用方空间'} · {skillsLabel} · {toolsLabel}
                            {!entry.executable && entry.unavailableReason && <><br /><span className="txt-warn">{entry.unavailableReason}</span></>}
                          </>}
                          control={<span className="status-pill"><span className={`dot ${entry.executable ? 'ok' : 'warn'}`} /><span className={`txt-${entry.executable ? 'ok' : 'warn'}`}>{entry.executable ? '可调用' : '不可调用'}</span></span>}
                          ariaLabel={`编辑角色 ${role.name}`}
                          onClick={() => setDetailView(`role:${role.id}`)}
                        />
                      )
                    })}
                  </SetGroup>
                </>
              )
            })()}
          </div>

          {/* ---- 页面面板分类（工具能力 / 导入会话 / Token 消耗 / 定时任务）：
               从设置页内侧栏打开时嵌入内容区展示，按需挂载复用现有组件 ---- */}
          <div className="set-page set-page-cap" hidden={!isSettingsPagePanel(category)}>
            {category === 'capabilities' && <AgentCapabilitiesPanel embedded agents={agents.filter(agent => agent.builtin)} onOpenSync={onOpenSync} />}
            {category === 'history' && (
              <ResumePanel
                embedded
                agents={agents.filter((a) => a.lifecycle?.availability === 'available')}
                e2eFixtures={e2eFixtures}
                onForkSame={onForkSame}
                onImport={onImport}
                onForkCross={onForkCross}
              />
            )}
            {category === 'tokens' && <TokenUsagePanel embedded />}
            {category === 'automations' && <AutomationsPanel embedded onOpenSession={onOpenSession} />}
          </div>

          {/* ---- 任务模板（主列表 rowlink → 详情编辑器，对齐 mockup） ---- */}
          <div className="set-page" hidden={category !== 'presets'}>
            {(() => {
              // detailView：'new' = 新建；其它 = 编辑对应 preset.id；null = 主列表。
              if (detailView) {
                const target = detailView === 'new' ? null : presets.find((p) => p.id === detailView) || null
                if (detailView === 'new' || target) {
                  return (
                    <PresetDetail
                      key={detailView}
                      agents={agents}
                      preset={target || { id: '', name: '', prompt: '' }}
                      onBack={() => setDetailView(null)}
                      onSave={async (p) => { await handleSavePreset(p); setDetailView(null) }}
                      onDelete={target && !target.id.startsWith('builtin-') ? async () => { await handleDeletePreset(target.id); setDetailView(null) } : undefined}
                    />
                  )
                }
              }
              return (
                <>
                  <SetGroup
                    title={`任务模板 · 共 ${presets.length} 个（${presets.length - customCount} 内置 · ${customCount} 自定义）`}
                    action={<button className="set-add-btn" onClick={() => setDetailView('new')}><UiIcon name="plus" size={13} />添加</button>}
                  >
                    {presets.length === 0 ? (
                      <div className="set-empty">暂无任务模板 — 点击右上角「添加」创建第一个。</div>
                    ) : (
                      presets.map((p) => {
                        const builtin = p.id.startsWith('builtin-')
                        const bits = [agentName(agents, p.agentId)]
                        if (p.model) bits.push(p.model)
                        if (p.effort) bits.push(EFFORT_LABEL[p.effort] || p.effort)
                        if (p.permissionMode) bits.push(p.permissionMode)
                        return (
                          <SetRow
                            key={p.id}
                            label={<>{p.name}<span className={`auto-badge ${builtin ? 'kind' : 'paused'}`}>{builtin ? '内置' : '自定义'}</span></>}
                            sub={bits.join(' · ')}
                            onClick={() => setDetailView(p.id)}
                          />
                        )
                      })
                    )}
                  </SetGroup>
                </>
              )
            })()}
          </div>
        </div>
      </div>
      {updateBlocked && (
        <div className="lifecycle-progress-toast rewind-warning-toast" role="alertdialog" aria-label="更新提示" aria-live="assertive">
          <span>该 Agent 有会话正在运行，请在其空闲后再更新</span>
          <button autoFocus onClick={() => setUpdateBlocked(false)}>确认</button>
        </div>
      )}
    </div>
  )
}

function agentName(agents: AgentDef[], id?: string): string {
  if (!id) return '继承会话'
  return agents.find((a) => a.id === id)?.name || id
}

function ProjectSettings({
  projects,
  onProjectsChange,
  onOpenSession
}: {
  projects: Project[]
  onProjectsChange: (projects: Project[]) => void
  onOpenSession?: (id: string) => void
}): JSX.Element {
  const [editing, setEditing] = useState<Project | 'new' | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [error, setError] = useState('')

  async function remove(project: Project): Promise<void> {
    if (!window.confirm(`确定删除空间「${project.name}」吗？\n\n该空间下的所有会话会移动到默认空间，磁盘文件不会被删除。`)) return
    setError('')
    try {
      onProjectsChange(await window.uniagent.deleteProject(project.id))
      window.dispatchEvent(new Event('uniagent-projects-changed'))
    } catch (reason) {
      setError(String(reason).includes('project_has_active_sessions')
        ? '空间仍有运行中的会话，请等待会话结束后再删除。'
        : reason instanceof Error ? reason.message : String(reason))
    }
  }

  return (
    <>
      <SetGroup
        title={`空间 · 共 ${projects.length} 个`}
        action={<button className="set-add-btn" onClick={() => setEditing('new')}><UiIcon name="plus" size={13} />新建空间</button>}
      >
        {projects.map((project) => (
          <div className="project-settings-item" key={project.id}>
          <div className="project-settings-row">
            <div className="project-settings-icon"><UiIcon name="folder" size={17} /></div>
            <div className="project-settings-main">
              <div className="r-label">{project.name}{project.isDefault && <span className="auto-badge kind">默认</span>}</div>
              <div className="r-sub" title={[project.primaryDirectory, ...project.additionalDirectories].join('\n')}>
                {project.primaryDirectory}{project.additionalDirectories.length ? ` · 另有 ${project.additionalDirectories.length} 个目录` : ''}
              </div>
            </div>
            <div className="project-settings-actions">
              <button className="set-mini-btn ghost" aria-expanded={expanded === project.id} onClick={() => setExpanded(expanded === project.id ? null : project.id)}><UiIcon name="fork" size={13} />工作树<UiIcon name={expanded === project.id ? 'chevron-down' : 'chevron-right'} size={13} /></button>
              {!project.isDefault && <>
              <button className="set-mini-btn ghost" onClick={() => setEditing(project)}><UiIcon name="edit" size={13} />编辑</button>
              <button className="set-mini-btn danger" onClick={() => void remove(project)}><UiIcon name="trash" size={13} />删除</button>
              </>}
            </div>
          </div>
          {expanded === project.id && <ProjectWorktrees project={project} onOpenSession={onOpenSession} />}
          </div>
        ))}
      </SetGroup>
      <div className="set-detail-sub">每个空间包含一个主目录和可选的附加目录。新会话只选择空间，由 Agent 按各自方式加载目录。</div>
      {error && <div className="update-alert" role="alert"><span className="update-alert-ic"><UiIcon name="warn" size={16} /></span><div className="update-alert-body"><div className="update-alert-sub">{error}</div></div></div>}
      {editing && <ProjectEditorDialog
        project={editing === 'new' ? undefined : editing}
        onClose={() => setEditing(null)}
        onSaved={(saved) => {
          onProjectsChange(editing === 'new'
            ? [...projects, saved]
            : projects.map((project) => project.id === saved.id ? saved : project))
          window.dispatchEvent(new Event('uniagent-projects-changed'))
          setEditing(null)
        }}
      />}
    </>
  )
}

/** The bot binding gates Session defaults and notification settings. */
function FeishuSection({
  agents,
  projects,
  config,
  status,
  onStatus,
  onPatch
}: {
  agents: AgentDef[]
  projects: Project[]
  config: AppSettings['feishu']
  status: FeishuStatus | null
  onStatus: (status: FeishuStatus) => void
  onPatch: (patch: Record<string, unknown>) => void
}): JSX.Element {
  const configured = !!status?.appId && !status.configuring

  // Default-session selectors (private-chat 建 session 时使用).
  const installed = agents.filter((a) => a.lifecycle?.availability === 'available')
  const defAgent = installed.find((a) => a.id === config?.defaultAgentId) || installed[0]
  const prefs = useAgentPreferences()
  const pref = prefs?.lastByAgent[defAgent?.id || '']
  const model = resolveAgentModel(defAgent, config?.defaultModel, pref?.defaultModel)
  const models = defAgent?.capabilities.modelSelect ? defAgent.models : []
  const efforts = defAgent?.capabilities.reasoningEffort ? model?.efforts || [] : []
  const defaultEffort = resolveModelEffort(model, config?.defaultEffort, pref?.defaultEffort)
  const defaultPermission = resolveAgentPermission(defAgent, config?.defaultPermissionMode)
  const permModes = defAgent?.capabilities.permissionModes ?? []

  return (
    <>
      <FeishuBinding scope="session" />
      {configured && <>
      <SetGroup title="新建会话默认参数">
        <SetRow
          label="驱动 Agent"
          sub="私聊建会话时默认使用"
          control={<SetSelect ariaLabel="驱动 Agent" value={defAgent?.id || ''} disabled={!installed.length} onChange={(v) => {
            const next = installed.find(agent => agent.id === v)
            const pref = prefs?.lastByAgent[v]
            const model = resolveAgentModel(next, pref?.defaultModel)
            onPatch({ defaultAgentId: v, defaultModel: model?.id, defaultEffort: next?.capabilities.reasoningEffort ? resolveModelEffort(model, pref?.defaultEffort) : undefined, defaultPermissionMode: resolveAgentPermission(next) })
          }}>
            {installed.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
          </SetSelect>}
        />
        <SetRow
          label="默认模型"
          control={<SetSelect ariaLabel="默认模型" value={model?.id || ''} disabled={!defAgent || models.length === 0} onChange={(v) => onPatch({ defaultModel: v, defaultEffort: defAgent?.capabilities.reasoningEffort ? resolveModelEffort(resolveAgentModel(defAgent, v), pref?.defaultEffort) : undefined })}>
            {models.map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}
          </SetSelect>}
        />
        <SetRow
          label="默认推理强度"
          control={<SetSelect ariaLabel="默认推理强度" value={defaultEffort || ''} disabled={efforts.length === 0} onChange={(v) => onPatch({ defaultEffort: v })}>
            {efforts.map((e) => (<option key={e} value={e}>{EFFORT_LABEL[e] || e}</option>))}
          </SetSelect>}
        />
        <SetRow
          label="默认权限"
          control={<SetSelect ariaLabel="默认权限" value={defaultPermission || ''} disabled={permModes.length === 0} onChange={(v) => onPatch({ defaultPermissionMode: v })}>
            {permModes.map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}
          </SetSelect>}
        />
        <SetRow
          label="默认空间"
          sub="飞书新话题创建会话时预先选择"
          control={<SetSelect ariaLabel="默认空间" value={config?.defaultProjectId || projects.find((project) => project.isDefault)?.id || 'default'} onChange={(value) => onPatch({ defaultProjectId: value })}>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </SetSelect>}
        />
      </SetGroup>

      <SetGroup title="运行配置">
        <SetRow
          label="仅在离开电脑时推送"
          sub="锁屏、息屏或达到无操作时长后通知；关闭则始终通知"
          control={<ToggleSwitch checked={config?.notifyOnlyWhenLocked ?? true} label="仅在离开电脑时推送" onChange={(checked) => onPatch({ notifyOnlyWhenLocked: checked })} />}
        />
        <SetRow
          label="无操作后视为离开"
          sub="关闭后仅在真实锁屏或真实息屏时推送"
          control={<SetSelect ariaLabel="无操作后视为离开" value={String(config?.idleThresholdSec ?? 300)} onChange={(value) => onPatch({ idleThresholdSec: Number(value) })}>
            <option value="0">关闭</option>
            <option value="60">1 分钟</option>
            <option value="180">3 分钟</option>
            <option value="300">5 分钟（默认）</option>
            <option value="600">10 分钟</option>
            <option value="900">15 分钟</option>
            <option value="1800">30 分钟</option>
            <option value="3600">60 分钟</option>
          </SetSelect>}
        />
      </SetGroup>

      <FeishuNotificationSettings status={status} onStatus={onStatus} />
      </>}
    </>
  )
}

function agentDetectionProgress(agent: AgentDef): { label: string; text: string } {
  if (agent.lifecycle?.detectionPhase === 'preparing') return { label: '准备中…', text: '正在准备本地连接…' }
  if (agent.lifecycle?.detectionPhase === 'recovering') return { label: '恢复中…', text: '正在恢复连接，请稍候…' }
  return { label: '检测中…', text: '正在检查可用状态…' }
}

function agentUpdateStatus(agent: AgentDef): AgentStatusView {
  if (agent.lifecycle?.selfUpdateSupported === false) {
    return { label: '不支持应用内更新', tone: 'off' }
  }
  switch (agent.lifecycle?.updateStatus) {
    case 'available': return { label: '可更新', tone: 'warn' }
    case 'current': return { label: '已是最新', tone: 'ok' }
    case 'checking': return { label: '检查中', tone: 'off' }
    case 'updating': return { label: '更新中', tone: 'warn' }
    case 'failed': return { label: '检查失败', tone: 'warn' }
    default: return { label: '尚未检查', tone: 'off' }
  }
}

function agentVersionLabel(agent: AgentDef, available = false): string {
  
  const version = available ? agent.lifecycle?.availableVersion || '新版本' : agent.lifecycle?.currentVersion || agent.version || '—'
  const revision = available ? agent.lifecycle?.availableRevision : agent.lifecycle?.currentRevision
  return agent.adapter === 'zcode' && revision ? `${version} · ${revision.slice(0, 7)}` : version
}

function agentUpdateStatusSub(agent: AgentDef): string {
  
  if (agent.lifecycle?.selfUpdateSupported === false) return agent.adapter === 'zcode' ? '外部程序由原程序管理更新；源码运行时仅更新未修改的官方构建' : '该 Agent 暂不支持应用内检查或更新'
  if (agent.lifecycle?.updateStatus === 'failed') return agent.lifecycle.message || '检查更新失败，请重试'
  if (agent.adapter === 'zcode' && agent.lifecycle?.updateStatus === 'updating') return agent.lifecycle.message || '正在下载并构建 ZCode，可能需要数分钟'
  if (agent.adapter === 'zcode' && agent.lifecycle?.updateStatus === 'idle') return '基于官方源码检查更新，下载与构建可能需要数分钟'
  if (!agent.lifecycle?.checkedAt || agent.lifecycle.updateStatus === 'idle') return '尚未检查更新'
  return `最近检查：${new Date(agent.lifecycle.checkedAt).toLocaleString('zh-CN')}`
}

function parseRoleList(value: string): string[] {
  return [...new Set(value.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean))]
}

function roleAvatarLabel(name: string): string {
  return Array.from(name).find((char) => char.trim().length > 0) || '角'
}

/** A role defines a reusable execution profile and never owns the task prompt. */
function supportsClaudeRoleRestrictions(version: string | undefined): boolean {
  const parts = version?.match(/^(\d+)\.(\d+)\.(\d+)(?:\s|$|[-+])/)?.slice(1).map(Number)
  return !!parts && (parts[0] > 2 || (parts[0] === 2 && (parts[1] > 1 || (parts[1] === 1 && parts[2] >= 296))))
}

export function RoleDetail({ agents, projects, entry, role, onBack, onSave, onDelete, teamScope = false, saveGlobal, inline = false, onClose }: {
  agents: AgentDef[]
  projects: Project[]
  entry: AgentRoleCatalogEntry | null
  role: AgentRole
  onBack: () => void
  onSave: (role: AgentRole) => void | Promise<void>
  onDelete?: () => void | Promise<void>
  teamScope?: boolean
  saveGlobal?: { checked: boolean; onChange: (checked: boolean) => void }
  inline?: boolean
  onClose?: () => void
}): JSX.Element {
  const prefs = useAgentPreferences()
  const [name, setName] = useState(role.name)
  const [instructions, setInstructions] = useState(role.instructions || '')
  const [agentId, setAgentId] = useState(role.agentId)
  const [model, setModel] = useState(role.model || '')
  const [effort, setEffort] = useState<string>(role.effort || '')
  const [kimiThinking, setKimiThinking] = useState(role.kimiThinking || role.zcodeThinking || '')
  const [permissionMode, setPermissionMode] = useState<string>(role.permissionMode || '')
  const [projectMode, setProjectMode] = useState<'follow' | 'fixed'>(role.projectId ? 'fixed' : 'follow')
  const [projectId, setProjectId] = useState(role.projectId || '')
  const [skillsMode, setSkillsMode] = useState<'all' | 'none' | 'allowlist'>(
    role.skills === undefined ? 'all' : role.skills.length === 0 ? 'none' : 'allowlist'
  )
  const [skillsText, setSkillsText] = useState((role.skills || []).join('\n'))
  const [toolMode, setToolMode] = useState<'inherit' | 'allow-only' | 'deny-only'>(role.toolPolicy?.mode || 'inherit')
  const [toolsText, setToolsText] = useState((role.toolPolicy?.tools || []).join('\n'))
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState('')

  const agent = agents.find((item) => item.id === agentId)
  const models = agent?.models ?? []
  const kimi = agent?.adapter === 'kimi'
  const zcode = agent?.adapter === 'zcode'
  const nativeThinking = kimi || zcode
  const pref = prefs?.lastByAgent[agentId]
  const selectedModel = resolveAgentModel(agent, model, pref?.defaultModel)
  const selectedThinking = resolveModelThinking(selectedModel, kimiThinking, pref?.defaultThinking, pref?.defaultEffort)
  const selectedEffort = !nativeThinking && agent?.capabilities.reasoningEffort ? resolveModelEffort(selectedModel, effort, pref?.defaultEffort) : undefined
  const selectedPermission = resolveAgentPermission(agent, permissionMode)
  const thinkingOptions = nativeThinking ? selectedModel?.thinkingOptions || [] : []
  const claudeRestrictions = agent?.adapter === 'claude' && supportsClaudeRoleRestrictions(agent.version)
  const stableACP = !!agent && ['deepseek', 'grok', 'kimi', 'mcode', 'zcode', 'nika'].includes(agent.adapter)
  const skillsSupported = claudeRestrictions
  const toolsSupported = !!agent && (claudeRestrictions || (agent.adapter === 'traex' && !agent.capabilities.streaming))
  const skillsSupportNote = agent?.adapter === 'kimi' || agent?.adapter === 'grok'
    ? `${agent.name} 不支持禁用或精确指定 Skills；请保留全部 Skills。`
    : agent?.adapter === 'claude' && !claudeRestrictions
      ? 'Claude Code 的 Skills 与工具限制需要已验证的 CLI 2.1.296 或更高版本。'
      : !skillsSupported ? '当前 Agent 不支持角色 Skills 限制；请保留全部 Skills。' : ''
  const efforts = !nativeThinking && agent?.capabilities.reasoningEffort ? selectedModel?.efforts || [] : []
  const permissionModes = agent?.capabilities.permissionModes ?? []
  const skills = parseRoleList(skillsText)
  const tools = parseRoleList(toolsText)
  const policyUnavailable = (skillsMode !== 'all' && !skillsSupported) || (toolMode !== 'inherit' && !toolsSupported)
  const valid = !!prefs && !!name.trim() && !!agent && agent.adapter !== 'generic' && !!selectedPermission && !policyUnavailable && (!stableACP || !instructions.trim()) &&
    (projectMode === 'follow' || !!projectId) &&
    (!kimiThinking || !nativeThinking || thinkingOptions.includes(kimiThinking)) &&
    (skillsMode !== 'allowlist' || skills.length > 0) &&
    (toolMode === 'inherit' || toolMode === 'allow-only' || tools.length > 0)
  const dirty = name !== role.name || instructions !== (role.instructions || '') ||
    agentId !== role.agentId || model !== (role.model || '') || effort !== (role.effort || '') || kimiThinking !== (role.kimiThinking || role.zcodeThinking || '') ||
    permissionMode !== role.permissionMode || projectMode !== (role.projectId ? 'fixed' : 'follow') ||
    projectId !== (role.projectId || '') ||
    skillsMode !== (role.skills === undefined ? 'all' : role.skills.length === 0 ? 'none' : 'allowlist') ||
    skillsText !== (role.skills || []).join('\n') || toolMode !== (role.toolPolicy?.mode || 'inherit') ||
    toolsText !== (role.toolPolicy?.tools || []).join('\n')

  useEffect(() => {
    if (model && !models.some((item) => item.id === model)) { setModel(''); setEffort('') }
    if (effort && !efforts.includes(effort as ReasoningEffort)) setEffort('')
    if (kimiThinking && !thinkingOptions.includes(kimiThinking)) setKimiThinking('')
    if (permissionMode && !permissionModes.some((item) => item.id === permissionMode)) {
      setPermissionMode(permissionModes[0]?.id || '')
    }
  }, [effort, efforts, kimiThinking, thinkingOptions, model, models, permissionMode, permissionModes])

  async function submit(): Promise<void> {
    if (!valid || busy) return
    setBusy(true)
    setSaveError('')
    try {
      await onSave({
        id: role.id, name: name.trim(), agentId, permissionMode: selectedPermission!,
        ...(selectedModel ? { model: selectedModel.id } : {}),
        ...(selectedEffort ? { effort: selectedEffort } : {}),
        ...(kimi && selectedThinking ? { kimiThinking: selectedThinking } : {}),
        ...(zcode && selectedThinking ? { zcodeThinking: selectedThinking } : {}),
        ...(projectMode === 'fixed' ? { projectId } : {}),
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        ...(skillsMode === 'none' ? { skills: [] } : skillsMode === 'allowlist' ? { skills } : {}),
        ...(toolMode === 'inherit' ? {} : { toolPolicy: { mode: toolMode, tools } })
      })
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '角色保存失败，请检查配置后重试')
    } finally {
      setBusy(false)
    }
  }

  async function remove(): Promise<void> {
    if (!onDelete || busy) return
    setBusy(true)
    setSaveError('')
    try {
      await onDelete()
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '角色删除失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="set-detail-top role-detail-top">
        {teamScope ? <button className="team-back-icon" aria-label={inline ? '返回成员列表' : '返回团队'} disabled={busy} onClick={onBack}><UiIcon name="chevron-right" size={20} /></button> : <button className="set-back" onClick={onBack}><span className="set-caret"><UiIcon name="chevron-right" size={15} /></span>返回角色</button>}
        <div className="set-detail-title">
          <div className="sdt-main"><h2>{inline ? '创建团队专属角色' : role.id ? name || '角色' : '新建角色'}</h2><div className="set-detail-sub">{teamScope ? '角色在团队项目的空间中运行' : '保存后立即出现在 MCP 角色列表中'}</div></div>
          {role.id && <span className="auto-badge paused">自定义</span>}
          {!inline && saveGlobal && <span className="team-switch-label">同时保存到角色列表<ToggleSwitch checked={saveGlobal.checked} label="同时保存到角色列表" disabled={busy} onChange={saveGlobal.onChange} /></span>}
          {!inline && <button className="set-save-btn" disabled={!valid || !dirty || busy} onClick={() => void submit()}><UiIcon name="check" size={13} />{busy ? '保存中…' : dirty ? '保存' : '已保存'}</button>}
          {inline && <button className="btn-ghost" aria-label="关闭创建角色" disabled={busy} onClick={onClose}>×</button>}
        </div>
      </div>

      {entry && <div className={`update-alert ${entry.executable ? 'ok' : ''}`} style={{ marginBottom: 22 }}>
        <span className="update-alert-ic"><UiIcon name={entry.executable ? 'check' : 'warn'} size={16} /></span>
        <div className="update-alert-body"><div className="update-alert-title">{entry.executable ? '当前可通过 MCP 调用' : '当前不可调用'}</div>{entry.unavailableReason && <div className="update-alert-sub">{entry.unavailableReason}</div>}</div>
      </div>}

      <SetGroup title="基本信息" pad>
        <div className="set-fld"><label>角色名称</label><input className="set-fld-inp" value={name} autoFocus placeholder="例如：代码审查员" onChange={(event) => setName(event.target.value)} /></div>
        <div className="set-fld"><label>角色描述{stableACP ? '（当前 Agent 暂不支持）' : '（可选）'}</label><textarea className="set-fld-inp mono" rows={5} value={instructions} placeholder="例如：以资深 Reviewer 身份工作，优先关注正确性、安全与回归风险。" onChange={(event) => setInstructions(event.target.value)} /></div>
      </SetGroup>

      <SetGroup title="运行配置" pad>
        <div className="set-fld-row">
          <div className="set-fld"><label>Agent</label><SetSelect ariaLabel="角色 Agent" value={agentId} onChange={(value) => { const next = agents.find((item) => item.id === value); setAgentId(value); setModel(''); setEffort(''); setKimiThinking(''); setPermissionMode(next?.capabilities.permissionModes[0]?.id || '') }}><option value="">选择 Agent</option>{agents.filter((item) => item.adapter !== 'generic').map((item) => <option key={item.id} value={item.id}>{item.name}{item.incompatible ? '（不兼容）' : item.lifecycle?.availability === 'available' ? '' : '（不可用）'}</option>)}</SetSelect></div>
          <div className="set-fld"><label>模型</label><SetSelect ariaLabel="角色模型" value={selectedModel?.id || ''} disabled={!agent || models.length === 0} onChange={(value) => { setModel(value); setEffort(''); setKimiThinking('') }}>{models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</SetSelect></div>
        </div>
        <div className="set-fld-row">
          <div className="set-fld"><label>{nativeThinking ? '思考级别' : '推理深度'}</label><SetSelect ariaLabel={nativeThinking ? '角色思考级别' : '角色推理深度'} value={(nativeThinking ? selectedThinking : selectedEffort) || ''} disabled={(nativeThinking ? thinkingOptions : efforts).length === 0} onChange={nativeThinking ? setKimiThinking : setEffort}>{(nativeThinking ? thinkingOptions : efforts).map((item) => <option key={item} value={item}>{EFFORT_LABEL[item] || item}</option>)}</SetSelect></div>
          <div className="set-fld"><label>权限</label><SetSelect ariaLabel="角色权限" value={selectedPermission || ''} disabled={permissionModes.length === 0} onChange={setPermissionMode}>{permissionModes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</SetSelect></div>
        </div>
        {!teamScope && <div className="set-fld">
          <label>空间策略</label>
          <div className="set-radio-grid" role="radiogroup" aria-label="角色空间策略">
            <label className={`set-radio-card ${projectMode === 'follow' ? 'is-selected' : ''}`}>
              <input
                type="radio"
                name="role-project-mode"
                checked={projectMode === 'follow'}
                onChange={() => setProjectMode('follow')}
              />
              <span className="set-radio-copy">
                <strong>跟随调用方空间（默认）</strong>
                <small>从 MCP 调用方会话继承空间及全部目录。</small>
              </span>
            </label>
            <label className={`set-radio-card ${projectMode === 'fixed' ? 'is-selected' : ''}`}>
              <input
                type="radio"
                name="role-project-mode"
                checked={projectMode === 'fixed'}
                onChange={() => setProjectMode('fixed')}
              />
              <span className="set-radio-copy">
                <strong>固定空间</strong>
                <small>始终在指定空间的多目录工作空间中运行。</small>
              </span>
            </label>
          </div>
        </div>}
        {!teamScope && projectMode === 'fixed' && <div className="set-fld"><label>固定空间</label><SetSelect ariaLabel="角色固定空间" value={projectId} onChange={setProjectId}><option value="">选择空间</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</SetSelect></div>}
      </SetGroup>

      <SetGroup title="Skills 与工具" pad>
        {agent && <div className="set-detail-sub">{stableACP ? `${agent.name}：${zcode ? '支持模型、思考深度、权限与空间预设' :  '稳定 ACP 仅支持模型、权限与空间预设'}；角色系统指令、Skills 筛选与工具限制暂不开放。` : <>{agent.name}：支持角色指令；Skills {skillsSupported ? '支持全部、禁用及精确指定' : '仅支持全部'}；工具{toolsSupported ? '支持继承、仅允许及禁止指定' : '仅支持继承 Agent 默认工具'}。</>}</div>}
        <div className="set-fld-row">
          <div className="set-fld"><label>Skills</label><SetSelect ariaLabel="角色 Skills 策略" value={skillsMode} onChange={(value) => setSkillsMode(value as 'all' | 'none' | 'allowlist')}><option value="all">全部 Skills（默认）</option><option value="none" disabled={!skillsSupported}>禁用全部 Skills{!skillsSupported ? '（暂不支持）' : ''}</option><option value="allowlist" disabled={!skillsSupported}>仅指定 Skills{!skillsSupported ? '（暂不支持）' : ''}</option></SetSelect>{skillsSupportNote && <div className="set-detail-sub">{skillsSupportNote}</div>}</div>
          <div className="set-fld"><label>工具策略</label><SetSelect ariaLabel="角色工具策略" value={toolMode} onChange={(value) => setToolMode(value as 'inherit' | 'allow-only' | 'deny-only')}><option value="inherit">继承 Agent 默认工具</option><option value="allow-only" disabled={!toolsSupported}>仅允许指定工具{!toolsSupported ? '（暂不支持）' : ''}</option><option value="deny-only" disabled={!toolsSupported}>禁止指定工具{!toolsSupported ? '（暂不支持）' : ''}</option></SetSelect>{!toolsSupported && <div className="set-detail-sub">当前 Agent 不支持此角色工具限制；请继承默认工具。</div>}</div>
        </div>
        {skillsMode === 'allowlist' && <div className="set-fld"><label>允许的 Skills（每行或逗号分隔）</label><textarea className="set-fld-inp mono" rows={4} value={skillsText} placeholder="例如：bits-code-guard" onChange={(event) => setSkillsText(event.target.value)} /></div>}
        {toolMode !== 'inherit' && <div className="set-fld"><label>{toolMode === 'allow-only' ? '允许的工具' : '禁止的工具'}（每行或逗号分隔）</label><textarea className="set-fld-inp mono" rows={4} value={toolsText} placeholder={kimi || agent?.adapter === 'claude' ? '例如：Read, Grep, Glob' : agent?.adapter === 'grok' ? '例如：read_file, grep, list_dir' : '例如：read_file, search, git_diff'} onChange={(event) => setToolsText(event.target.value)} /><div className="set-detail-sub">{toolMode === 'allow-only' ? '留空表示禁用全部工具；请填写当前 Agent 的原生工具名称，不支持的名称会显示具体原因。' : '请填写当前 Agent 的原生工具名称；不支持的名称会显示具体原因。'}</div></div>}
        {policyUnavailable && <div className="set-detail-sub" role="alert">当前配置包含不支持的策略；请将 Skills 改为全部，或将工具策略改为继承后保存。</div>}
      </SetGroup>

      {stableACP && instructions.trim() && <div className="set-detail-sub" role="alert">当前 Agent 不支持角色系统指令，原文已保留。清空角色描述后可保存基础参数预设，或切换到支持角色指令的 Agent。</div>}
      {inline ? <div className="team-role-modal-actions">{saveGlobal && <span className="team-switch-label">同时保存到角色列表<ToggleSwitch checked={saveGlobal.checked} label="同时保存到角色列表" disabled={busy} onChange={saveGlobal.onChange} /></span>}{saveError && <span className="dirty unsaved">{saveError}</span>}<button className="set-mini-btn" disabled={busy} onClick={onClose}>取消</button><button className="set-save-btn" disabled={!valid || !dirty || busy} onClick={() => void submit()}><UiIcon name="check" size={13} />{busy ? '保存中…' : dirty ? '保存' : '已保存'}</button></div> : <div className="set-detail-bar">{onDelete && <button className="set-mini-btn ghost danger" disabled={busy} onClick={() => void remove()}><UiIcon name="trash" size={13} />删除角色</button>}{saveError && <span className="dirty unsaved">{saveError}</span>}</div>}
    </>
  )
}

/**
 * 需求6 — the add / edit preset modal. Name + prompt are required; agent / model /
 * effort / permission are optional (empty ⇒ the preset only supplies a prompt and
 * everything else is resolved from the session / explicit args at handoff time).
 * Model & effort options are driven by the selected agent (reusing the same
 * per-agent capability data the New Task selector uses).
 */
function PresetDetail({
  agents,
  preset,
  onBack,
  onSave,
  onDelete
}: {
  agents: AgentDef[]
  preset: HandoffPreset
  onBack: () => void
  onSave: (p: HandoffPreset) => void | Promise<void>
  onDelete?: () => void | Promise<void>
}): JSX.Element {
  const prefs = useAgentPreferences()
  const [name, setName] = useState(preset.name)
  const [prompt, setPrompt] = useState(preset.prompt)
  const [agentId, setAgentId] = useState<string>(preset.agentId || '')
  const [model, setModel] = useState<string>(preset.model || '')
  const [effort, setEffort] = useState<string>(preset.effort || '')
  const [permissionMode, setPermissionMode] = useState<string>(preset.permissionMode || '')
  const builtin = preset.id.startsWith('builtin-')

  const agent = agents.find((a) => a.id === agentId)
  const models = agent?.models ?? []
  const pref = prefs?.lastByAgent[agentId]
  const selectedModel = resolveAgentModel(agent, model, pref?.defaultModel)
  const efforts = agent?.capabilities.reasoningEffort ? selectedModel?.efforts || [] : []
  const selectedEffort = efforts.length ? resolveModelEffort(selectedModel, effort, pref?.defaultEffort) : undefined
  const selectedPermission = resolveAgentPermission(agent, permissionMode)
  const permModes = agent?.capabilities.permissionModes ?? []

  const valid = !!prefs && name.trim() !== '' && prompt.trim() !== ''
  const dirty =
    name !== preset.name || prompt !== preset.prompt || agentId !== (preset.agentId || '') ||
    model !== (preset.model || '') || effort !== (preset.effort || '') || permissionMode !== (preset.permissionMode || '')

  useEffect(() => {
    if (effort && !efforts.includes(effort as ReasoningEffort)) setEffort('')
  }, [effort, efforts])
  useEffect(() => {
    if (model && !models.some((entry) => entry.id === model)) { setModel(''); setEffort('') }
    if (permissionMode && !permModes.some((mode) => mode.id === permissionMode)) setPermissionMode('')
  }, [model, models, permModes, permissionMode])

  function submit(): void {
    if (!valid) return
    void onSave({
      id: preset.id,
      name: name.trim(),
      prompt: prompt.trim(),
      ...(agentId ? { agentId } : {}),
      ...(selectedModel ? { model: selectedModel.id } : {}),
      ...(selectedEffort ? { effort: selectedEffort } : {}),
      ...(selectedPermission ? { permissionMode: selectedPermission } : {})
    })
  }

  return (
    <>
      <div className="set-detail-top">
        <button className="set-back" onClick={onBack}>
          <span className="set-caret"><UiIcon name="chevron-right" size={15} /></span>返回模板
        </button>
        <div className="set-detail-title">
          <div className="sdt-main">
            <h2>{preset.id ? name || '任务模板' : '新建任务模板'}</h2>
            <div className="set-detail-sub">编辑任务模板 · 新建任务时可一键套用</div>
          </div>
          {preset.id && <span className={`auto-badge ${builtin ? 'kind' : 'paused'}`}>{builtin ? '内置' : '自定义'}</span>}
          <button className="set-save-btn" disabled={!valid || !dirty} onClick={submit}>
            <UiIcon name="check" size={13} />{dirty ? '保存' : '已保存'}
          </button>
        </div>
      </div>
      <SetGroup title="基本信息">
        <div className="set-card pad">
          <div className="set-fld">
            <label>模板名称</label>
            <input className="set-fld-inp" value={name} autoFocus placeholder="例如：埋点走查" onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="set-fld-row">
            <div className="set-fld">
              <label>Agent（可选 · 不填则继承会话）</label>
              <SetSelect ariaLabel="默认 Agent" value={agentId} onChange={(v) => { setAgentId(v); setModel(''); setEffort(''); setPermissionMode('') }}>
                <option value="">继承会话</option>
                {agents.map((a) => (<option key={a.id} value={a.id}>{a.name}{a.incompatible ? '（不兼容）' : a.installed ? '' : '（未安装）'}</option>))}
              </SetSelect>
            </div>
            <div className="set-fld">
              <label>模型</label>
              <SetSelect ariaLabel="默认模型" value={selectedModel?.id || ''} disabled={!agent || models.length === 0} onChange={(v) => { setModel(v); setEffort('') }}>
                {models.map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}
              </SetSelect>
            </div>
          </div>
          <div className="set-fld-row">
            <div className="set-fld">
              <label>推理强度</label>
              <SetSelect ariaLabel="默认推理强度" value={selectedEffort || ''} disabled={efforts.length === 0} onChange={setEffort}>
                {efforts.map((e) => (<option key={e} value={e}>{EFFORT_LABEL[e] || e}</option>))}
              </SetSelect>
            </div>
            <div className="set-fld">
              <label>权限</label>
              <SetSelect ariaLabel="默认权限" value={selectedPermission || ''} disabled={permModes.length === 0} onChange={setPermissionMode}>
                {permModes.map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}
              </SetSelect>
            </div>
          </div>
          <div className="set-fld">
            <label>Prompt（最多显示 10 行，超出滚动）</label>
            <textarea className="set-fld-inp mono" rows={10} value={prompt} placeholder="交接任务时预填的提示词…" onChange={(e) => setPrompt(e.target.value)} />
          </div>
        </div>
      </SetGroup>
      {onDelete && (
        <div className="set-detail-bar">
          <button className="set-mini-btn ghost danger" onClick={() => void onDelete()}><UiIcon name="trash" size={13} />删除模板</button>
        </div>
      )}
    </>
  )
}
