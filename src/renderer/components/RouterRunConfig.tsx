import { useRef, useState } from 'react'
import type { AgentDef } from '@shared/types'
import { resolveRouterConfig, type RouterConfig } from '@shared/router'
import { RunConfigPicker } from './RunConfigPicker'

export function RouterRunConfig({ agents, config }: { agents: AgentDef[]; config?: RouterConfig }): JSX.Element {
  const [saved, setSaved] = useState<RouterConfig>()
  const [draft, setDraft] = useState<RouterConfig>()
  const [saving, setSaving] = useState(false), [error, setError] = useState('')
  const busy = useRef(false)
  const current = saved && (!config || saved.version > config.version) ? saved : config
  if (!current) return <span className="router-config-loading">正在读取配置…</span>
  const choice = draft || current
  const dirty = JSON.stringify(choice) !== JSON.stringify(current)
  const available = resolveRouterConfig(choice, agents)

  async function save(): Promise<void> {
    if (busy.current || !draft || !dirty) return
    busy.current = true; setSaving(true); setError('')
    try {
      const next = await window.uniagent.saveRouterConfig(draft, draft.version)
      setSaved(next.config); setDraft(next.config)
    } catch (reason) { setError(String(reason)) }
    finally { busy.current = false; setSaving(false) }
  }

  return <RunConfigPicker router compact agents={agents} value={choice} summaryValue={current} disabled={saving}
    label="修改 Root Agent 配置" onOpen={() => { setDraft(current); setError('') }}
    onChange={next => { if (!busy.current) setDraft({ ...choice, agentId: next.agentId, model: next.model || '', effort: next.effort }) }}
    footer={<div className="router-config-footer">
      <small>保存后用于下一次分配，当前分配保持原配置。</small>
      {error && <span role="alert">{error}</span>}
      <button type="button" className="set-mini-btn primary" aria-label="保存 Root Agent 配置" disabled={saving || !dirty || choice.enabled && !available.available} onClick={() => void save()}>{saving ? '保存中…' : '保存配置'}</button>
    </div>}/>
}
