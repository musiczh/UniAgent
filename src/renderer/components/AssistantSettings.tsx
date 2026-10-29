import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { AgentDef, PermissionMode } from '@shared/types'
import { ASSISTANT_DOCUMENTS, ASSISTANT_LIMITS, type AssistantDetail, type AssistantDocument, type AssistantDocumentType, type AssistantInput, type DocumentRevision } from '@shared/assistant'
import { SetGroup, SetRow, SetSelect } from './SettingsPrimitives'
import { resolveAgentModel, resolveAgentPermission } from '@shared/agentChoices'
import { useAgentPreferences } from '../hooks'
import { ToggleSwitch, UiIcon } from './Icons'
import './assistant.css'
import { FeishuBinding } from './AssistantFeishuBinding'
import { AssistantWeixinBinding } from './AssistantWeixinBinding'

const files = { soul: 'SOUL.md', working_rules: '工作规则', user: 'USER.md', memory: 'MEMORY.md' }
const writer = { user: '手动', agent: 'Agent', auto_review: '自动复盘' }
export function AssistantSettings({ agents, navigationGuard }: { agents: AgentDef[]; navigationGuard: MutableRefObject<(() => boolean) | null> }): JSX.Element {
  const prefs = useAgentPreferences()
  const [detail, setDetail] = useState<AssistantDetail>()
  const [config, setConfig] = useState<AssistantInput>()
  const [drafts, setDrafts] = useState<Record<AssistantDocumentType,string>>({ soul: '', working_rules: '', user: '', memory: '' })
  const [tab, setTab] = useState<AssistantDocumentType>('soul')
  const [showVersions, setShowVersions] = useState(false)
  const [bindingDirty, setBindingDirty] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [updated, setUpdated] = useState(false)
  const dirty = !!detail && (JSON.stringify(config) !== JSON.stringify(input(detail)) || detail.documents.some(d => d.content !== drafts[d.type]))
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty || bindingDirty
  function load(value: AssistantDetail) { setDetail(value); setConfig(input(value)); setDrafts(Object.fromEntries(value.documents.map(d => [d.type,d.content])) as Record<AssistantDocumentType,string>); setUpdated(false) }
  useEffect(() => {
    let active = true
    const refresh = () => void window.uniagent.getPersonalAssistant().then(value => { if (!active) return; if (dirtyRef.current) { setDetail(current => current ? { ...current, review: value.review } : value); setUpdated(true) } else load(value) }, e => { if (active) setError(String(e)) })
    refresh()
    const unsubscribe = window.uniagent.onAssistantChanged(refresh)
    return () => { active = false; unsubscribe() }
  }, [])
  useEffect(() => {
    const guard = () => !dirtyRef.current || window.confirm('有未保存的助手配置，确定放弃更改？')
    navigationGuard.current = guard
    return () => { if (navigationGuard.current === guard) navigationGuard.current = null }
  }, [navigationGuard])
  if (!detail || !config) return <p className="r-sub">{error || '正在加载个人助手…'}</p>
  const doc = detail.documents.find(d => d.type === tab)!
  const permissionModes = agents.find(a => a.id === config.defaultAgentId)?.capabilities.permissionModes || []
  const permissionValid = permissionModes.length > 0 && (config.defaultPermissionMode === undefined || permissionModes.some(mode => mode.id === config.defaultPermissionMode))
  const count = [...drafts[tab]].length
  const patch = (values: Partial<AssistantInput>) => setConfig(current => ({ ...current!, ...values }))
  const changeDefault = (defaultAgentId: string, defaultModel?: string) => {
    const agent = agents.find(a => a.id === defaultAgentId)
    const model = resolveAgentModel(agent, defaultModel, prefs?.lastByAgent[defaultAgentId]?.defaultModel)
    const defaultPermissionMode = resolveAgentPermission(agent, config.defaultPermissionMode, 'ask')
    patch({ defaultAgentId, defaultModel: model?.id, defaultPermissionMode })
  }
  const save = async () => {
    setBusy(true); setError('')
    try {
      const agent = agents.find(a => a.id === config.defaultAgentId)
      const reviewAgent = agents.find(a => a.id === config.reviewRuntime?.agentId)
      const resolved = { ...config,
        defaultModel: resolveAgentModel(agent, config.defaultModel, prefs?.lastByAgent[config.defaultAgentId]?.defaultModel)?.id,
        defaultPermissionMode: resolveAgentPermission(agent, config.defaultPermissionMode, 'ask'),
        ...(config.reviewRuntime ? { reviewRuntime: { ...config.reviewRuntime, model: resolveAgentModel(reviewAgent, config.reviewRuntime.model)?.id } } : {}) }
      load(await window.uniagent.savePersonalAssistant(resolved, detail.documents.filter(d => d.content !== drafts[d.type]).map(d => ({ type: d.type, content: drafts[d.type], expectedRevision: d.revision }))))
    }
    catch (e) { setError(String(e).includes('revision_conflict') ? '记忆已更新，请加载最新版本后保存' : String(e)) }
    finally { setBusy(false) }
  }
  if (showVersions) return <AssistantVersions document={doc} dirty={dirty} onBack={() => setShowVersions(false)} onRestored={load} />
  const selectors = (agentId: string, model: string | undefined, onChange: (agentId: string, model?: string) => void, review = false) => {
    const pool = review ? agents : agents.filter(a => a.capabilities.startupSystemPrompt)
    const agent = agents.find(a => a.id === agentId)
    const selectedModel = resolveAgentModel(agent, model, review ? undefined : prefs?.lastByAgent[agentId]?.defaultModel)
    return <div className={'assistant-selectors' + (review ? '' : ' assistant-default-selectors')}><SetSelect value={agentId} ariaLabel={review ? '复盘 Agent' : '默认 Agent'} disabled={busy} onChange={id => onChange(id)}>
      {!pool.some(a => a.id === agentId) && <option value={agentId}>{agentId} · 不可用</option>}
      {pool.map(a => <option key={a.id} value={a.id} disabled={review && !['codex','claude'].includes(a.adapter)}>{a.name}{review && !['codex','claude'].includes(a.adapter) ? ' · 暂不支持工具限制' : ''}</option>)}
    </SetSelect><SetSelect value={selectedModel?.id || ''} ariaLabel={review ? '复盘模型' : '默认模型'} disabled={busy || !prefs || !agent?.capabilities.modelSelect || !agent.models.length} onChange={value => onChange(agentId, value)}>
      {agent?.models.map(m => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
    </SetSelect>{!review && <SetSelect value={resolveAgentPermission(agent, config.defaultPermissionMode, 'ask') || ''} ariaLabel="默认权限" disabled={busy || !permissionModes.length} onChange={value => patch({ defaultPermissionMode: value as PermissionMode })}>
      {permissionModes.map(mode => <option key={mode.id} value={mode.id} title={mode.hint}>{mode.label}</option>)}
    </SetSelect>}</div>
  }
  return <div className="assistant-settings">
    {error && <p className="assistant-error" role="alert">{error}</p>}
    {updated && <p className="assistant-hint">记忆在后台发生更新，当前草稿已保留。<button className="set-mini-btn" disabled={busy} onClick={() => { if (window.confirm('加载最新版本会放弃当前未保存更改，继续？')) void window.uniagent.getPersonalAssistant().then(load) }}>加载最新版本</button></p>}
    <SetGroup title="基础配置">
      {!agents.some(a => a.capabilities.startupSystemPrompt && a.lifecycle?.availability === 'available') && <p className="assistant-hint" role="status">当前没有可承接个人助手的可用 Agent（需支持启动时注入系统提示，如 Codex）；安装并启用后个人助手才可用。</p>}
      <SetRow label="启用个人助手" sub="创建会话时可选择使用" control={<ToggleSwitch label="启用个人助手" checked={config.enabled} disabled={busy} onChange={enabled => patch({ enabled })} />} />
      <SetRow label="默认执行方" sub="创建助手会话时默认使用，可更改模型与权限" control={selectors(config.defaultAgentId, config.defaultModel, changeDefault)} />
      <SetRow label="默认运行目录" sub={config.defaultWorkdir ? <>创建个人助手会话时默认使用<span className="set-code set-code-path">{config.defaultWorkdir}</span></> : '默认使用当前电脑用户的主目录；创建会话时可更改'} control={<>
        {!config.defaultWorkdir && <span className="set-code">{window.uniagent.homeDir}</span>}
        <button className="set-mini-btn" disabled={busy} onClick={() => { setBusy(true); setError(''); void window.uniagent.pickDirectory().then(directory => { if (directory) patch({ defaultWorkdir: directory }) }, error => setError(String(error))).finally(() => setBusy(false)) }}>选择目录</button>
        {config.defaultWorkdir && <button className="set-mini-btn ghost" disabled={busy} onClick={() => patch({ defaultWorkdir: undefined })}>恢复默认</button>}
      </>} />
      <SetRow label="自动复盘记忆" sub="回复完成后在后台更新 USER 与 MEMORY" control={<ToggleSwitch label="自动复盘记忆" checked={config.autoReviewEnabled} disabled={busy} onChange={autoReviewEnabled => patch({ autoReviewEnabled })} />} />
      <SetRow label="复盘执行方" sub="只影响后台记忆复盘" control={<SetSelect value={config.reviewRuntime ? 'separate' : 'session'} ariaLabel="复盘执行方" disabled={busy} onChange={value => patch({ reviewRuntime: value === 'separate' ? { agentId: agents.find(a => a.adapter === 'codex')?.id || agents.find(a => a.adapter === 'claude')?.id || config.defaultAgentId } : undefined })}><option value="session">沿用当前会话</option><option value="separate">单独选择</option></SetSelect>} />
      {config.reviewRuntime && <SetRow label="Agent 与模型" sub="前台对话仍使用当前会话配置" control={selectors(config.reviewRuntime.agentId,config.reviewRuntime.model,(agentId,model) => patch({ reviewRuntime: { agentId,model } }),true)} />}
    </SetGroup>
    {config.autoReviewEnabled && detail.review.status !== 'off' && <p className={'assistant-hint ' + (['failed','unsupported'].includes(detail.review.status) ? 'assistant-error' : '')} role="status">
      {{ idle: '自动复盘 · 等待下一次对话', queued: '自动复盘 · 等待空闲', running: '自动复盘 · 正在整理记忆', failed: '自动复盘失败', unsupported: '自动复盘暂停', off: '' }[detail.review.status]}{detail.review.reason ? ` · ${detail.review.reason}` : ''}
      {detail.review.status === 'unsupported' && !config.reviewRuntime && <button className="set-mini-btn" onClick={() => patch({ reviewRuntime: { agentId: agents.find(a => a.adapter === 'codex')?.id || config.defaultAgentId } })}>配置复盘 Agent</button>}
    </p>}
    <FeishuBinding disabled={busy} onDirtyChange={setBindingDirty} />
    <AssistantWeixinBinding disabled={busy} />
    <SetGroup title="助手文档">
      <div className="assistant-tabs" role="tablist" aria-label="助手文档">{ASSISTANT_DOCUMENTS.map(type => <button key={type} type="button" role="tab" aria-selected={tab === type} className={tab === type ? 'active' : ''} onClick={() => setTab(type)}>{files[type]}{['user','memory'].includes(type) && <small>自动管理</small>}</button>)}</div>
      <textarea className="assistant-editor" aria-label={files[tab]} value={drafts[tab]} disabled={busy} spellCheck={false} onChange={e => setDrafts(current => ({ ...current, [tab]: e.target.value }))} />
      <div className={'assistant-doc-foot ' + (count > ASSISTANT_LIMITS[tab] ? 'assistant-error' : '')}><span>{count.toLocaleString()} / {ASSISTANT_LIMITS[tab].toLocaleString()} 字符 · {['user','memory'].includes(tab) ? '自动管理；用户也可编辑' : '仅手动修改'}</span><button className="set-mini-btn assistant-version-entry" disabled={busy} onClick={() => { if (!bindingDirty || window.confirm('放弃未保存的机器人配置并查看版本记录？')) setShowVersions(true) }}>版本记录</button><button className="set-mini-btn" disabled={busy || !drafts[tab]} onClick={() => { if (window.confirm(`清空 ${files[tab]}？保存后会生成新版本。`)) setDrafts(current => ({ ...current,[tab]: '' })) }}>清空文档</button></div>
    </SetGroup>
    <div className="assistant-save"><span className="r-sub">{dirty ? '有未保存的更改' : ''}</span><button className="set-mini-btn primary" disabled={busy || !dirty || !permissionValid || ASSISTANT_DOCUMENTS.some(t => [...drafts[t]].length > ASSISTANT_LIMITS[t])} onClick={() => void save()}>{busy ? '保存中…' : '保存更改'}</button></div>
  </div>
}
function AssistantVersions({ document, dirty, onBack, onRestored }: { document: AssistantDocument; dirty: boolean; onBack(): void; onRestored(value: AssistantDetail): void }): JSX.Element {
  const [versions, setVersions] = useState<DocumentRevision[]>()
  const [sources, setSources] = useState<Record<string,string>>({})
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    void window.uniagent.assistantVersions(document.type).then(value => { if (active) setVersions(value) }, e => { if (active) setError(String(e)) })
    void window.uniagent.listSessions().then(sessions => { if (active) setSources(Object.fromEntries(sessions.filter(session => !!session.config.assistantSnapshot && !session.teamBinding && !session.handoffId).map(session => [session.id,session.title]))) }).catch(() => {})
    return () => { active = false }
  }, [document.type, document.revision])
  const restore = async (version: DocumentRevision) => {
    if (dirty || busy || !window.confirm(`恢复 ${files[document.type]} 的 rev.${version.revision}？会生成新版本，并取消旧记忆复盘。`)) return
    setBusy(true); setError('')
    try {
      await window.uniagent.rollbackAssistantDocument(document.type, version.revision, document.revision)
      onRestored(await window.uniagent.getPersonalAssistant())
    } catch (e) { setError(String(e).includes('revision_conflict') ? '记忆已更新，请返回配置加载最新版本后重试' : String(e)) }
    finally { setBusy(false) }
  }
  const card = (version: DocumentRevision, current: boolean) => <div className="assistant-version-card" key={version.revision}>
    <div className="assistant-version-row"><div><div className="assistant-version-label">rev.{version.revision} · {writer[version.updatedBy]}</div><div className="r-sub">{new Date(version.updatedAt).toLocaleString()}{version.source.sessionId && <>{' · 来源会话：'}{sources[version.source.sessionId] ? <button className="assistant-source-link" disabled={busy || dirty} onClick={() => window.dispatchEvent(new CustomEvent('uniagent-open-assistant-session', { detail: version.source.sessionId }))}>{sources[version.source.sessionId]}</button> : '已删除或不可用'}</>}</div></div>{current ? <span className="assistant-current-version">当前</span> : <button className="set-mini-btn" disabled={busy || dirty} onClick={() => void restore(version)}>{busy ? '恢复中…' : '恢复此版本'}</button>}</div>
    <pre className="assistant-version-content">{version.content || '（空文档）'}</pre>
  </div>
  const current = versions?.find(version => version.revision === document.revision)
  return <div className="assistant-versions">
    <div className="assistant-versions-head"><button className="set-mini-btn" disabled={busy} onClick={onBack}><UiIcon name="back" size={14} />返回助手配置</button><span>{document.type === 'working_rules' ? 'WORKING_RULES.md' : files[document.type]} · 版本记录</span></div>
    <p className="assistant-hint">恢复会生成新版本，并取消正在进行的旧记忆复盘。{dirty && '请先保存或放弃配置草稿，再恢复历史版本。'}</p>
    {error && <p className="assistant-error" role="alert">{error}</p>}
    {!versions && !error && <p className="r-sub">正在加载版本记录…</p>}
    {current && <><div className="set-group-t"><span className="set-group-t-label">当前版本</span></div>{card(current, true)}</>}
    {!!versions?.some(version => version.revision !== document.revision) && <div className="set-group-t"><span className="set-group-t-label">历史版本</span></div>}
    {versions?.filter(version => version.revision !== document.revision).map(version => card(version, false))}
  </div>
}
function input(detail: AssistantDetail): AssistantInput {
  const { enabled, defaultAgentId, defaultModel, defaultPermissionMode, defaultWorkdir, autoReviewEnabled, reviewRuntime } = detail.assistant
  return { enabled, defaultAgentId, defaultModel, defaultPermissionMode, defaultWorkdir, autoReviewEnabled, reviewRuntime }
}
