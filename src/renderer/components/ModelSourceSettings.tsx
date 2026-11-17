import { useEffect, useState, type MutableRefObject } from 'react'
import { AgentIcon } from './AgentIcon'
import { ProviderIcon } from './ProviderIcon'
import { UiIcon, RefreshIcon } from './Icons'
import { ModelSourceCheckbox } from './ModelSourceCheckbox'
import { ModelSourceQuotaView } from './ModelSourceQuota'
import { ModelSourceQuotaEditor } from './ModelSourceQuotaEditor'
import { modelSourceConsoleUrl, validateSourceConsoleUrl } from '@shared/modelSourceQuota'
import { MODEL_SOURCE_TEMPLATES, MODEL_PROTOCOL_NAMES, modelSourcePlanId, modelSourceConnectionIdentity, modelSourceSupportsAgent, officialSourceContextWindow, sourceDraft, preferredSourceEndpoint, sourceModelsForEndpoint, validateModelSource, type ModelSourceBindingInput, type ModelProtocol, type ModelSource, type ModelSourceInput, type ModelSourcesSnapshot, type SourceEndpoint, type SourceConnectionTest } from '@shared/modelSources'
import type { AgentDef } from '@shared/types'

type BindingDraft = ModelSourceBindingInput
const Group = ({ title, action, children, pad = false }: { title: string; action?: React.ReactNode; children: React.ReactNode; pad?: boolean }) => <div className="set-group"><div className="set-group-t"><span className="set-group-t-label">{title}</span><span className="set-group-t-action">{action}</span></div><div className={'set-card' + (pad ? ' pad' : '')}>{children}</div></div>
const sourceIcon = (id: string) => ['deepseek', 'glm', 'mimo', 'kimi', 'ark-coding-plan'].includes(id) ? <ProviderIcon id={id as 'glm'} size={24} /> : id === 'trae' ? <AgentIcon agentId="traex" size={24} /> : <UiIcon name="plug" size={24} />
const publicDraft = (source: ModelSource): ModelSourceInput => ({ id: source.id, name: source.name, preset: source.preset, plan: source.plan, consoleUrl: source.consoleUrl, quotaQuery: source.quotaQuery, enabled: source.enabled, endpoints: structuredClone(source.endpoints), models: structuredClone(source.models) })

export function ModelSourceSettings({ onModelsChanged, navigationGuard }: { onModelsChanged: () => Promise<void>; navigationGuard: MutableRefObject<(() => boolean) | null> }): JSX.Element {
  const [snapshot, setSnapshot] = useState<ModelSourcesSnapshot>()
  const [agents, setAgents] = useState<AgentDef[]>([])
  const [draft, setDraft] = useState<ModelSourceInput>()
  const [draftRevision, setDraftRevision] = useState<string>()
  const [bindings, setBindings] = useState<BindingDraft[]>([])
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [modelInput, setModelInput] = useState('')
  const [reveal, setReveal] = useState(false)
  const [revealedKey, setRevealedKey] = useState('')
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const [connectionTest, setConnectionTest] = useState<SourceConnectionTest>()
  const [queryFeedback, setQueryFeedback] = useState<{ state: 'connected' | 'partial' | 'failed'; message: string }>()
  const [reload, setReload] = useState(0)
  const [quotaBusy, setQuotaBusy] = useState<string[]>([])
  const [configureQuery, setConfigureQuery] = useState(false)
  const [quotaDirty, setQuotaDirty] = useState(false)
  const [quotaSaving, setQuotaSaving] = useState(false)
  const [configureConsole, setConfigureConsole] = useState(false)
  const [consoleInput, setConsoleInput] = useState('')
  const [quotaError, setQuotaError] = useState('')
  useEffect(() => {
    let cancelled = false
    void Promise.all([window.uniagent.getModelSources(), window.uniagent.getLifecycleSnapshot()]).then(([snapshot, agents]) => { if (!cancelled) { setSnapshot(snapshot); setAgents(agents); setError(snapshot.error || ''); void window.uniagent.refreshModelSourceQuotas().then(value => { if (!cancelled) setSnapshot(value) }).catch(() => { if (!cancelled) setQuotaError('额度查询失败，请稍后重试') }) } }).catch(error => { if (!cancelled) setError(String(error.message || error)) })
    const unsubscribe = window.uniagent.onModelSourcesChanged(snapshot => { if (!cancelled) setSnapshot(snapshot) })
    return () => { cancelled = true; unsubscribe() }
  }, [reload])
  useEffect(() => { navigationGuard.current = () => !busy && !quotaSaving && (!(dirty || quotaDirty) || window.confirm('尚有未保存修改，确认离开？')); return () => { navigationGuard.current = null } }, [dirty, quotaDirty, busy, quotaSaving])
  useEffect(() => { if (!draft) setDraftRevision(undefined); else setDraftRevision(current => current ?? snapshot?.revision) }, [!!draft, snapshot?.revision])
  const update = (value: ModelSourceInput) => {
    const connectionChanged = !!draft && modelSourceConnectionIdentity(draft) !== modelSourceConnectionIdentity(value)
    if (connectionChanged) { setReveal(false); setRevealedKey(''); setQueryFeedback(undefined) }
    if (draft?.apiKey !== value.apiKey || connectionChanged || connectionTest && JSON.stringify(draft?.models.find(model => model.id === connectionTest.modelId)?.routes) !== JSON.stringify(value.models.find(model => model.id === connectionTest.modelId)?.routes)) setConnectionTest(undefined)
    setDraft(value); setDirty(true); setError(''); setNotice('')
  }
  const refreshQuota = async (sourceId: string) => {
    if (quotaBusy.includes(sourceId)) return
    setQuotaBusy(ids => [...ids, sourceId]); setQuotaError('')
    try { setSnapshot(await window.uniagent.refreshModelSourceQuotas(sourceId, true)) }
    catch { setQuotaError('额度查询失败，请稍后重试') }
    finally { setQuotaBusy(ids => ids.filter(id => id !== sourceId)) }
  }
  const openConsole = (url: string) => { void window.uniagent.openExternal(url).catch(() => setQuotaError('控制台未能打开，请重试')) }
  const open = (source: ModelSource) => { setConfigureQuery(false); setQuotaDirty(false); setDraftRevision(snapshot?.revision); setConfigureConsole(false); setQuotaError(''); setDraft(publicDraft(source)); setBindings((snapshot?.bindings || []).filter(binding => binding.sourceId === source.id && modelSourceSupportsAgent(source, binding.agentId)).map(({ agentId, enabled, endpointId, modelIds }) => ({ agentId, enabled, endpointId, modelIds: [...modelIds] }))); setDirty(false); setError(''); setNotice(''); setReveal(false); setRevealedKey(''); setConnectionTest(source.connectionTest); setQueryFeedback(undefined) }
  const back = () => { if (navigationGuard.current?.() === false) return; setDraft(undefined); setConfigureQuery(false); setQuotaDirty(false); setDirty(false); setError(''); setNotice(''); setReveal(false); setRevealedKey(''); setConnectionTest(undefined); setQueryFeedback(undefined) }
  const run = async (label: string, task: () => Promise<void>, onFailure?: (message: string) => void) => { if (busy) return; setBusy(label); setError(''); setNotice(''); try { await task() } catch (error: any) { const message = error.message || '操作未完成，请重试'; if (onFailure) onFailure(message); else setError(message) } finally { setBusy('') } }
  const save = () => run('正在保存并应用…', async () => {
    if (!draft || !snapshot) return
    const value = validateModelSource(draft)
    const saved = await window.uniagent.saveModelSource({ source: value, bindings, expectedRevision: draftRevision ?? snapshot.revision, operationId: crypto.randomUUID() })
    setConfigureQuery(false); setQuotaDirty(false); setSnapshot(saved); const source = saved.sources.find(source => source.id === draft.id) || saved.sources.at(-1)
    if (source) { setDraft(publicDraft(source)); setDraftRevision(saved.revision); setDirty(false); setReveal(false); setRevealedKey(''); setConnectionTest(source.connectionTest ?? connectionTest) }
    setNotice(saved.statuses.some(status => status.sourceId === source?.id && ['failed', 'conflict'].includes(status.state)) ? '来源已保存，部分 Agent 尚未生效。' : '来源已保存。')
    await onModelsChanged(); setAgents(await window.uniagent.getLifecycleSnapshot())
  })
  const retry = (id?: string) => run('正在应用…', async () => { setSnapshot(await window.uniagent.applyModelSources(id)); await onModelsChanged() })
  const toggleKey = () => {
    if (reveal) { setReveal(false); setRevealedKey(''); return }
    if (draft?.apiKey || !draft?.id || !savedCredential) { setReveal(true); return }
    void run('正在读取密钥…', async () => { setRevealedKey(await window.uniagent.revealModelSourceCredential(draft.id!, draft.endpoints[0].id, modelSourceConnectionIdentity(draft))); setReveal(true) })
  }
  const test = () => run('正在测试连接…', async () => {
    if (!draft) return
    let source = draft, endpointId = source.endpoints[0]?.id || '', modelId = ''
    const started = Date.now()
    setConnectionTest(undefined)
    try {
      if (source.preset === 'trae') {
        source = { ...await window.uniagent.connectEnterpriseModelSource(), id: draft.id, name: draft.name, enabled: draft.enabled, consoleUrl: draft.consoleUrl }
        update(source)
        endpointId = source.endpoints[0]?.id || ''
      }
      modelId = source.models.find(model => model.routes.some(route => route.endpointId === endpointId))?.id || ''
      if (!modelId) throw new Error('未获取到可验证的模型，请检查连接后重试')
      setConnectionTest(await window.uniagent.testModelSource(source, endpointId, modelId))
    }
    catch (error: any) { setConnectionTest({ state: 'failed', endpointId, modelId, checkedAt: Date.now(), elapsedMs: Date.now() - started, message: error.message || '连接请求未完成' }) }
  })
  const query = () => run('正在查询模型…', async () => {
    if (!draft) return
    setQueryFeedback(undefined)
    const queried = await Promise.allSettled((draft.preset === 'trae' ? draft.endpoints.slice(0, 1) : draft.endpoints).map(async endpoint => ({ endpointId: endpoint.id, models: await window.uniagent.queryModelSource(draft, endpoint.id) })))
    const successful = queried.filter((result): result is PromiseFulfilledResult<{ endpointId: string; models: ModelSource['models'] }> => result.status === 'fulfilled')
    if (!successful.length) throw (queried.find(result => result.status === 'rejected') as PromiseRejectedResult | undefined)?.reason || new Error('模型目录查询失败，可手工添加模型')
    const refreshed = new Set(draft.preset === 'trae' ? draft.endpoints.map(endpoint => endpoint.id) : successful.map(result => result.value.endpointId))
    const merged = structuredClone(draft.models).map(model => ({ ...model, routes: model.routes.filter(route => !refreshed.has(route.endpointId)) }))
    for (const model of successful.flatMap(result => result.value.models)) {
      const previous = merged.find(previous => previous.id === model.id)
      if (previous) {
        const endpoints = new Set(model.routes.map(route => route.endpointId))
        previous.routes = [...previous.routes.filter(route => !endpoints.has(route.endpointId)), ...model.routes]
        const capabilities = { ...model.capabilities, ...previous.capabilities }
        previous.capabilities = capabilities
        previous.maxContextWindow = model.maxContextWindow ?? previous.maxContextWindow
        const limit = officialSourceContextWindow(draft, model.id) ?? previous.maxContextWindow
        if (limit && capabilities.contextWindow && capabilities.contextWindow > limit) capabilities.contextWindow = limit
      } else merged.push(model)
    }
    const models = merged.filter(model => model.routes.length)
    setBindings(bindings.map(binding => { const ids = sourceModelsForEndpoint({ models }, binding.endpointId).map(model => model.id); const modelIds = binding.modelIds.filter(id => ids.includes(id)); return { ...binding, modelIds, enabled: binding.enabled && !!modelIds.length } }))
    update({ ...draft, models }); setQueryFeedback({ state: successful.length < queried.length ? 'partial' : 'connected', message: successful.length < queried.length ? '部分查询失败 · 已保留原配置' : `查询成功 · ${models.length} 个模型` })
  }, message => setQueryFeedback({ state: 'failed', message: `查询失败 · ${message}` }))
  const editEndpoint = (id: string, value: Partial<SourceEndpoint>) => { if (!draft) return; update({ ...draft, endpoints: draft.endpoints.map(endpoint => endpoint.id === id ? { ...endpoint, ...value } : endpoint) }) }
  const bind = (agentId: string, enabled: boolean) => {
    if (!draft) return
    const previous = bindings.find(binding => binding.agentId === agentId)
    const endpoint = draft.endpoints.find(endpoint => endpoint.id === previous?.endpointId) ?? preferredSourceEndpoint(draft, agentId)
    if (!endpoint) return
    const models = sourceModelsForEndpoint(draft, endpoint.id).map(model => model.id)
    setBindings([...bindings.filter(binding => binding.agentId !== agentId), { agentId, enabled, endpointId: endpoint.id, modelIds: previous?.endpointId === endpoint.id && previous.modelIds.length ? previous.modelIds.filter(model => models.includes(model)) : models }]); setDirty(true)
  }
  const addModel = () => {
    if (!draft || !modelInput.trim()) return
    const id = modelInput.trim()
    try { const next = validateModelSource({ ...draft, models: [...draft.models, { id, label: id, routes: draft.endpoints.map(endpoint => ({ endpointId: endpoint.id, upstreamModel: id })) }] }); update(next); setModelInput('') } catch (error: any) { setError(error.message) }
  }
  const modelChoices = (agent: AgentDef, binding: BindingDraft | undefined, models: ModelSource['models']) => binding?.enabled && <details className="model-source-model-choices"><summary>已选 {binding.modelIds.length}／{models.length} 个模型</summary><div className="model-source-model-checks">{models.map(model => <label key={model.id}><ModelSourceCheckbox label={`${agent.name} 使用 ${model.label}`} checked={binding.modelIds.includes(model.id)} disabled={binding.modelIds.length === 1 && binding.modelIds.includes(model.id)} onChange={checked => { setBindings(bindings.map(value => value.agentId === agent.id ? { ...value, modelIds: checked ? [...value.modelIds, model.id] : value.modelIds.filter(id => id !== model.id) } : value)); setDirty(true) }} /><span>{model.label}</span></label>)}</div></details>
  const stateLabel = (id: string) => { const rows = snapshot?.statuses.filter(status => status.sourceId === id) || []; return rows.some(status => ['failed', 'conflict'].includes(status.state)) ? '部分失败' : rows.some(status => status.state === 'applying') ? '应用中' : rows.some(status => status.state === 'applied') ? '已应用' : '未分配或待应用' }
  if (!snapshot) return <><div className="set-detail-sub" role="status">{error || '正在读取模型数据源…'}</div>{error && <button className="set-mini-btn" onClick={() => setReload(value => value + 1)}>重试</button>}</>
  const testing = busy === '正在测试连接…'
  const querying = busy === '正在查询模型…'
  const enterprise = draft?.preset === 'trae'
  const connectionState = testing ? '验证中' : connectionTest?.state === 'connected' ? '已连接' : connectionTest?.state === 'failed' ? '连接失败' : '待验证'
  const verifying = <div className={`model-source-operation-actions${enterprise ? ' model-source-enterprise-verification' : ''}`}>{(enterprise || testing || connectionTest) && <span className={`model-source-key-result model-source-operation-result ${testing ? 'pending' : connectionTest?.state || ''}`} role="status" title={connectionTest ? `${connectionTest.message} · ${connectionTest.modelId} · ${(connectionTest.elapsedMs / 1000).toFixed(1)} 秒` : undefined}>{enterprise ? connectionState : testing ? '正在验证连接' : connectionTest?.state === 'connected' ? 'API Key 验证通过' : connectionTest?.message}</span>}<button className="set-mini-btn" type="button" disabled={!!busy || !enterprise && !draft?.models.length} aria-busy={testing} title={enterprise ? '刷新企业连接和模型目录，再验证连接是否可用' : '发起简短模型请求，验证凭据和连接是否可用'} onClick={() => void test()}><RefreshIcon size={14} className={testing ? 'is-spinning' : undefined} />{testing ? '验证中…' : enterprise ? '验证连接' : '验证 API Key'}</button></div>
  const finishName = (save: boolean) => { if (save && draft && nameInput.trim() && nameInput.trim() !== draft.name) update({ ...draft, name: nameInput.trim() }); setEditingName(false) }
  const savedSource = snapshot.sources.find(source => source.id === draft?.id)
  const savedCredential = !!draft && !!savedSource?.hasCredential && modelSourceConnectionIdentity(draft) === modelSourceConnectionIdentity(savedSource)
  const quotaFor = (source: ModelSource) => ({ ...(snapshot.quotas?.[source.id] ?? { status: 'unsupported' as const }), ...(quotaBusy.includes(source.id) ? { refreshing: true } : {}) })
  const quotaMatches = !!draft && !!savedSource && !draft.apiKey && modelSourceConnectionIdentity(draft) === modelSourceConnectionIdentity(savedSource)
  const configure = () => { if (quotaDirty || quotaSaving) { setQuotaError('请先保存或取消额度查询编辑，再设置控制台地址'); return }; setConsoleInput(draft?.consoleUrl || ''); setConfigureConsole(true) }
  const supportedAgents = draft ? agents.filter(agent => modelSourceSupportsAgent(draft, agent.id)).sort((a, b) => ['codex', 'claude', 'deepseek', 'kimi', 'zcode', 'mcode'].indexOf(a.id) - ['codex', 'claude', 'deepseek', 'kimi', 'zcode', 'mcode'].indexOf(b.id)) : []
  const endpointFields = draft && <>{draft.endpoints.map(endpoint => <div key={endpoint.id} className="model-source-endpoint">
    <select className="set-fld-inp" aria-label="协议" disabled={enterprise} value={endpoint.protocol} onChange={event => editEndpoint(endpoint.id, { protocol: event.target.value as ModelProtocol })}>{Object.entries(MODEL_PROTOCOL_NAMES).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
    <input className="set-fld-inp mono" aria-label="Base URL" readOnly={enterprise} value={endpoint.baseUrl} placeholder="https://api.example.com/v1" onChange={event => editEndpoint(endpoint.id, { baseUrl: event.target.value })} />
    <select className="set-fld-inp" aria-label="认证方式" disabled={enterprise} value={endpoint.auth} onChange={event => editEndpoint(endpoint.id, { auth: event.target.value as SourceEndpoint['auth'] })}><option value="bearer">Bearer</option><option value="x-api-key">x-api-key</option><option value="none">无需认证</option></select>
  </div>)}{!enterprise && <button type="button" className="set-mini-btn" onClick={() => { const id = `endpoint-${draft.endpoints.length + 1}`; update({ ...draft, endpoints: [...draft.endpoints, { id, protocol: 'openai-chat', baseUrl: '', auth: 'bearer' }] }) }}>＋ 添加协议端点</button>}</>
  return <div className="model-source-settings">
    <header className="set-detail-top codex-model-heading">
      {draft && <button className="set-back" onClick={back} disabled={!!busy}><span className="set-caret"><UiIcon name="chevron-right" size={15} /></span>返回数据源</button>}
      <div className="set-detail-title"><div className="sdt-main">{enterprise ? <h2 className="model-source-title">{editingName ? <input className="set-fld-inp" aria-label="数据源名称" autoFocus disabled={!!busy} value={nameInput} onFocus={event => event.target.select()} onChange={event => setNameInput(event.target.value)} onBlur={() => finishName(true)} onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finishName(event.key === 'Enter') } }} /> : <>{draft.name}<button type="button" className="model-source-title-edit" aria-label="编辑数据源名称" title="编辑名称" disabled={!!busy} onClick={() => { setNameInput(draft.name); setEditingName(true) }}><UiIcon name="edit" size={15} /></button></>}</h2> : <h2>{draft ? draft.id ? draft.name : '添加数据源' : '模型配置'}</h2>}{draft && !enterprise && <div className="set-detail-sub">配置连接和模型，再选择生效 Agent。</div>}</div>{draft ? !enterprise && <span className={`model-source-connection-state model-source-status ${connectionTest?.state || ''}`} role="status"><i />{connectionState}</span> : <button className="set-mini-btn primary" onClick={() => { setDraft(sourceDraft('deepseek')); setBindings([]); setDirty(true); setConnectionTest(undefined); setRevealedKey(''); setReveal(false) }}>＋ 添加数据源</button>}</div>
    </header>
    {!draft && error && <div className="update-alert" role="alert"><div className="update-alert-body"><div className="update-alert-title">{error}</div></div></div>}
    {!draft && quotaError && <div className="model-source-quota-error" role="alert">{quotaError}</div>}
    {!draft ? <>
      <Group title="已添加的数据源" action={<span className="set-sub-r">{snapshot.sources.length} 个来源</span>}>
        {!snapshot.sources.length && <div className="set-empty">尚未添加数据源</div>}
        {snapshot.sources.map(source => <div className="row quota-source-row" key={source.id}>
          <button type="button" className="rowlink quota-source-name" onClick={() => open(source)}>{sourceIcon(source.preset)}<span className="r-main"><span className="r-label">{source.name}</span><span className="r-sub">{source.models.length} 个模型 · {source.enabled ? stateLabel(source.id) : '已停用'}</span></span></button>
          {source.preset === 'trae' ? <div className="quota-summary" aria-hidden="true" /> : <ModelSourceQuotaView compact singleAccount={source.preset === 'deepseek'} quota={quotaFor(source)} consoleUrl={modelSourceConsoleUrl(source)} onConsole={openConsole} onQueryConfigure={() => { open(source); setConfigureQuery(true) }} onConfigure={() => { open(source); setConsoleInput(source.consoleUrl || ''); setConfigureConsole(true) }} />}
          <div className="model-source-agent-tags">{snapshot.bindings.filter(binding => binding.sourceId === source.id && binding.enabled && modelSourceSupportsAgent(source, binding.agentId)).map(binding => <span key={binding.agentId}>{agents.find(agent => agent.id === binding.agentId)?.name || binding.agentId}</span>)}</div><button type="button" className="quota-chevron" aria-label={`打开 ${source.name}`} onClick={() => open(source)}><UiIcon name="chevron-right" size={15} /></button>
        </div>)}
      </Group>
      <Group title="接入状态"><div className="row"><div className="r-main"><div className="r-label">模型接入服务</div><div className="r-sub">使用第三方模型时由 UniAgent 管理。</div></div><div className="r-control"><span className="set-sub-r">{({ stopped: '未启动', starting: '启动中', running: '运行中', error: '启动失败' })[snapshot.gateway]}</span><button className="set-mini-btn" disabled={!!busy} onClick={() => void retry()}>重新应用</button></div></div></Group>
    </> : <fieldset disabled={!!busy} className="model-source-form">
      {!draft.id && <div className="model-source-presets">{MODEL_SOURCE_TEMPLATES.map(template => <button key={template.id} type="button" className={`model-source-preset${draft.preset === template.id ? ' selected' : ''}`} onClick={() => { const next = sourceDraft(template.id); update(next); setBindings([]); setQueryFeedback(undefined) }}>{sourceIcon(template.id)}<span>{template.name}</span>{draft.preset === template.id && <UiIcon name="check" size={14} />}</button>)}</div>}
      {!enterprise && <Group title="剩余额度" action={quotaMatches && snapshot.quotas?.[draft.id!]?.checkedAt && <span className="set-sub-r">最近查询 · {new Date(snapshot.quotas[draft.id!].checkedAt!).toLocaleString('zh-CN')}</span>}>
        <ModelSourceQuotaView singleAccount={draft.preset === 'deepseek'} quota={quotaMatches ? quotaFor(savedSource!) : { status: 'unsupported', checkedAt: Date.now(), message: '保存连接配置后可查询额度' }} consoleUrl={modelSourceConsoleUrl(draft)} onRefresh={quotaMatches ? () => void refreshQuota(draft.id!) : undefined} onConsole={openConsole} onConfigure={configure} onQueryConfigure={savedSource ? () => { if (dirty) { setQuotaError('请先保存连接与模型配置，再配置额度查询'); return }; if (!quotaSaving && (!quotaDirty || window.confirm('放弃未保存的额度查询设置？'))) { setConfigureConsole(false); setConfigureQuery(value => !value) } } : undefined} />
        {configureQuery && savedSource && <ModelSourceQuotaEditor key={savedSource.id} source={savedSource} revision={snapshot.revision} disabled={dirty || !quotaMatches} onDirty={setQuotaDirty} onSaving={setQuotaSaving} onConsole={openConsole} onCancel={() => { setConfigureQuery(false); setQuotaDirty(false) }} onSaved={saved => {
          setSnapshot(saved); setConfigureQuery(false); setQuotaDirty(false); setDraftRevision(saved.revision)
          const source = saved.sources.find(source => source.id === savedSource.id)
          if (source) setDraft(current => current ? { ...current, quotaQuery: source.quotaQuery } : current)
          void refreshQuota(savedSource.id)
        }} />}
        {draft.consoleUrl && !configureConsole && <button type="button" className="set-mini-btn quota-edit-console" onClick={configure}>编辑控制台地址</button>}
        {configureConsole && <div className="model-source-console-editor"><label className="set-fld"><span>控制台地址</span><input className="set-fld-inp" aria-label="额度控制台地址" placeholder="https://console.example.com" value={consoleInput} onChange={event => setConsoleInput(event.target.value)} /></label><button type="button" className="set-mini-btn" disabled={quotaDirty || quotaSaving} onClick={() => { try { const consoleUrl = validateSourceConsoleUrl(consoleInput); update({ ...draft, consoleUrl }); setConfigureConsole(false); setQuotaError('') } catch (error: any) { setQuotaError(error.message) } }}>确认地址</button></div>}
        {quotaError && <div className="model-source-quota-error" role="alert">{quotaError}</div>}
      </Group>}
      {quotaDirty && <p className="quota-query-help">请先保存或取消额度查询编辑，再修改连接与模型配置。</p>}
      <fieldset className="model-source-model-fields" disabled={quotaDirty || quotaSaving}>
      <Group title="连接信息" action={connectionTest && <span className="set-sub-r">最近验证 · {new Date(connectionTest.checkedAt).toLocaleString('zh-CN')}</span>} pad>
        {!enterprise && <div className="set-fld-row"><label className="set-fld"><span>数据源名称</span><input className="set-fld-inp" value={draft.name} onChange={event => update({ ...draft, name: event.target.value })} /></label>{(MODEL_SOURCE_TEMPLATES.find(template => template.id === draft.preset)?.plans.length || 0) > 1 && <label className="set-fld"><span>接入方式</span><select className="set-fld-inp" value={modelSourcePlanId(draft) ?? ''} onChange={event => { const next = sourceDraft(draft.preset, event.target.value); const defaultName = sourceDraft(draft.preset, draft.plan).name; update({ ...next, id: draft.id, name: draft.name === defaultName || draft.preset === 'ark-coding-plan' && draft.name === '字节方舟 Coding Plan' ? next.name : draft.name }); setBindings([]); setQueryFeedback(undefined) }}>{MODEL_SOURCE_TEMPLATES.find(template => template.id === draft.preset)?.plans.map(plan => <option key={plan.id} value={plan.id}>{plan.label}</option>)}</select></label>}</div>}
        {enterprise ? verifying : <div className="set-fld model-source-key"><div className="model-source-key-heading"><label htmlFor="model-source-api-key">API Key</label>{verifying}</div><div className="secret-row"><input id="model-source-api-key" className="set-fld-inp" type={reveal ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={draft.apiKey ?? (reveal ? revealedKey : '')} placeholder={savedCredential ? '密钥已保存 · 点击显示可查看' : draft.preset === 'ark-coding-plan' ? `填写 ${draft.plan === 'agent' ? 'Agent Plan' : 'Coding Plan'} 专属 API Key` : '填写对应账号的 API Key'} onChange={event => { setRevealedKey(''); update({ ...draft, apiKey: event.target.value || undefined }) }} /><button type="button" className="set-mini-btn" onClick={toggleKey}>{reveal ? '隐藏' : '显示'}</button></div></div>}
        {enterprise ? <div className="model-source-endpoints"><div>连接地址与协议 · {draft.endpoints.length} 个端点</div>{endpointFields}</div> : <details open={draft.preset === 'custom'}><summary>连接地址与协议 · {draft.endpoints.length} 个端点</summary>{endpointFields}</details>}
      </Group>
      <Group title="模型" action={<div className="model-source-operation-actions">{(querying || queryFeedback) && <span className={`model-source-query-result model-source-operation-result ${querying ? 'pending' : queryFeedback?.state}`} role="status">{querying ? '正在获取模型目录' : queryFeedback?.message}</span>}<button className="set-mini-btn" type="button" aria-busy={querying} onClick={() => void query()}><RefreshIcon size={14} className={querying ? 'is-spinning' : undefined} />{querying ? '查询中…' : '查询模型'}</button></div>}>
        {draft.models.map(model => { const limit = officialSourceContextWindow(draft, model.id) ?? model.maxContextWindow; return <div className="row model-source-model" key={model.id}><div className="r-main"><div className="r-label">{model.label}</div>{model.label !== model.id && <div className="r-sub">{model.id}</div>}</div><label className="model-source-context"><span>上下文窗口 <small>{limit ? `官方上限 ${limit.toLocaleString('en-US')}` : '官方上限未提供'}</small></span><div className="model-source-context-control"><input className="set-fld-inp" aria-label={`${model.id} 上下文窗口`} type="number" min="1" max={limit || 10000000} placeholder="按模型文档填写" value={model.capabilities?.contextWindow || ''} onChange={event => update({ ...draft, models: draft.models.map(value => value.id === model.id ? { ...value, capabilities: { ...value.capabilities, contextWindow: Number(event.target.value) || undefined } } : value) })} /><button type="button" className="set-mini-btn" onClick={() => { update({ ...draft, models: draft.models.filter(value => value.id !== model.id) }); setBindings(bindings.map(binding => ({ ...binding, modelIds: binding.modelIds.filter(id => id !== model.id), enabled: binding.enabled && binding.modelIds.some(id => id !== model.id) }))) }}>移除</button></div></label></div> })}
        {!draft.models.length && <div className="set-empty">可查询目录，或手工添加模型 ID。</div>}
        <div className="codex-source-model-add"><input className="set-fld-inp" placeholder="输入模型 ID" value={modelInput} onChange={event => setModelInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addModel() } }} /><button className="set-mini-btn" type="button" onClick={addModel}>添加模型</button></div>
      </Group>
      <Group title="生效 Agent" action={<span className="set-sub-r">{bindings.filter(binding => binding.enabled).length} 个已选择</span>}>
        {!supportedAgents.length && <div className="set-empty">{draft.preset === 'trae' ? '连接企业模型后选择生效 Agent。' : '当前协议暂无可用 Agent，请检查连接地址与协议。'}</div>}
        {supportedAgents.map(agent => {
          const binding = bindings.find(binding => binding.agentId === agent.id), endpoint = draft.endpoints.find(endpoint => endpoint.id === binding?.endpointId) ?? preferredSourceEndpoint(draft, agent.id)
          const models = endpoint ? sourceModelsForEndpoint(draft, endpoint.id) : []
          const status = snapshot.statuses.find(status => status.sourceId === draft.id && status.agentId === agent.id)
          const disabled = !agent.installed || !models.length
          return <div className="model-source-agent" key={agent.id}><div className="row"><ModelSourceCheckbox label={`在 ${agent.name} 生效`} checked={!!binding?.enabled} disabled={disabled} onChange={checked => bind(agent.id, checked)} /><AgentIcon agentId={agent.id} size={20} /><div className="r-main"><div className="r-label">{agent.name}</div><div className="r-sub">{!agent.installed ? '请先在 Agent 设置中安装' : !models.length ? '暂无可用模型' : status?.message || `${models.length} 个可用模型`}</div></div><div className="r-control">{status && binding?.enabled ? <span className={`model-source-status ${status.state === 'applied' ? 'connected' : ['failed', 'conflict'].includes(status.state) ? 'failed' : ''}`}><i />{({ pending: '待应用', applying: '应用中', applied: '已应用', failed: '应用失败', conflict: '外部变更', unsupported: '不支持' })[status.state]}</span> : <span className="set-sub-r">{binding?.enabled ? '待保存' : '未选择'}</span>}</div></div>{modelChoices(agent, binding, models)}</div>
        })}
      </Group>
      <details><summary>其它 Agent 支持范围</summary><div className="set-detail-sub">{agents.filter(agent => !supportedAgents.some(supported => supported.id === agent.id)).map(agent => agent.name).join('、') || '其它 Agent'}：此来源接入尚未验证；原生 Agent 仍可在 Agent 设置中使用。</div></details>
      <div className="set-detail-sub">新配置按各 Agent 的生效时机应用。</div>
      {((busy && !testing && !querying) || error || notice) && <div className={`model-source-feedback${error ? ' failed' : ''}`} role={error ? 'alert' : 'status'} aria-live="polite"><strong>{!testing && !querying && busy || error || notice}</strong></div>}
      <div className="set-detail-bar"><button type="button" className="set-mini-btn" onClick={() => update({ ...draft, enabled: !draft.enabled })}>{draft.enabled ? '停用来源' : '启用来源'}</button><span className={`dirty${dirty ? ' unsaved' : ''}`}>{dirty ? '尚未保存' : '已保存'}</span>{draft.id && <button type="button" className="set-mini-btn" onClick={() => void retry(draft.id)}>重新应用</button>}<button type="button" className="set-mini-btn primary" disabled={quotaDirty} onClick={() => void save()}>保存并应用</button></div>
      </fieldset>
    </fieldset>}
  </div>
}
