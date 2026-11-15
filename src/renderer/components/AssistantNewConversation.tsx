import { useEffect, useRef, useState } from 'react'
import type { AssistantDetail } from '@shared/assistant'
import { resolveAssistantConversationConfig, type AssistantConversationSelection } from '@shared/assistantConversation'
import type { AgentDef, PrefsData, ReasoningEffort, SessionConfig } from '@shared/types'
import { SetSelect } from './SettingsPrimitives'
import { UiIcon } from './Icons'
import { AgentIcon } from './AgentIcon'

const effortLabels: Record<ReasoningEffort, string> = { off: '关闭', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大', ultra: 'Ultra' }

export function AssistantNewConversation({ agents, pending, error, onClose, onCreate }: {
  agents: AgentDef[]; pending: boolean; error: string
  onClose(): void; onCreate(selection?: AssistantConversationSelection): Promise<void>
}): JSX.Element {
  const [data, setData] = useState<{ detail: AssistantDetail; prefs: PrefsData }>()
  const [selection, setSelection] = useState<AssistantConversationSelection>()
  const [loadError, setLoadError] = useState(''), [retry, setRetry] = useState(0)
  const first = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let live = true
    setLoadError('')
    void Promise.all([window.uniagent.getPersonalAssistant(), window.uniagent.getPrefs()]).then(([detail, prefs]) => {
      if (live) { setData({ detail, prefs }); setSelection(undefined) }
    }, reason => { if (live) setLoadError(String(reason)) })
    return () => { live = false }
  }, [retry])
  useEffect(() => { if (data) first.current?.querySelector('select')?.focus() }, [data])
  const agentId = selection?.agentId || data?.detail.assistant.defaultAgentId || ''
  const agent = agents.find(row => row.id === agentId)
  const pool = agents.filter(row => row.capabilities.startupSystemPrompt && row.lifecycle?.availability === 'available')
  let config: SessionConfig | undefined, configError = ''
  if (data) {
    try { config = resolveAssistantConversationConfig(data.detail.assistant, agent, data.prefs.lastByAgent[agentId], selection) }
    catch (reason) { configError = String(reason instanceof Error ? reason.message : reason) }
  }
  const model = agent?.models.find(row => row.id === config?.model)
  const native = agent?.adapter === 'kimi' || agent?.adapter === 'zcode'
  const efforts = native ? model?.thinkingOptions || [] : agent?.capabilities.reasoningEffort ? model?.efforts || [] : []
  const effort = native ? config?.kimiThinking || config?.zcodeModelSelection?.options?.reasoningLevel : config?.effort
  const disabled = pending || !data
  return <form className="assistant-new-conversation" role="dialog" aria-label="新对话参数" onSubmit={event => {
    event.preventDefault()
    if (!disabled && !configError && !loadError) void onCreate(selection ? { agentId, ...(config?.model ? { model: config.model } : {}),
      ...(efforts.length && effort ? native ? { thinking: effort } : { effort: effort as ReasoningEffort } : {}) } : undefined)
  }}>
    <div className="assistant-new-head"><strong>新对话</strong><button type="button" className="assistant-new-close" aria-label="关闭新对话面板" onClick={onClose}><UiIcon name="close" size={16}/></button></div>
    <div className="assistant-new-defaults"><span><i/>{selection ? '仅本次生效' : '跟随助手默认'}</span>{selection && <button type="button" aria-label="恢复助手默认参数" disabled={disabled} onClick={() => setSelection(undefined)}>恢复默认</button>}</div>
    {loadError ? <p className="assistant-new-error" role="alert">{loadError}<button type="button" onClick={() => setRetry(value => value + 1)}>重试</button></p> : !data ? <p role="status" className="assistant-new-loading">正在读取助手默认参数…</p> : null}
    <div className="assistant-new-field" ref={first}><label>Agent</label><SetSelect value={agentId} ariaLabel="新对话 Agent" disabled={disabled} leading={agent && <AgentIcon agentId={agent.id} adapter={agent.adapter} size={17}/>} onChange={agentId => setSelection({ agentId })}>
      {!pool.some(row => row.id === agentId) && <option value={agentId} disabled>{agent?.name || agentId || '正在读取…'}{agentId ? ' · 不可用' : ''}</option>}
      {pool.map(row => <option value={row.id} key={row.id}>{row.name}</option>)}
    </SetSelect></div>
    <div className="assistant-new-field"><label>模型</label><SetSelect value={config?.model || ''} ariaLabel="新对话模型" disabled={disabled || !agent?.capabilities.modelSelect || !agent.models.length} onChange={model => setSelection({ agentId, model })}>
      {!config?.model && <option value="">{agent?.capabilities.modelSelect ? '暂无可用模型' : '由 Agent 自动选择'}</option>}
      {agent?.capabilities.modelSelect && agent.models.map(row => <option value={row.id} key={row.id}>{row.label || row.id}</option>)}
    </SetSelect></div>
    <div className="assistant-new-field"><label>思考强度</label><SetSelect value={effort || ''} ariaLabel="新对话思考强度" disabled={disabled || !efforts.length} onChange={value => setSelection({ agentId, model: config?.model, ...(native ? { thinking: value } : { effort: value as ReasoningEffort }) })}>
      {!efforts.length && <option value="">该模型不支持调节</option>}
      {efforts.map(value => <option value={value} key={value}>{agent?.adapter === 'kimi' ? value : effortLabels[value as ReasoningEffort] || value}</option>)}
    </SetSelect></div>
    {(error || configError) && <p className="assistant-new-error" role="alert">{error || configError}</p>}
    <p className="assistant-new-note">仅用于新对话，助手默认设置保持不变。</p>
    <div className="assistant-new-footer"><button type="button" className="scope-button" aria-label="取消新对话" onClick={onClose}>取消</button><button type="submit" className="scope-button primary" disabled={disabled || !!configError || !!loadError}>{pending ? '正在创建…' : '创建对话'}</button></div>
  </form>
}
