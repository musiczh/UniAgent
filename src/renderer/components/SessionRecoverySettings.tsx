import { useEffect, useRef, useState } from 'react'
import type { AgentDef, AppSettings } from '@shared/types'
import { defaultRecoverySettings, parseRecoverySettings, type RecoveryErrorType, type RecoveryRule, type RecoverySettings } from '@shared/sessionRecovery'
import { SetGroup, SetRow, SetSelect } from './SettingsPrimitives'
import { ToggleSwitch, UiIcon } from './Icons'
import './sessionRecovery.css'
import { settingSection } from '@shared/settingsDefinition'

export function SessionRecoverySettings({ agents, settings, onSaved, onBack }: {
  agents: AgentDef[]; settings: AppSettings | null; onSaved: (settings: AppSettings) => void; onBack: () => void
}): JSX.Element {
  const config = settings?.sessionRecovery || defaultRecoverySettings()
  const fields = settingSection('/general/recovery').fields
  const [page, setPage] = useState<'main' | 'errors' | 'rule'>('main')
  const [errors, setErrors] = useState<RecoveryErrorType[]>([])
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<RecoveryRule>()
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const refresh = async () => {
    setLoading(true)
    try { setErrors(await window.uniagent.getRecoveryErrors()); setError('') }
    catch (cause) { setError(String(cause)) }
    finally { setLoading(false) }
  }
  useEffect(() => { void refresh() }, [])
  const save = async (patch: Partial<RecoverySettings>): Promise<boolean> => {
    if (saving.current || !settings) return false
    saving.current = true
    setBusy(true)
    try {
      const next = parseRecoverySettings({ ...config, ...patch })
      onSaved(await window.uniagent.setAppSettings({ sessionRecovery: next }))
      setError('')
      return true
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false }
    finally { saving.current = false; setBusy(false) }
  }
  const edit = (rule: RecoveryRule) => { setDraft({ ...rule }); setPage('rule'); setError('') }
  const selectedAgent = agents.find(agent => agent.id === config.agentId)
  const judges = agents.filter(agent => agent.adapter === 'codex' || agent.adapter === 'claude')
  const resumableAgents = agents.filter(agent => ['codex', 'traex', 'claude'].includes(agent.adapter)).map(agent => agent.name).join('、')
  const disabled = busy || !settings
  const agentName = (id: string) => agents.find(agent => agent.id === id)?.name || id
  const row = (item: RecoveryErrorType, picker: boolean) => <SetRow key={item.key} label={item.label}
    sub={<><div className="recovery-error-message">{item.message}</div><span>{agentName(item.agentId)}{item.count > 0 && <> · 发生 {item.count} 次 · 最近 {new Date(item.lastSeenAt).toLocaleString('zh-CN')}</>}</span></>}
    control={picker ? <label className="recovery-error-check"><input type="checkbox" checked={config.selectedErrors.includes(item.key)} disabled={disabled}
      onChange={event => void save({ selectedErrors: event.target.checked ? [...config.selectedErrors, item.key] : config.selectedErrors.filter(key => key !== item.key) })} />加入判断</label>
      : <button className="set-mini-btn" disabled={disabled} onClick={() => void save({ selectedErrors: config.selectedErrors.filter(key => key !== item.key) })}>移除</button>} />
  return <div className="recovery-settings">
    <div className="set-detail-top">
      <button className="set-back" disabled={busy} onClick={() => page === 'main' ? onBack() : (setPage('main'), setError(''))}>
        <span className="set-caret"><UiIcon name="chevron-right" size={15} /></span>{page === 'main' ? '返回通用' : '返回会话错误恢复'}
      </button>
      <div className="set-detail-headrow"><div className="set-detail-title"><div className="sdt-main"><h2>{page === 'main' ? '会话错误恢复' : page === 'errors' ? '选择错误类型' : '编辑自然语言规则'}</h2>
        <div className="set-detail-sub">{page === 'main' ? '次数限制 → 执行条件过滤 → 轻量模型判断 → 等待后接续原会话' : page === 'errors' ? '从已出现的错误中选择；加入后仍需模型判断是否重试。' : '用自然语言描述适用情形；同时命中时“不重试”优先。'}</div>
      </div></div></div>
    </div>
    {error && <p className="team-error" role="alert">{error}</p>}
    {page === 'main' && <>
      <SetGroup title="恢复策略">
        <SetRow label={fields.enabled.label} sub={fields.enabled.description} control={<ToggleSwitch checked={config.enabled} disabled={disabled} label={fields.enabled.label} onChange={enabled => void save({ enabled })} />} />
        <SetRow label="判断 Agent" sub="仅用于判断，不改变原会话的 Agent 和模型。" control={<SetSelect value={config.agentId} disabled={disabled} ariaLabel="判断 Agent" onChange={agentId => void save({ agentId, model: '', enabled: false })}>
          <option value="">请选择 Agent</option>{judges.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          {config.agentId && !judges.some(agent => agent.id === config.agentId) && <option value={config.agentId}>{config.agentId}（不可用）</option>}
        </SetSelect>} />
        <SetRow label="判断模型" sub="建议选择轻量模型；使用不同服务来源可减少同时拥堵。" control={<SetSelect value={config.model} disabled={disabled || !selectedAgent} ariaLabel="判断模型" onChange={model => void save({ model })}>
          <option value="">请选择轻量模型</option>{selectedAgent?.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
          {config.model && !selectedAgent?.models.some(model => model.id === config.model) && <option value={config.model}>{config.model}（不可用）</option>}
        </SetSelect>} />
        <SetRow label="最大自动重试次数" sub="每条用户请求独立计数，原始执行不计入；达到上限后停止。" control={<SetSelect value={String(config.maxRetries)} disabled={disabled} ariaLabel="最大自动重试次数" onChange={value => void save({ maxRetries: Number(value) })}>{Array.from({ length: fields.maxRetries.maximum! }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} 次</option>)}</SetSelect>} />
        <SetRow label="初始等待时间" sub="后续逐次加倍并略微错峰，最长 120 秒。" control={<SetSelect value={String(config.initialDelaySeconds)} disabled={disabled} ariaLabel="初始等待时间" onChange={value => void save({ initialDelaySeconds: Number(value) })}>{[...new Set([5, 10, 15, 30, 60, 120, config.initialDelaySeconds])].sort((a, b) => a - b).map(seconds => <option key={seconds} value={seconds}>{seconds} 秒</option>)}</SetSelect>} />
      </SetGroup>
      <p className="assistant-hint">判断 Agent 支持 Codex、Claude Code。{resumableAgents ? `当前支持 ${resumableAgents} 自动接续；其他 Agent 先记录错误。` : '仅对已支持的原生会话接续，不明确的投递状态会停止恢复。'}</p>
      <SetGroup title="错误类型" action={<button className="set-mini-btn" onClick={() => setPage('errors')}>选择错误类型<UiIcon name="chevron-right" size={14} /></button>}>
        {config.selectedErrors.map(key => row(errors.find(item => item.key === key) || { key, agentId: key.split(':')[0], label: '已选错误类型', message: key, count: 0, firstSeenAt: 0, lastSeenAt: 0 }, false))}
        {!config.selectedErrors.length && <SetRow label="尚未选择错误类型" sub="可从已出现的错误中选择，也可以在下方添加自然语言规则。" onClick={() => setPage('errors')} />}
      </SetGroup>
      <p className="assistant-hint">已选 {config.selectedErrors.length} 类。加入列表后仍需模型判断；未加入的错误也可以通过自然语言规则匹配。</p>
      <div className="recovery-rule-columns">{(['retry', 'no-retry'] as const).map(effect => <SetGroup key={effect} title={effect === 'retry' ? '重试规则' : '不重试规则'} action={<button className="set-mini-btn" disabled={disabled || config.rules.length >= 50} onClick={() => edit({ id: crypto.randomUUID(), effect, description: '', enabled: true })}>＋ 添加规则</button>}>
        {config.rules.filter(rule => rule.effect === effect).map(rule => <div className="recovery-rule-row" key={rule.id}><div className="recovery-rule-description">{rule.description}</div><div className="recovery-rule-controls"><span>{rule.enabled ? '已启用' : '已停用'}</span><button className="set-mini-btn" disabled={disabled} onClick={() => edit(rule)}>编辑</button><ToggleSwitch checked={rule.enabled} disabled={disabled} label={`启用规则：${rule.description}`} onChange={enabled => void save({ rules: config.rules.map(item => item.id === rule.id ? { ...item, enabled } : item) })} /></div></div>)}
        {!config.rules.some(rule => rule.effect === effect) && <div className="recovery-rule-row assistant-hint">{effect === 'retry' ? '例如：模型暂时繁忙或容量不足，等待后可以继续。' : '例如：错误明确要求重新登录、充值或修改配置。'}</div>}
      </SetGroup>)}</div>
      <p className="assistant-hint">同时命中时“不重试”优先；次数上限、用户停止等执行约束始终生效。判断失败或应用重启后停止自动恢复。</p>
    </>}
    {page === 'errors' && <>
      <div className="recovery-error-toolbar"><input className="recovery-error-search" aria-label="搜索错误" placeholder="搜索错误、Agent 或原始信息" value={query} onChange={event => setQuery(event.target.value)} /><span>已选 {config.selectedErrors.length} 类</span><button className="set-mini-btn" disabled={loading} onClick={() => void refresh()}>{loading ? '读取中…' : '刷新'}</button></div>
      <SetGroup>{errors.filter(item => `${item.label} ${item.message} ${agentName(item.agentId)}`.toLowerCase().includes(query.trim().toLowerCase())).map(item => row(item, true))}
        {!errors.length && <SetRow label={loading ? '正在读取错误…' : '尚未记录到错误'} sub="会话发生错误后会出现在这里；可先添加自然语言规则。" />}
        {!!errors.length && !errors.some(item => `${item.label} ${item.message} ${agentName(item.agentId)}`.toLowerCase().includes(query.trim().toLowerCase())) && <SetRow label="没有匹配的错误" />}
      </SetGroup>
    </>}
    {page === 'rule' && draft && <>
      <SetGroup title="规则内容" pad><div className="seg mini">{(['retry', 'no-retry'] as const).map(effect => <button key={effect} className={`seg-btn ${draft.effect === effect ? 'active' : ''}`} disabled={busy} onClick={() => setDraft({ ...draft, effect })}>{effect === 'retry' ? '重试' : '不重试'}</button>)}</div>
        <textarea className="recovery-rule-input" aria-label="自然语言规则" maxLength={2000} rows={6} placeholder="描述哪些情形适用这条规则…" value={draft.description} disabled={busy} onChange={event => setDraft({ ...draft, description: event.target.value })} />
        <SetRow label="启用这条规则" control={<ToggleSwitch checked={draft.enabled} disabled={busy} label="启用这条规则" onChange={enabled => setDraft({ ...draft, enabled })} />} />
      </SetGroup>
      <div className="set-detail-bar">{config.rules.some(rule => rule.id === draft.id) && <button className="set-mini-btn danger" disabled={busy} onClick={async () => { if (await save({ rules: config.rules.filter(rule => rule.id !== draft.id) })) setPage('main') }}>删除规则</button>}
        <button className="set-mini-btn" disabled={busy} onClick={() => setPage('main')}>取消</button><button className="set-save-btn" disabled={disabled || !draft.description.trim()} onClick={async () => { if (await save({ rules: config.rules.some(rule => rule.id === draft.id) ? config.rules.map(rule => rule.id === draft.id ? draft : rule) : [...config.rules, draft] })) setPage('main') }}>{busy ? '保存中…' : '保存规则'}</button>
      </div>
    </>}
  </div>
}
