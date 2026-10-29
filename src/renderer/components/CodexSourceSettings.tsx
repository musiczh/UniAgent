import { useEffect, useRef, useState, type ReactNode } from 'react'
import { appendCodexSourceModel, CODEX_SOURCE_NAMES, CODEX_SOURCE_PRESETS, type CodexSource, type CodexSourceBalance, type CodexSourceModelIssue, type CodexSourcePreset, type CodexSourcesSnapshot, type CodexSourceInput, type CodexSourceModelQueryInput } from '@shared/codexSources'
import { ToggleSwitch, UiIcon } from './Icons'
import { orderedSourceWindows } from '../codexRateLimits'
import { CLAUDE_SOURCE_PRESETS, type ModelSourceClient, type ReusableCredential } from '@shared/claudeSources'
import { ProviderIcon } from './ProviderIcon'

type Draft = { source: CodexSource; preset: CodexSourcePreset; enabled: boolean; baseUrl: string; models: string[]; apiKey: string; credential?: ReusableCredential }
const normalizeUrl = (value: string): string => value.trim().replace(/\/+$/, '')
function Group({ title, action, children, pad = false }: { title: string; action?: ReactNode; children: ReactNode; pad?: boolean }): JSX.Element {
  return <div className="set-group"><div className="set-group-t"><span className="set-group-t-label">{title}</span>{action && <span className="set-group-t-action">{action}</span>}</div><div className={`set-card${pad ? ' pad' : ''}`}>{children}</div></div>
}

function money(balance: CodexSourceBalance): string {
  const value = Number(balance.total)
  if (!Number.isFinite(value)) return `${balance.currency} ${balance.total}`
  try { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: balance.currency }).format(value) }
  catch { return `${balance.currency} ${balance.total}` }
}

function clock(value?: number): string {
  if (!value) return ''
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(value)
}

function quotaControl(source: CodexSource, refreshing: boolean): ReactNode {
  const quota = source.quota
  if (!source.hasKey || !source.enabled) return null
  // MiMo 的额度接口只认控制台登录态，API Key 无法查询；额度区直接引导到控制台查看。
  const consoleUrl = CODEX_SOURCE_PRESETS[source.preset].consoleUrl
  if (consoleUrl) return <div className="r-control set-quota-ctl">
    <button type="button" className="set-mini-btn" aria-label={`打开 ${CODEX_SOURCE_NAMES[source.id]} 控制台`} onClick={() => void window.uniagent.openExternal(consoleUrl)}><UiIcon name="external-link" size={12} />打开控制台</button>
  </div>
  if (!quota) return <div className="r-control set-quota-ctl"><span className="set-sub-r">{refreshing ? '正在查询额度…' : '额度待刷新'}</span></div>
  const stale = quota.stale && quota.capturedAt ? ` · 上次成功 ${clock(quota.capturedAt)}` : ''
  if (quota.kind === 'balance' && quota.balances?.length) {
    return <div className="r-control set-quota-ctl">
      {quota.balances.map(balance => <span className="set-remain" key={balance.currency}>余额 {money(balance)}</span>)}
      <span className="set-sub-r">{quota.stale ? quota.message : '含充值与赠送余额'}{stale}</span>
    </div>
  }
  if (quota.kind === 'windows' && quota.windows?.length) {
    return <div className="r-control set-quota-ctl codex-source-quota-windows">
      {orderedSourceWindows(quota.windows).map(window => {
        const remaining = Math.round(100 - window.usedPercent)
        const level = remaining <= 10 ? 'danger' : remaining <= 20 ? 'warn' : ''
        return <div className={`codex-source-quota-window ${level}`} key={window.label}>
          <span className="set-sub-r">{window.label}{window.resetsAt ? ` · ${clock(window.resetsAt)} 重置` : ''}</span>
          <span className="set-bar"><i style={{ width: `${window.usedPercent}%` }} /></span>
          <span className="set-remain">剩余 {remaining}%</span>
        </div>
      })}
      {quota.stale && <span className="set-sub-r">{quota.message}{stale}</span>}
    </div>
  }
  return <div className="r-control set-quota-ctl"><span className={`status-pill${quota.status === 'error' ? ' txt-warn' : ''}`}><i className={`dot ${quota.status === 'error' ? 'warn' : 'off'}`} />{quota.message}</span></div>
}

export function SourceRuntimeIssues({ issues = [] }: { issues?: CodexSourceModelIssue[] }): JSX.Element {
  return <>{issues.map(issue => <div className="codex-source-runtime-issue" role="status" key={issue.model}><i />{issue.model} {issue.message}</div>)}</>
}

export function CodexSourceSettings({ onModelsChanged, navigationGuard, client = 'codex' }: {
  client?: ModelSourceClient
  onModelsChanged: () => Promise<void>
  navigationGuard: { current: (() => boolean) | null }
}): JSX.Element {
  const isClaude = client === 'claude'
  const clientName = isClaude ? 'Claude Code' : 'Codex'
  const presets = isClaude ? CLAUDE_SOURCE_PRESETS : CODEX_SOURCE_PRESETS
  const api = {
    get: () => isClaude ? window.uniagent.getClaudeSources() : window.uniagent.getCodexSources(),
    onChanged: (callback: (snapshot: CodexSourcesSnapshot) => void) => isClaude ? window.uniagent.onClaudeSourcesChanged(callback) : window.uniagent.onCodexSourcesChanged(callback),
    save: (input: CodexSourceInput) => isClaude ? window.uniagent.saveClaudeSource(input) : window.uniagent.saveCodexSource(input),
    query: (input: CodexSourceModelQueryInput) => isClaude ? window.uniagent.queryClaudeSourceModels(input) : window.uniagent.queryCodexSourceModels(input)
  }
  const [credentials, setCredentials] = useState<ReusableCredential[]>([])
  const [choosing, setChoosing] = useState<CodexSource | null>(null)
  const [snapshot, setSnapshot] = useState<CodexSourcesSnapshot | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState('')
  const working = useRef(false)
  const configurationPrompt = useRef<HTMLDialogElement>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [modelInput, setModelInput] = useState('')
  const [modelError, setModelError] = useState('')
  const [modelStatus, setModelStatus] = useState('')
  const [reload, setReload] = useState(0)
  const [loading, setLoading] = useState(true)
  const dirty = !!draft && (!!draft.credential || draft.apiKey !== '' || draft.preset !== draft.source.preset || draft.enabled !== draft.source.enabled || draft.baseUrl !== draft.source.baseUrl || draft.models.join('\n') !== draft.source.models.join('\n'))

  useEffect(() => {
    let cancelled = false
    let changed = false
    setLoading(true)
    setError('')
    const unsubscribe = api.onChanged(value => { changed = true; if (!cancelled) setSnapshot(value) })
    void window.uniagent.listModelCredentials(client).then(value => { if (!cancelled) setCredentials(value) }).catch(() => { if (!cancelled) setCredentials([]) })
    void api.get().then(value => { if (!cancelled && !changed) setSnapshot(value) })
      .catch(() => { if (!cancelled) setError('无法读取模型来源配置，请重试') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true; unsubscribe() }
  }, [reload, client])

  useEffect(() => {
    navigationGuard.current = () => !working.current && (!dirty || window.confirm('第三方厂商配置尚未保存，确定放弃修改？'))
    return () => { navigationGuard.current = null }
  }, [dirty, navigationGuard])

  function back(): void {
    if (navigationGuard.current?.() === false) return
    setDraft(null); setShowKey(false); setError(''); setModelInput(''); setModelError(''); setModelStatus('')
  }
  function edit(source: CodexSource): void {
    setDraft({ source, preset: source.preset, enabled: source.hasKey ? source.enabled : true, baseUrl: source.baseUrl, models: [...source.models], apiKey: '' })
    setShowKey(false); setError(''); setNotice(''); setModelInput(''); setModelError(''); setModelStatus('')
  }
  function preset(value: CodexSourcePreset): void {
    const defaults = (presets as typeof CODEX_SOURCE_PRESETS)[value]
    setDraft(current => current && ({ ...current, preset: value, baseUrl: defaults.baseUrl, models: [...defaults.models], apiKey: '', credential: undefined }))
    setShowKey(false); setModelInput(''); setModelError(''); setModelStatus('')
  }
  async function apply(label: string, operation: () => Promise<CodexSourcesSnapshot>): Promise<boolean> {
    if (working.current) return false
    working.current = true; setBusy(label); setError(''); setNotice('')
    try {
      const value = await operation()
      setSnapshot(value)
      setNotice(value.phase === 'error' ? value.message || '应用失败，请重试' : `配置已保存，模型已加入 ${clientName} 的模型列表。`)
      try { await onModelsChanged() } catch { setNotice('配置已保存，模型列表刷新失败，请重新检测 Agent。') }
      if (value.phase === 'error') return false
      setReload(value => value + 1)
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '操作失败，请重试')
      return false
    } finally { working.current = false; setBusy('') }
  }
  async function startService(): Promise<void> {
    if (!snapshot || working.current || snapshot.phase === 'starting') return
    if (!snapshot.sources.some(source => source.hasKey && source.enabled)) {
      setError(''); setNotice(''); configurationPrompt.current?.showModal(); return
    }
    const restarting = snapshot.phase === 'running'
    await apply(restarting ? '重启中…' : '启动中…', () => restarting
      ? window.uniagent.restartCodexSources()
      : window.uniagent.setCodexSourcesEnabled(true))
  }
  async function save(): Promise<void> {
    if (!draft) return
    const models = draft.models.map(value => value.trim()).filter(Boolean)
    if (!draft.credential && !draft.apiKey.trim() && (!draft.source.hasKey || draft.preset !== draft.source.preset || normalizeUrl(draft.baseUrl) !== normalizeUrl(draft.source.baseUrl))) {
      setError('首次配置、切换接入方式或地址时，请填写对应的 API Key'); return
    }
    if (!models.length) { setError('请至少填写一个模型 ID'); return }
    if (new Set(models).size !== models.length) { setError('模型 ID 不能重复'); return }
    if (await apply(isClaude ? '保存中…' : '保存并重启中…', () => api.save({
      id: draft.source.id, preset: draft.preset, enabled: draft.enabled,
      baseUrl: draft.baseUrl.trim(), models, apiKey: draft.apiKey || undefined, credential: draft.credential
    }))) { setDraft(null); setShowKey(false) }
  }
  async function queryModels(): Promise<void> {
    if (!draft || working.current) return
    working.current = true; setBusy('查询模型中…'); setError(''); setModelError(''); setModelStatus('')
    try {
      const models = await api.query({
        id: draft.source.id, preset: draft.preset, baseUrl: draft.baseUrl.trim(), apiKey: draft.apiKey || undefined, credential: draft.credential
      })
      setDraft(current => current && ({ ...current, models }))
      setModelInput(''); setModelStatus('刚刚查询')
    } catch (reason) {
      setModelError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '模型查询失败，请稍后重试')
    } finally { working.current = false; setBusy('') }
  }
  async function testConnection(): Promise<void> {
    if (!draft || working.current) return
    working.current = true; setBusy('测试连接中…'); setError(''); setNotice('')
    try {
      setNotice(await window.uniagent.testClaudeSource({ id: draft.source.id, preset: draft.preset, enabled: draft.enabled,
        baseUrl: draft.baseUrl.trim(), models: draft.models, apiKey: draft.apiKey || undefined, credential: draft.credential }))
    } catch (reason) { setError(String(reason).replace(/^Error: Error invoking remote method '[^']+': (?:Error: )?/, '')) }
    finally { working.current = false; setBusy('') }
  }
  async function reuse(source: CodexSource, credential?: ReusableCredential): Promise<void> {
    const matches = credentials.filter(item => CODEX_SOURCE_PRESETS[item.preset].id === source.id)
    if (!credential && matches.length > 1) { setChoosing(source); return }
    const selected = credential || matches[0]
    setChoosing(null)
    if (!selected) { edit(source); return }
    if (source.hasKey) {
      const defaults = (presets as typeof CODEX_SOURCE_PRESETS)[selected.preset]
      setDraft({ source, preset: selected.preset, enabled: true, baseUrl: defaults.baseUrl, models: [...selected.models], apiKey: '', credential: selected })
      setShowKey(false); setError(''); setNotice(''); return
    }
    await apply(isClaude ? '添加中…' : '添加并启动服务中…', () => window.uniagent.importModelCredential(client, selected))
  }
  function addModel(): void {
    if (!draft) return
    try {
      setDraft({ ...draft, models: appendCodexSourceModel(draft.models, modelInput) })
      setModelInput(''); setError(''); setModelError(''); setModelStatus('')
    } catch (reason) { setModelError(reason instanceof Error ? reason.message : '无法添加模型') }
  }
  function removeModel(model: string): void {
    if (!draft) return
    setDraft({ ...draft, models: draft.models.filter(value => value !== model) })
    setModelError(''); setModelStatus('')
  }
  async function refreshQuotas(): Promise<void> {
    if (snapshot?.quotaRefreshing) return
    setError('')
    try { setSnapshot(await window.uniagent.refreshCodexSourceQuotas()) }
    catch { setError('额度查询失败，请稍后重试') }
  }

  if (loading && !snapshot) return <div className="set-detail-sub" role="status">正在读取第三方厂商配置…</div>
  if (!snapshot) return <div className="update-alert"><div className="update-alert-body"><div className="update-alert-title" role="alert">{error}</div><div className="update-alert-actions"><button className="set-mini-btn" onClick={() => setReload(value => value + 1)}>重试</button></div></div></div>

  const feedback = <>
    {error && <div className="update-alert" role="alert"><div className="update-alert-body"><div className="update-alert-sub">{error}</div></div></div>}
    {notice && <div className="set-detail-sub" role="status">{notice}</div>}
  </>
  if (draft) {
    const requiresKey = !draft.credential && (!draft.source.hasKey || draft.preset !== draft.source.preset || normalizeUrl(draft.baseUrl) !== normalizeUrl(draft.source.baseUrl))
    const presetOptions = Object.entries(presets).filter(([, defaults]) => defaults.id === draft.source.id) as [CodexSourcePreset, { label: string }][]
    return <form onSubmit={event => { event.preventDefault(); void save() }}>
      <div className="set-detail-top">
        <button type="button" className="set-back" onClick={back} disabled={!!busy}><span className="set-caret"><UiIcon name="chevron-right" size={15} /></span>返回来源列表</button>
        <div className="set-detail-title"><ProviderIcon id={draft.source.id} /><div className="sdt-main"><h2>{CODEX_SOURCE_NAMES[draft.source.id]}</h2><div className="set-detail-sub">填写连接信息和要在 {clientName} 中显示的模型。</div></div></div>
      </div>
      <Group title="连接配置" pad>
        {presetOptions.length > 1 && <div className="set-fld"><label htmlFor="codex-source-preset">接入方式</label><select id="codex-source-preset" className="set-fld-inp" disabled={!!busy} value={draft.preset} onChange={event => preset(event.target.value as CodexSourcePreset)}>{presetOptions.map(([value, defaults]) => <option key={value} value={value}>{defaults.label}</option>)}</select></div>}
        {draft.credential && <div className="set-detail-sub" role="status">将从 {draft.credential.label} 重新导入，保存后生效。此处保存独立副本。</div>}
        <div className="set-fld">
          <label htmlFor="codex-source-key">API Key <span className="settings-req">*</span></label>
          <div className="secret-row"><input id="codex-source-key" className="set-fld-inp" type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} disabled={!!busy} value={draft.apiKey} placeholder={requiresKey ? '粘贴对应接入方式的 API Key' : '已安全保存，留空保留原密钥'} onChange={event => { setDraft({ ...draft, apiKey: event.target.value, credential: undefined }); setModelError(''); setModelStatus('') }} /><button type="button" className="set-mini-btn" disabled={!!busy} aria-label="显示或隐藏新输入的密钥" onClick={() => setShowKey(value => !value)}>{showKey ? '隐藏' : '显示'}</button></div>
          <div className="set-detail-sub">从 {CODEX_SOURCE_PRESETS[draft.preset].label} 控制台获取，密钥在本机加密保存。{requiresKey && draft.source.hasKey ? '接入方式或地址已变化，需重新填写密钥。' : ''}</div>
        </div>
        <div className="set-fld"><label htmlFor="codex-source-url">接口地址</label><input id="codex-source-url" className="set-fld-inp mono" type="url" required spellCheck={false} disabled={!!busy} value={draft.baseUrl} onChange={event => { setDraft({ ...draft, baseUrl: event.target.value, credential: undefined }); setModelError(''); setModelStatus('') }} /></div>
      </Group>
      <Group title={`${clientName} 中的模型`} action={<span className="codex-source-model-action"><span className="set-sub-r">{draft.models.length} 个模型{modelStatus ? ` · ${modelStatus}` : ''}</span><button type="button" className="set-mini-btn primary" disabled={!!busy} onClick={() => void queryModels()}>{busy === '查询模型中…' ? '查询中…' : '↻ 自动查询'}</button></span>}>
        {draft.models.length ? <ul className="codex-source-model-list">{draft.models.map(model => <li className="row codex-source-model-row" key={model}><div className="r-main"><div className="r-label">{model}</div></div><div className="r-control"><button type="button" className="codex-source-model-remove" disabled={!!busy} aria-label={`删除模型 ${model}`} onClick={() => removeModel(model)}>×</button></div></li>)}</ul> : <div className="set-empty">暂无模型，可自动查询或手动添加</div>}
        <div className="codex-source-model-add"><input id="codex-source-model-input" className="set-fld-inp mono" type="text" spellCheck={false} disabled={!!busy} value={modelInput} placeholder="输入模型 ID" onChange={event => { setModelInput(event.target.value); setModelError('') }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addModel() } }} /><button type="button" className="set-mini-btn" disabled={!!busy} onClick={addModel}>＋ 添加模型</button></div>
        <div className={`codex-source-model-foot${modelError ? ' error' : ''}`} role={modelError ? 'alert' : 'status'}>{modelError || '自动查询会用厂商返回的最新结果覆盖当前列表；你仍可手动添加或删除。'}</div>
      </Group>
      <Group title="启用"><div className="row"><div className="r-main"><div className="r-label">启用此来源</div><div className="r-sub">保存后，以上模型加入 {clientName} 模型列表。</div></div><div className="r-control"><ToggleSwitch checked={draft.enabled} disabled={!!busy} label="启用此来源" onChange={enabled => setDraft({ ...draft, enabled })} /></div></div></Group>
      {feedback}
      <div className="set-detail-sub">{isClaude ? '测试连接会向首个模型发送一条简短请求。保存后从下一轮生效；已有会话跨厂商需新建会话。' : '保存时启动或重启服务，可能短暂中断正在进行的请求。'}</div>
      <div className="set-detail-bar"><button type="button" className="set-mini-btn" onClick={back} disabled={!!busy}>取消修改</button><span className={`dirty${dirty ? ' unsaved' : ''}`}>{dirty ? '有未保存的修改' : '未修改'}</span>{isClaude && <button type="button" className="set-mini-btn" disabled={!!busy} onClick={() => void testConnection()}>测试连接</button>}<button type="submit" className="set-save-btn" disabled={!!busy}>{busy || (isClaude ? '保存配置' : '保存并重启服务')}</button></div>
    </form>
  }

  const active = snapshot.sources.filter(source => source.hasKey && source.enabled)
  const latestQuotaAt = active.reduce((latest, source) => Math.max(latest, source.quota?.capturedAt || 0), 0)
  const status = { stopped: '已停止', starting: '启动中…', running: '运行中', error: '启动失败' }[snapshot.phase]
  const serviceMessage = error || snapshot.message
  // 同一厂商可有多个接入方式（Kimi Code/API、MiMo API/Token Plan），接入商列表只保留一行。
  const defaultPresets = new Map<CodexSource['id'], { preset: CodexSourcePreset; defaults: (typeof presets)[keyof typeof presets] }>()
  for (const [preset, defaults] of Object.entries(presets) as [CodexSourcePreset, (typeof presets)[keyof typeof presets]][]) {
    if (preset === 'kimi-api' || defaultPresets.has(defaults.id)) continue
    defaultPresets.set(defaults.id, { preset, defaults })
  }
  const sources = [...defaultPresets.values()].map(({ preset, defaults }) => snapshot.sources.find(source => source.id === defaults.id) || { ...defaults, preset, enabled: false, hasKey: false })
  const providerNames = [...new Set(Object.values(presets).map(item => item.id))].map(id => CODEX_SOURCE_NAMES[id]).join('、')
  return <>
    <div className="set-detail-top"><div className="set-detail-title"><div className="sdt-main"><h2>第三方厂商</h2><div className="set-detail-sub">为 {clientName} 添加 {providerNames} 模型。 已有 API Key 可一键复用。</div></div></div></div>
    {snapshot.legacyAvailable && <div className="update-alert"><div className="update-alert-body"><div className="update-alert-title">发现现有 Kimi 接入配置</div><div className="update-alert-sub">可导入已有模型及本机保存的密钥。UniAgent 会先备份配置，再接管启动服务；迁移失败时恢复原服务。</div><div className="update-alert-actions"><button className="set-mini-btn primary" disabled={!!busy} onClick={() => void apply('导入中…', () => window.uniagent.migrateCodexSources())}>{busy || '导入并由 UniAgent 管理'}</button><button className="set-mini-btn" disabled={!!busy} onClick={() => edit(snapshot.sources.find(source => source.id === 'kimi')!)}>手动配置 Kimi</button></div></div></div>}
    {!isClaude && <Group title="接入服务">
      <div className="row">
        <div className="r-main"><div className="r-label">第三方模型接入</div><div className={`r-sub${serviceMessage ? ' txt-warn' : ''}`} role={serviceMessage ? 'alert' : 'status'}>{serviceMessage || (snapshot.phase === 'running' ? `已应用 ${active.length} 个来源 · ${active.reduce((sum, source) => sum + source.models.length, 0)} 个模型` : '启动后随 UniAgent 自动启动。')}</div></div>
        <div className="r-control"><span className="status-pill" role="status" aria-live="polite"><i className={`dot ${snapshot.phase === 'running' ? 'ok' : snapshot.phase === 'error' ? 'warn' : 'off'}`} />{status}</span><button type="button" className="set-mini-btn primary" disabled={!!busy || snapshot.phase === 'starting'} onClick={() => void startService()}>{busy || (snapshot.phase === 'starting' ? '启动中…' : snapshot.phase === 'running' ? '重启服务' : '启动服务')}</button></div>
      </div>
    </Group>}
    {isClaude && serviceMessage && <div className="set-detail-sub txt-warn" role="alert">{serviceMessage}</div>}
    {notice && <div className="set-detail-sub" role="status">{notice}</div>}
    <Group title="接入商" action={!isClaude && <span className="codex-source-quota-action"><span className="set-sub-r">{snapshot.quotaRefreshing ? `正在查询 ${active.length} 个来源` : latestQuotaAt ? `${clock(latestQuotaAt)} 更新` : '额度缓存 5 分钟'}</span><button className="set-mini-btn" disabled={!!busy || snapshot.quotaRefreshing || !active.length} onClick={() => void refreshQuotas()}>{snapshot.quotaRefreshing ? '刷新中…' : '↻ 刷新额度'}</button></span>}>
      {sources.map(source => <div className="row" key={source.id}>
        <ProviderIcon id={source.id} />
        <div className="r-main"><div className="r-label">{CODEX_SOURCE_NAMES[source.id]}</div><div className="r-sub">{source.hasKey ? `${CODEX_SOURCE_PRESETS[source.preset].label} · ${source.models.length} 个模型` : '填入 API Key 后即可启用'}</div><SourceRuntimeIssues issues={source.issues} /></div>
        {!isClaude && quotaControl(source, snapshot.quotaRefreshing)}
        <div className="r-control">
          {source.quota?.status === 'error' && <button className="set-mini-btn" disabled={!!busy || snapshot.quotaRefreshing} onClick={() => void refreshQuotas()}>重试</button>}
          <span className="ver">{source.hasKey ? source.enabled ? '已配置' : '未启用' : '未配置'}</span>
          {credentials.some(item => CODEX_SOURCE_PRESETS[item.preset].id === source.id) && <button className="set-mini-btn primary" disabled={!!busy} onClick={() => void reuse(source)}>{source.hasKey ? '重新导入' : isClaude ? '一键添加' : snapshot.phase === 'running' ? '一键添加并重启' : '一键添加并启动'}</button>}
          <button className="set-mini-btn" disabled={!!busy} onClick={() => edit(source)} aria-label={`配置 ${CODEX_SOURCE_NAMES[source.id]}`}>{source.hasKey ? '配置' : '补充 API Key'}</button>
        </div>
      </div>)}
    </Group>
    {choosing && <Group title={`选择 ${CODEX_SOURCE_NAMES[choosing.id]} 的复用来源`}>{credentials.filter(item => CODEX_SOURCE_PRESETS[item.preset].id === choosing.id).map(item => <div className="row" key={item.id}><div className="r-main">{item.label}</div><button className="set-mini-btn" disabled={!!busy} onClick={() => void reuse(choosing, item)}>使用此来源</button></div>)}<button className="set-mini-btn" onClick={() => setChoosing(null)}>取消</button></Group>}
    <div className="set-detail-sub">导入的是独立副本，原配置修改或退出登录不会自动同步。浏览器登录不能代替 API Key。{isClaude ? '跨厂商请选择新建 Claude 会话。' : '服务运行后，请在 Codex 会话中选择模型。'}</div>
    <div className="set-detail-bar">{!isClaude && <button className="set-mini-btn" disabled={!!busy || !snapshot.enabled} onClick={() => void apply('停止中…', () => window.uniagent.setCodexSourcesEnabled(false))}>停止接入服务</button>}<span className="dirty">密钥仅用于对应接入商</span><button className="set-mini-btn" disabled={!!busy} onClick={() => setReload(value => value + 1)}>刷新可复用配置</button></div>
    <dialog ref={configurationPrompt} className="codex-source-prompt" role="alertdialog" aria-labelledby="codex-source-prompt-title" aria-describedby="codex-source-prompt-message">
      <div className="codex-source-prompt-title" id="codex-source-prompt-title">请先配置接入商</div>
      <p id="codex-source-prompt-message">至少需要先配置并启用一个接入商，再启动服务。</p>
      <form method="dialog" className="codex-source-prompt-actions"><button className="set-mini-btn primary" autoFocus>知道了</button></form>
    </dialog>
  </>
}
