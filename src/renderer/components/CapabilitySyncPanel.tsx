import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentsStrategy,
  CapabilityJobState,
  CapabilityKind,
  CapabilityInventorySyncRequest,
  CapabilityResolution,
  CapabilityRollbackCandidate,
  CapabilityScanResult,
  CapabilityMarkdownPreview,
  CapabilitySyncJob,
  CapabilitySyncMode,
  CapabilitySyncPlan
} from '@shared/capabilitySync'
import { compareCapabilitySyncJobs } from '../capabilitySyncJobOrder'
import { UiIcon } from './Icons'

const KIND: Record<string, string> = {
  skill: 'Skills',
  mcp: 'MCP',
  memory: 'Markdown Memory',
  'global-instructions': '全局 AGENTS.md',
  'global-preference': '全局偏好'
}
const CLONE_KINDS: CapabilityKind[] = ['skill', 'mcp', 'memory', 'global-instructions', 'global-preference']
const STATUS: Record<string, string> = {
  same: '已一致',
  add: '新增',
  update: '更新',
  conflict: '冲突',
  'target-only': '仅目标',
  incompatible: '不兼容',
  invalid: '无效'
}
const STRATEGY: Record<AgentsStrategy, string> = {
  'keep-codex': '保留 Codex',
  'keep-traex': '保留 TraeX',
  'keep-shared': '保留现有共享文件',
  merge: '合并全部来源'
}
const TERMINAL_JOB_STATES = new Set<CapabilityJobState>([
  'completed', 'failed_no_change', 'rolled_back', 'rollback_failed', 'cancelled'
])
const CANCELLABLE_JOB_STATES = new Set<CapabilityJobState>([
  'backing_up', 'staging', 'committing', 'verifying'
])
const ERROR_MESSAGES: Record<string, string> = {
  capability_sync_failed: '能力同步失败，请重试。',
  invalid_capability_scan_request: '扫描参数无效，请重新选择同步方向。',
  invalid_capability_plan_request: '计划参数无效，请重新扫描。',
  invalid_capability_execute_request: '执行参数无效，请重新生成计划。',
  invalid_job_id: '任务标识无效。',
  invalid_cancel_request: '取消请求无效。',
  invalid_transaction_id: '事务标识无效。',
  invalid_preview_request: '仅支持预览全局 AGENTS.md。',
  invalid_journal: '事务记录已损坏或被修改，已停止回滚以保护当前文件。',
  scan_not_found: '扫描结果已失效，请重新扫描。',
  plan_not_found: '计划已失效，请重新生成。',
  plan_blocked: '计划存在阻断项，无法执行。',
  confirmation_required: '需要确认危险操作。',
  stale_plan: '来源或目标已发生变化，请重新扫描。',
  target_changed_since_commit: '同步完成后目标已被修改，为保护当前内容未执行回滚。',
  sync_in_progress: '已有能力同步任务正在执行。',
  agents_source_empty: '所选 AGENTS.md 来源为空。',
  agents_merge_conflict: 'AGENTS.md 存在无法自动合并的同名章节。',
  transaction_not_rollbackable: '该事务当前不可回滚。',
  atomic_fs_unavailable: '当前系统缺少安全文件事务组件，已禁用写入。',
  recovery_required: '检测到未完成事务，需要先完成恢复。'
}

type PendingKind = 'scan' | 'plan' | 'preview' | 'execute' | 'cancel' | 'rollback'
type PendingState = Record<PendingKind, boolean>
interface JobTracking { jobId?: string; planId?: string; transactionId?: string }

const emptyPending = (): PendingState => ({
  scan: false, plan: false, preview: false, execute: false, cancel: false, rollback: false
})

function publicErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error || '')
  const code = Object.keys(ERROR_MESSAGES).find((candidate) => text.includes(candidate))
  return code ? ERROR_MESSAGES[code] : ERROR_MESSAGES.capability_sync_failed
}

function sameTrackedJob(tracking: JobTracking, candidate: CapabilitySyncJob): boolean {
  if (tracking.jobId && tracking.jobId === candidate.id) return true
  if (tracking.transactionId && tracking.transactionId === candidate.transactionId) return true
  // A plan id is used only during the narrow execute-invoke race, before the
  // background job id is known. Once accepted, job/transaction identity wins.
  return !tracking.jobId && !tracking.transactionId &&
    !!tracking.planId && tracking.planId === candidate.planId
}

function trackingFor(job: CapabilitySyncJob): JobTracking {
  return {
    jobId: job.id,
    transactionId: job.transactionId
  }
}

function latestJob(jobs: CapabilitySyncJob[]): CapabilitySyncJob | undefined {
  return jobs.reduce<CapabilitySyncJob | undefined>((latest, candidate) =>
    !latest || compareCapabilitySyncJobs(candidate, latest) > 0 ? candidate : latest, undefined)
}

export function CapabilitySyncPanel({ onBack, initialRequest }: { onBack: () => void; initialRequest?: CapabilityInventorySyncRequest | null }): JSX.Element {
  const [source, setSource] = useState<'codex' | 'traex'>(initialRequest?.source || 'codex')
  const target = source === 'codex' ? 'traex' : 'codex'
  const [scan, setScan] = useState<CapabilityScanResult | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [cloneCategories, setCloneCategories] = useState<Set<CapabilityKind>>(new Set())
  const [resolutions, setResolutions] = useState<Record<string, CapabilityResolution>>({})
  const [mode, setMode] = useState<CapabilitySyncMode>('merge')
  const [strategy, setStrategy] = useState<AgentsStrategy | ''>('')
  const [plan, setPlan] = useState<CapabilitySyncPlan | null>(null)
  const [agentsPreview, setAgentsPreview] = useState<CapabilityMarkdownPreview | null>(null)
  const [job, setJob] = useState<CapabilitySyncJob | null>(null)
  const [rollbackCandidate, setRollbackCandidate] = useState<CapabilityRollbackCandidate | null>(null)
  const [pending, setPending] = useState<PendingState>(emptyPending)
  const [error, setError] = useState('')

  // These independent generations make late scan/plan/preview replies inert.
  // The plan generation also proves that the rendered plan still represents
  // every current input at the moment Execute is clicked.
  const scanGeneration = useRef(0)
  const planInputGeneration = useRef(0)
  const planRequestGeneration = useRef(0)
  const planGeneration = useRef<number | null>(null)
  const previewGeneration = useRef(0)
  const trackedJob = useRef<JobTracking | null>(null)
  const recoveringJob = useRef(true)
  const recoveryProgress = useRef<CapabilitySyncJob[]>([])
  const executeInFlight = useRef(false)

  function setPendingKind(kind: PendingKind, value: boolean): void {
    setPending((current) => current[kind] === value ? current : { ...current, [kind]: value })
  }

  function acceptJob(candidate: CapabilitySyncJob): void {
    // Jobs persisted before the operation discriminator existed are sync jobs.
    if (candidate.operation === 'remove-selected') return
    trackedJob.current = trackingFor(candidate)
    setJob((current) => current?.id === candidate.id && compareCapabilitySyncJobs(candidate, current) <= 0 ? current : candidate)
    if (candidate.state === 'completed' && candidate.transactionId) {
      setRollbackCandidate({ ...candidate, state: 'completed', transactionId: candidate.transactionId })
    }
  }

  useEffect(() => {
    let mounted = true
    recoveringJob.current = true
    recoveryProgress.current = []
    const unsubscribe = window.uniagent.onCapabilitySyncProgress((candidate) => {
      if (!mounted || candidate.operation === 'remove-selected') return
      const tracking = trackedJob.current
      if (!tracking && recoveringJob.current) {
        recoveryProgress.current = [...recoveryProgress.current.slice(-19), candidate]
        return
      }
      if (!tracking || !sameTrackedJob(tracking, candidate)) return
      acceptJob(candidate)
    })
    void window.uniagent.capabilitySyncGetJobSnapshot()
      .then((snapshot) => {
        if (!mounted) return
        setRollbackCandidate(snapshot.rollbackCandidate?.operation !== 'remove-selected' ? snapshot.rollbackCandidate || null : null)
        const bufferedLatest = latestJob(recoveryProgress.current)
        const recovered = [snapshot.active, snapshot.latest, bufferedLatest].find((candidate) => candidate && candidate.operation !== 'remove-selected')
        const tracking = trackedJob.current
        if (!recovered || (tracking && !sameTrackedJob(tracking, recovered))) return
        acceptJob(recovered)
        const recoveredTracking = trackingFor(recovered)
        const bufferedMatch = latestJob(
          recoveryProgress.current.filter((candidate) => sameTrackedJob(recoveredTracking, candidate))
        )
        if (bufferedMatch) acceptJob(bufferedMatch)
      })
      .catch((reason) => {
        if (!mounted) return
        const bufferedLatest = latestJob(recoveryProgress.current)
        if (bufferedLatest) acceptJob(bufferedLatest)
        else setError(publicErrorMessage(reason))
      })
      .finally(() => { recoveringJob.current = false; recoveryProgress.current = [] })
    return () => { mounted = false; recoveringJob.current = false; recoveryProgress.current = []; unsubscribe() }
  }, [])

  function invalidatePlan(): void {
    planInputGeneration.current += 1
    planRequestGeneration.current += 1
    planGeneration.current = null
    setPlan(null)
    setError('')
    setPendingKind('plan', false)
  }

  function invalidatePreview(): void {
    previewGeneration.current += 1
    setAgentsPreview(null)
    setPendingKind('preview', false)
  }

  useEffect(() => {
    if (!initialRequest) return
    const generation = ++scanGeneration.current
    invalidatePlan()
    invalidatePreview()
    setSource(initialRequest.source)
    setScan(null)
    setSelected(new Set())
    setCloneCategories(new Set())
    setResolutions({})
    setMode('merge')
    setStrategy('')
    setError('')
    setPendingKind('scan', true)
    void window.uniagent.capabilityInventoryPrepareSync(initialRequest).then((preparation) => {
      if (generation !== scanGeneration.current) return
      const precise = new Set(preparation.selections)
      setScan(preparation.scan)
      setSelected(new Set(preparation.scan.items.filter((item) => item.selectable && precise.has(item.id)).map((item) => item.id)))
      setResolutions(Object.fromEntries(preparation.scan.items
        .filter((item) => item.selectable && precise.has(item.id) && item.status === 'conflict' && item.kind !== 'global-instructions')
        .map((item) => [item.id, 'target' as CapabilityResolution])))
    }).catch((reason) => {
      if (generation === scanGeneration.current) setError(publicErrorMessage(reason))
    }).finally(() => {
      if (generation === scanGeneration.current) setPendingKind('scan', false)
    })
    return () => { scanGeneration.current += 1 }
  }, [initialRequest])

  function changeDirection(): void {
    scanGeneration.current += 1
    invalidatePlan()
    invalidatePreview()
    setSource(target)
    setScan(null)
    setSelected(new Set())
    setCloneCategories(new Set())
    setResolutions({})
    setMode('merge')
    setStrategy('')
    setError('')
    setPendingKind('scan', false)
  }

  async function doScan(): Promise<void> {
    const generation = ++scanGeneration.current
    invalidatePlan()
    invalidatePreview()
    setScan(null)
    setSelected(new Set())
    setCloneCategories(new Set())
    setResolutions({})
    setMode('merge')
    setStrategy('')
    setError('')
    setPendingKind('scan', true)
    const request = { source, target } as const
    try {
      const result = await window.uniagent.capabilitySyncScan(request)
      if (generation !== scanGeneration.current) return
      setScan(result)
      setSelected(new Set(result.items.filter((item) => item.defaultSelected).map((item) => item.id)))
    } catch (reason) {
      if (generation === scanGeneration.current) setError(publicErrorMessage(reason))
    } finally {
      if (generation === scanGeneration.current) setPendingKind('scan', false)
    }
  }

  function updateSelection(ids: string[], checked: boolean): void {
    const next = new Set(selected)
    const nextResolutions = { ...resolutions }
    for (const id of ids) {
      const item = scan?.items.find((candidate) => candidate.id === id)
      if (!item?.selectable) continue
      if (checked) {
        next.add(id)
        if (item.status === 'conflict' && item.kind !== 'global-instructions' && !nextResolutions[id]) {
          nextResolutions[id] = 'target'
        }
      } else {
        next.delete(id)
        delete nextResolutions[id]
      }
    }
    invalidatePlan()
    setSelected(next)
    setResolutions(nextResolutions)
    if (!next.has('global-instructions:agents')) {
      invalidatePreview()
      setStrategy('')
    }
  }

  function updateResolution(id: string, resolution: CapabilityResolution): void {
    invalidatePlan()
    setResolutions((current) => ({ ...current, [id]: resolution }))
  }

  function updateMode(next: CapabilitySyncMode): void {
    if (next === mode) return
    invalidatePlan()
    invalidatePreview()
    setMode(next)
    setCloneCategories(new Set())
    setSelected(new Set(next === 'merge' && scan
      ? scan.items.filter((item) => item.defaultSelected).map((item) => item.id)
      : []))
    setResolutions({})
    setStrategy('')
  }

  function updateCloneCategory(kind: CapabilityKind, checked: boolean): void {
    if (!scan) return
    invalidatePlan()
    const categories = new Set(cloneCategories)
    const nextSelected = new Set(selected)
    const nextResolutions = { ...resolutions }
    const members = scan.items.filter((item) => item.kind === kind)
    if (checked) categories.add(kind)
    else categories.delete(kind)
    for (const item of members) {
      if (!item.selectable) continue
      if (checked) {
        nextSelected.add(item.id)
        if (item.status === 'conflict' && item.kind !== 'global-instructions') nextResolutions[item.id] = 'source'
      } else {
        nextSelected.delete(item.id)
        delete nextResolutions[item.id]
      }
    }
    setCloneCategories(categories)
    setSelected(nextSelected)
    setResolutions(nextResolutions)
    if (!nextSelected.has('global-instructions:agents')) {
      invalidatePreview()
      setStrategy('')
    }
  }

  async function previewAgents(next: AgentsStrategy | ''): Promise<void> {
    invalidatePlan()
    const generation = ++previewGeneration.current
    setStrategy(next)
    setAgentsPreview(null)
    setError('')
    if (!scan || !next) { setPendingKind('preview', false); return }
    setPendingKind('preview', true)
    const scanId = scan.id
    try {
      const preview = await window.uniagent.capabilitySyncPreview(scanId, 'global-instructions:agents', next)
      if (generation === previewGeneration.current) setAgentsPreview(preview)
    } catch (reason) {
      if (generation === previewGeneration.current) setError(publicErrorMessage(reason))
    } finally {
      if (generation === previewGeneration.current) setPendingKind('preview', false)
    }
  }

  async function doPlan(): Promise<void> {
    if (!scan) return
    const inputGeneration = planInputGeneration.current
    const requestGeneration = ++planRequestGeneration.current
    const scanId = scan.id
    setError('')
    setPendingKind('plan', true)
    try {
      const nextPlan = await window.uniagent.capabilitySyncPlan({
        scanId,
        mode,
        cloneCategories: mode === 'clone-supported-scope' ? [...cloneCategories].sort() : [],
        selections: [...selected].sort(),
        resolutions: { ...resolutions },
        agentsStrategy: strategy || undefined
      })
      if (requestGeneration !== planRequestGeneration.current ||
          inputGeneration !== planInputGeneration.current || scanId !== scan.id) return
      planGeneration.current = inputGeneration
      setPlan(nextPlan)
    } catch (reason) {
      if (requestGeneration === planRequestGeneration.current &&
          inputGeneration === planInputGeneration.current) setError(publicErrorMessage(reason))
    } finally {
      if (requestGeneration === planRequestGeneration.current) setPendingKind('plan', false)
    }
  }

  async function execute(): Promise<void> {
    const immutablePlan = plan
    if (!immutablePlan || planGeneration.current !== planInputGeneration.current || executeInFlight.current) return
    let confirmation: { acknowledged: boolean; targetName?: string } | undefined
    if (immutablePlan.requiresConfirmation) {
      const consequence = `覆盖转移后果说明：\n\n` +
        `• 将删除「${immutablePlan.target}」在所选类目下的独有能力\n` +
        `• 「${immutablePlan.target}」的支持范围将与来源「${immutablePlan.source}」完全一致\n` +
        `• 该操作会修改磁盘文件，只能通过回滚恢复\n\n` +
        `确定要继续吗？`
      if (!window.confirm(consequence)) return
      const typed = window.prompt(`二次确认：输入目标名「${immutablePlan.target}」以执行覆盖转移`)
      if (typed !== immutablePlan.target) return
      confirmation = { acknowledged: true, targetName: typed }
    }

    const priorTracking = trackedJob.current
    executeInFlight.current = true
    trackedJob.current = { planId: immutablePlan.id }
    setPendingKind('execute', true)
    setError('')
    try {
      const started = await window.uniagent.capabilitySyncExecute({
        planId: immutablePlan.id,
        expectedSourceRevision: immutablePlan.sourceRevision,
        expectedTargetRevision: immutablePlan.targetRevision,
        confirmation
      })
      acceptJob(started)
    } catch (reason) {
      trackedJob.current = priorTracking
      setError(publicErrorMessage(reason))
    } finally {
      executeInFlight.current = false
      setPendingKind('execute', false)
    }
  }

  async function cancelJob(): Promise<void> {
    if (!job || !CANCELLABLE_JOB_STATES.has(job.state)) return
    setPendingKind('cancel', true)
    setError('')
    try {
      const next = await window.uniagent.capabilitySyncCancel(job.id)
      if (next && trackedJob.current && sameTrackedJob(trackedJob.current, next)) acceptJob(next)
    } catch (reason) {
      setError(publicErrorMessage(reason))
    } finally {
      setPendingKind('cancel', false)
    }
  }

  async function rollbackJob(): Promise<void> {
    if (!rollbackCandidate) return
    const transactionId = rollbackCandidate.transactionId
    const priorTracking = trackedJob.current
    trackedJob.current = { transactionId }
    setPendingKind('rollback', true)
    setError('')
    try {
      const rolledBack = await window.uniagent.capabilitySyncRollback(transactionId)
      setRollbackCandidate(null)
      acceptJob(rolledBack)
    } catch (reason) {
      trackedJob.current = priorTracking
      setError(publicErrorMessage(reason))
    } finally {
      setPendingKind('rollback', false)
    }
  }

  const groups = useMemo(() => scan
    ? mode === 'clone-supported-scope'
      ? CLONE_KINDS
      : [...new Set(scan.items.map((item) => item.kind))]
    : [], [mode, scan])
  const planSummary = useMemo(() => {
    if (!plan) return null
    const count = (action: CapabilitySyncPlan['operations'][number]['action']): number =>
      plan.operations.filter((operation) => operation.action === action).length
    return { writes: count('write') + count('share'), deletes: count('delete'), noops: count('noop'), skips: count('skip') }
  }, [plan])
  const jobActive = !!job && !TERMINAL_JOB_STATES.has(job.state)
  const draftLocked = pending.execute || jobActive
  const agentsSelected = selected.has('global-instructions:agents')
  const hasPlanScope = mode === 'clone-supported-scope' ? cloneCategories.size > 0 : selected.size > 0
  const canPlan = !!scan?.executionSupported && !pending.scan && !pending.plan && !jobActive && hasPlanScope &&
    (!agentsSelected || (!!strategy && !pending.preview && !!agentsPreview))
  const canExecute = !!plan && planGeneration.current === planInputGeneration.current &&
    plan.blockedReasons.length === 0 && !pending.execute && !jobActive && job?.planId !== plan.id

  return <div className="main-panel capability-sync-panel">
    <div className="main-panel-head"><button className="settings-mini-btn" onClick={onBack}><UiIcon name="back" size={14} /> 工具能力</button><span className="main-panel-title">能力同步</span><span className="settings-dim">任务由主进程托管，可安全离开或重载</span></div>
    <div className="settings-scroll">
      <section className="settings-section"><div className="settings-section-title">同步方向</div><div className="cap-sync-direction"><b>{source}</b><button className="settings-mini-btn" aria-label="切换同步方向" title="切换同步方向" disabled={draftLocked} onClick={changeDirection}><UiIcon name="swap-horizontal" size={15} /></button><b>{target}</b><span className="settings-dim">来源只读 · 目标将被修改</span><button className="settings-redetect" disabled={pending.scan || draftLocked} onClick={() => void doScan()}>{pending.scan ? '扫描中…' : '扫描能力'}</button></div></section>
      {error && <div className="cap-sync-error">{error}</div>}
      {scan && <><section className="settings-section"><div className="settings-section-title">选择同步内容</div><div className="settings-section-sub">冲突默认保留目标；不兼容项不可选择。扫描失败不会显示为零项。</div>
        {!scan.executionSupported && <div className="cap-sync-error">已完成只读扫描，但当前版本或目录布局不可安全写入（{scan.blockedReason}）。</div>}
        {groups.map((kind) => {
          const members = scan.items.filter((item) => item.kind === kind && item.selectable)
          const all = mode === 'clone-supported-scope'
            ? cloneCategories.has(kind)
            : members.length > 0 && members.every((item) => selected.has(item.id))
          const categoryDisabled = draftLocked || (mode === 'merge' && members.length === 0)
          return <div className="cap-sync-group" key={kind}><h3><label><input type="checkbox" checked={all} disabled={categoryDisabled} onChange={(event) => mode === 'clone-supported-scope' ? updateCloneCategory(kind, event.target.checked) : updateSelection(members.map((item) => item.id), event.target.checked)}/> {KIND[kind] || kind}</label></h3>{scan.items.filter((item) => item.kind === kind).map((item) => <div className="cap-sync-item" key={item.id}><input type="checkbox" checked={selected.has(item.id)} disabled={!item.selectable || draftLocked || mode === 'clone-supported-scope'} onChange={(event) => updateSelection([item.id], event.target.checked)}/><span className="cap-sync-name">{item.name}</span><span className={`cap-sync-status ${item.status}`}>{STATUS[item.status]}</span>{item.status === 'conflict' && selected.has(item.id) && item.kind !== 'global-instructions' && <select value={resolutions[item.id] || 'target'} disabled={draftLocked || mode === 'clone-supported-scope'} onChange={(event) => updateResolution(item.id, event.target.value as CapabilityResolution)}><option value="target">保留目标</option><option value="source">使用来源</option>{item.kind === 'memory' && <option value="merge">结构化合并</option>}<option value="skip">跳过</option></select>}</div>)}</div>
        })}
        {agentsSelected && <div className="cap-sync-agents"><b>共享内容策略</b><select value={strategy} disabled={draftLocked} onChange={(event) => void previewAgents(event.target.value as AgentsStrategy | '')}><option value="">请选择（必填）</option><option value="keep-codex">保留 Codex</option><option value="keep-traex">保留 TraeX</option><option value="keep-shared">保留现有共享文件</option><option value="merge">合并全部来源</option></select><span>最终保存到共享 AGENTS.md，两端入口都会变为软连接。</span>{pending.preview && <span className="settings-dim">正在生成预检摘要…</span>}{agentsPreview && <div className="settings-dim">安全摘要：{agentsPreview.lineCount} 行 · {agentsPreview.headingCount} 个章节 · {agentsPreview.byteCount} 字节</div>}</div>}
      </section><section className="settings-section"><div className="settings-section-title">同步方式与预检</div><label><input type="radio" checked={mode === 'merge'} disabled={draftLocked} onChange={() => updateMode('merge')}/> 增量转移（默认，不删除目标独有项）</label><label className="cap-sync-overwrite"><input type="radio" checked={mode === 'clone-supported-scope'} disabled={draftLocked} onChange={() => updateMode('clone-supported-scope')}/> 覆盖转移（完全复刻支持范围）</label><button className="settings-add-preset" disabled={!canPlan} onClick={() => void doPlan()}>{pending.plan ? '生成中…' : '生成确定计划'}</button>
        {plan && planSummary && <div className="cap-sync-plan"><div><b>{plan.source} → {plan.target}</b> · {plan.mode === 'merge' ? '增量转移' : '覆盖转移'}{plan.agentsStrategy ? ` · AGENTS: ${STRATEGY[plan.agentsStrategy]}` : ''}</div><b>{planSummary.writes} 写入 · {planSummary.deletes} 删除 · {plan.destructiveCount} 破坏性 · {planSummary.noops} 无变化 · {planSummary.skips} 跳过</b>{planSummary.deletes > 0 && <span className="cap-sync-danger">删除：{plan.operations.filter((operation) => operation.action === 'delete').map((operation) => operation.name).join('、')}</span>}{plan.blockedReasons.length > 0 ? <div className="cap-sync-error">阻断：{plan.blockedReasons.join('、')}</div> : <button className="settings-add-preset" disabled={!canExecute} onClick={() => void execute()}>{pending.execute ? '正在启动…' : job?.planId === plan.id ? '任务已启动' : '执行同步'}</button>}</div>}
      </section></>}
      {job && <section className="settings-section"><div className="settings-section-title">任务状态：{job.state}</div><div className="settings-section-sub">{job.stage || job.errorCode || '任务由主进程持有，离开页面不会丢失。'}</div>{job.progress && <div className="settings-section-sub">进度 {job.progress.completed} / {job.progress.total}</div>}{job.result && <div className="cap-sync-result">已通过静态验证 {job.result.verified} · 待原生验证 {job.result.manualRequired} · 无变化 {job.result.noop} · 跳过 {job.result.skipped} · 失败 {job.result.failed} · 已回滚 {job.result.rolledBack}</div>}{CANCELLABLE_JOB_STATES.has(job.state) && <button className="settings-mini-btn" disabled={pending.cancel} onClick={() => void cancelJob()}>{pending.cancel ? '取消中…' : '取消'}</button>}{rollbackCandidate && <button className="settings-mini-btn" disabled={pending.rollback || jobActive} onClick={() => void rollbackJob()}>{pending.rollback ? '回滚中…' : rollbackCandidate.id === job.id ? '回滚此任务' : '回滚最近成功同步'}</button>}</section>}
    </div>
  </div>
}
