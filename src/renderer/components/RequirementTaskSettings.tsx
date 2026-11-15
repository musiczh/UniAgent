import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { AgentDef, AppSettings, ModelDef, ReasoningEffort, TaskTitleGenerationConfig } from '@shared/types'
import { resolveTaskTitleConfig, type TaskTitleResult } from '@shared/taskTitle'
import { SetGroup, SetRow } from './SettingsPrimitives'
import { ToggleSwitch } from './Icons'
import { RouterSettings } from './RouterSettings'
import { RouterReviewPanel } from './RouterReviewPanel'
import { RequirementCurationSettings } from './RequirementCurationSettings'
import { SuperAgentConfigPicker } from './SuperAgentConfigPicker'
import { SidebarStyleSetting } from './SidebarStyleSetting'

const effortLabels: Record<ReasoningEffort, string> = { off: '关闭', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', ultra: '极高' }

function titleConfig(settings: AppSettings): TaskTitleGenerationConfig {
  return settings.taskTitleGeneration || { enabled: false }
}
function configKey(config: TaskTitleGenerationConfig): string {
  return JSON.stringify([config.enabled, config.agentId || '', modelKey(config), config.effort, config.kimiThinking])
}
function modelKey(model: Pick<TaskTitleGenerationConfig, 'model' | 'modelSource'>): string {
  return model.model ? JSON.stringify([model.model, model.modelSource?.kind || 'native', model.modelSource?.sourceId || '']) : ''
}
function choiceKey(model: ModelDef): string {
  return modelKey({ model: model.id, modelSource: model.modelSource })
}

export function RequirementTaskSettings({ agents, settings, onSaved, navigationGuard, onOpenSession }: {
  agents: AgentDef[]
  settings?: AppSettings | null
  onSaved?: (settings: AppSettings) => void
  navigationGuard?: MutableRefObject<(() => boolean) | null>
  onOpenSession?: (id: string) => void
}): JSX.Element {
  const [routerEdit,setRouterEdit]=useState({dirty:false,saving:false})
  const [curationEdit,setCurationEdit]=useState({dirty:false,saving:false})
  const [reviewsOpen, setReviewsOpen] = useState(false)
  const [reviewDirty, setReviewDirty] = useState(false)
  const configView = useRef<HTMLDivElement>(null), configScroll = useRef(0)
  function showReviews(open: boolean) {
    const scroll = configView.current?.closest<HTMLElement>('.set-content')
    if (open) configScroll.current = scroll?.scrollTop || 0
    setReviewsOpen(open)
    requestAnimationFrame(() => { if (scroll) scroll.scrollTop = open ? 0 : configScroll.current })
  }
  const [saved, setSaved] = useState<AppSettings | null>(settings || null)
  const [draft, setDraft] = useState<TaskTitleGenerationConfig>(() => settings ? titleConfig(settings) : { enabled: false })
  const [replyEnabled, setReplyEnabled] = useState(settings?.quickRepliesEnabled === true)
  const [prompt, setPrompt] = useState('修复重启后任务历史中的图片不显示')
  const [loadingError, setLoadingError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const [trial, setTrial] = useState<{ requestId: string; result?: TaskTitleResult; error?: string }>()
  const mounted = useRef(true)
  const savedRef = useRef(saved)
  const draftRef = useRef(draft)
  const replyRef = useRef(replyEnabled)
  replyRef.current = replyEnabled
  const edits = useRef(0)
  const loadVersion = useRef(0)
  const activeTrial = useRef<string>()
  const saveFlight = useRef(false)
  const dirty = !!saved && (configKey(draft) !== configKey(titleConfig(saved)) || replyEnabled !== (saved.quickRepliesEnabled === true))

  function cancelTrial(show = false): void {
    const requestId = activeTrial.current
    activeTrial.current = undefined
    if (requestId) void window.uniagent.cancelTaskTitleGenerationTest(requestId).catch(() => {})
    if (show) setTrial(undefined)
  }
  function receive(next: AppSettings): void {
    if (!mounted.current) return
    const wasDirty = savedRef.current && (configKey(draftRef.current) !== configKey(titleConfig(savedRef.current)) || replyRef.current !== (savedRef.current.quickRepliesEnabled === true))
    savedRef.current = next
    setSaved(next); setLoadingError('')
    if (!wasDirty && !saveFlight.current) {
      const config = titleConfig(next)
      if (configKey(config) !== configKey(draftRef.current)) { cancelTrial(); setTrial(undefined); edits.current++ }
      draftRef.current = config; setDraft(config)
      replyRef.current = next.quickRepliesEnabled === true; setReplyEnabled(replyRef.current)
    }
  }
  async function reload(): Promise<void> {
    const version = ++loadVersion.current
    try {
      const next = await window.uniagent.getAppSettings()
      if (version === loadVersion.current) receive(next)
    } catch {
      if (mounted.current && version === loadVersion.current) setLoadingError('配置读取失败，请重试。')
    }
  }
  useEffect(() => {
    mounted.current = true
    if (settings == null) void reload()
    const unsubscribe = settings == null ? window.uniagent.onUniAgentManagementChanged(resource => {
      if (resource === 'settings') void reload()
    }) : undefined
    return () => { mounted.current = false; loadVersion.current++; cancelTrial(); unsubscribe?.() }
  }, [])
  useEffect(() => {
    if (settings) {
      // Parent settings pushes are authoritative over a local read that began
      // earlier, including reads started while the embedded prop was null.
      loadVersion.current++
      receive(settings)
    }
  }, [settings])
  useEffect(() => {
    if (!navigationGuard) return
    const guard = () => !saveFlight.current && !routerEdit.saving && !curationEdit.saving && (!reviewDirty || window.confirm('反馈尚未保存，确定放弃修改？')) && (!(dirty||routerEdit.dirty||curationEdit.dirty) || window.confirm('superAgent配置尚未保存，确定放弃修改？'))
    navigationGuard.current = guard
    return () => { if (navigationGuard.current === guard) navigationGuard.current = null }
  }, [dirty, navigationGuard,routerEdit,reviewDirty,curationEdit])

  function edit(config: TaskTitleGenerationConfig): void {
    edits.current++; draftRef.current = config; setDraft(config)
    cancelTrial(); setTrial(undefined); setSaveError('')
  }
  async function save(): Promise<void> {
    if (!savedRef.current || saveFlight.current) return
    // Settings patches merge this object. Explicit unset fields clear the old
    // Agent/model/source instead of retaining a previous Provider selection.
    const config = draftRef.current
    const resolved = resolveTaskTitleConfig({ ...config, enabled: true }, agents)
    if ((config.enabled || replyRef.current) && !resolved.enabled) return
    const selected = { ...config, agentId: config.agentId, model: config.model, modelSource: config.modelSource,
      effort: resolved.config?.effort ?? config.effort, kimiThinking: resolved.config?.kimiThinking ?? config.kimiThinking }
    const version = edits.current
    const replies = replyRef.current
    saveFlight.current = true; setSaving(true); setSaveError(''); loadVersion.current++
    try {
      const next = await window.uniagent.setAppSettings({ taskTitleGeneration: selected, quickRepliesEnabled: replies })
      if (!mounted.current) return
      savedRef.current = next; setSaved(next)
      if (version === edits.current) { draftRef.current = titleConfig(next); setDraft(titleConfig(next)); replyRef.current = next.quickRepliesEnabled === true; setReplyEnabled(replyRef.current) }
      onSaved?.(next)
    } catch {
      if (mounted.current) setSaveError('保存失败，请重试。')
    } finally {
      saveFlight.current = false
      if (mounted.current) setSaving(false)
    }
  }
  async function test(): Promise<void> {
    if (!savedRef.current || !prompt.trim()) return
    const config = { ...draftRef.current }
    if (!resolveTaskTitleConfig({ ...config, enabled: true }, agents).enabled) return
    cancelTrial()
    const requestId = crypto.randomUUID()
    activeTrial.current = requestId; setTrial({ requestId })
    try {
      const result = await window.uniagent.testTaskTitleGeneration({ requestId, config, prompt: prompt.trim() })
      if (mounted.current && activeTrial.current === requestId) { activeTrial.current = undefined; setTrial({ requestId, result }) }
    } catch (cause) {
      if (mounted.current && activeTrial.current === requestId) {
        const error = cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : ''
        activeTrial.current = undefined; setTrial({ requestId, error: error || '试生成失败，请检查所选 Agent 的登录、模型与额度后重试。' })
      }
    }
  }

  const agent = agents.find(item => item.id === draft.agentId)
  const models = agent?.models || []
  const selectedModel = models.find(item => choiceKey(item) === modelKey(draft))
  const resolved = resolveTaskTitleConfig({ ...draft, enabled: true }, agents)
  const nativeThinking = agent?.adapter === 'kimi'
  const selectedEffort = nativeThinking ? resolved.config?.kimiThinking ?? draft.kimiThinking : resolved.config?.effort ?? draft.effort
  const effortLabel = (value?: string): string => value ? nativeThinking ? value : effortLabels[value as ReasoningEffort] || value : '默认'
  useEffect(() => {
    if (!resolved.enabled) cancelTrial(true)
  }, [agents, resolved.enabled])
  const unavailable = !!draft.agentId && !!draft.model && !resolved.enabled
  const running = !!trial && !trial.result && !trial.error
  const status = !saved ? loadingError ? '读取失败' : '读取中' : dirty ? '未保存' : !draft.enabled && !replyEnabled ? '已关闭' : unavailable ? '暂不可用' : !resolved.enabled ? '未配置' : trial?.result?.title ? '已保存 · 试生成成功' : '已保存 · 未试生成'
  const savedIdentity = [agent?.name || draft.agentId, selectedModel?.label || draft.model, draft.modelSource?.sourceId].filter(Boolean).join(' / ')
  const statusCopy = !saved ? loadingError || '正在读取配置…' : unavailable ? `${savedIdentity}：${resolved.reason}` : dirty ? '保存后任务标题和快捷回复将使用此配置。' : resolved.enabled ? `${agent!.name} / ${selectedModel!.label} · ${effortLabel(selectedEffort)}` : '选择 Agent 和模型后保存，辅助生成才会生效。'

  return <><div ref={configView} style={{ display: reviewsOpen ? 'none' : 'contents' }}>
    <header className="set-detail-top"><div className="set-detail-title"><div className="sdt-main">
      <h2>superAgent配置</h2><div className="set-detail-sub">配置需求与任务的工作方式。</div>
    </div></div></header>
    <SidebarStyleSetting settings={saved ?? undefined} onSaved={next => { receive(next); onSaved?.(next) }} />
    <RouterSettings agents={agents} settings={settings} onReview={() => showReviews(true)} onDirtyChange={(dirty,saving)=>setRouterEdit(current=>current.dirty===dirty&&current.saving===saving?current:{dirty,saving})}/>
    <RequirementCurationSettings agents={agents} settings={saved} onSaved={next => { receive(next); onSaved?.(next) }} onDirtyChange={(dirty,saving)=>setCurationEdit(current=>current.dirty===dirty&&current.saving===saving?current:{dirty,saving})}/>
    <div className="codex-model-pane">
      <div className="set-detail-top"><div className="set-detail-title"><div className="sdt-main"><h2>辅助生成</h2><div className="set-detail-sub">任务标题与快捷回复共用同一模型。</div></div></div></div>
      <SetGroup title="共用模型">
        <SetRow label="生成配置" sub="用于任务标题和快捷回复。" control={<SuperAgentConfigPicker agents={agents} value={{ ...draft, agentId: draft.agentId || '' }} disabled={!saved} label="选择标题 Agent、模型与思考参数" className="title-generator-picker" onChange={choice => edit({ enabled: draft.enabled, ...choice })}/>} />
        <SetRow label="配置状态" sub={statusCopy} control={<span className="status-pill" role="status"><i className={`dot ${unavailable ? 'warn' : !resolved.enabled || dirty ? 'off' : 'ok'}`} />{status}</span>} />
      </SetGroup>
      {loadingError && <div role="alert">{loadingError}<button className="set-mini-btn" onClick={() => void reload()}>重试</button></div>}
      <SetGroup title="生成选项">
        <SetRow label="自动生成任务标题" sub="任务开始执行后在后台生成，手动修改的标题会保留。" control={<ToggleSwitch label="自动生成任务标题" checked={draft.enabled} disabled={!saved} onChange={enabled => edit({ ...draft, enabled })} />} />
        <SetRow label="快捷回复" sub="本轮回复结束后生成 1～3 个建议，点击填入输入框，再由你发送。" control={<ToggleSwitch label="快捷回复" checked={replyEnabled} disabled={!saved || saving} onChange={enabled => { edits.current++; replyRef.current = enabled; setReplyEnabled(enabled); setSaveError('') }} />} />
      </SetGroup>
      <SetGroup title="标题试生成" pad>
        <div className="set-fld"><label htmlFor="task-title-sample">示例任务</label><input id="task-title-sample" className="set-fld-inp" aria-label="示例任务" value={prompt} maxLength={8192} onChange={event => { edits.current++; cancelTrial(); setTrial(undefined); setPrompt(event.target.value) }} /></div>
        <div className="title-preview-result" role={trial?.error ? 'alert' : 'status'} style={{ display: 'flex', gap: 16, alignItems: 'center', fontSize: 12, color: 'var(--text-dim)' }}><span>{trial?.result ? '生成标题' : '标题预览'}</span><strong style={{ fontWeight: 500, fontSize: 13, color: 'var(--text)' }}>{running ? '正在试生成…' : trial?.error || (trial?.result?.needsClarification ? '目标信息不足，请补充示例任务。' : trial?.result?.title) || (resolved.enabled ? '可以使用当前选择试生成' : '选择可用模型后可以试生成')}</strong></div>
        <div className="title-preview-action" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}><span className="set-detail-sub">试生成会使用所选模型并产生少量 Token 费用，不会创建任务。</span>{running ? <button type="button" className="set-mini-btn" onClick={() => cancelTrial(true)}>取消试生成</button> : <button type="button" className="set-mini-btn" disabled={!saved || !resolved.enabled || !prompt.trim()} onClick={() => void test()}>试生成</button>}</div>
      </SetGroup>
      <div className="set-detail-bar"><span className="dirty" role={saveError ? 'alert' : undefined}>{saveError || (dirty ? '配置尚未保存' : !resolved.enabled ? status : '配置已保存')}</span><button type="button" className="set-mini-btn primary" disabled={!saved || saving || !dirty || (draft.enabled || replyEnabled) && !resolved.enabled} onClick={() => void save()}>{saving ? '保存中…' : '保存配置'}</button></div>
      <p className="set-detail-sub" style={{ marginTop: 14 }}>命名失败时保留原标题，不会改用任务执行模型。</p>
    </div>
    </div>{reviewsOpen && <RouterReviewPanel onBack={() => showReviews(false)} onOpenTask={onOpenSession} onDirtyChange={setReviewDirty}/>}
  </>
}
