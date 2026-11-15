import { useEffect, useRef, useState } from 'react'
import type { AgentDef, AppSettings, TaskTitleGenerationConfig } from '@shared/types'
import { resolveTaskTitleConfig } from '@shared/taskTitle'
import { settingSection } from '@shared/settingsDefinition'
import { SetGroup, SetRow } from './SettingsPrimitives'
import { ToggleSwitch } from './Icons'
import { SuperAgentConfigPicker } from './SuperAgentConfigPicker'

export function RequirementCurationSettings({ agents, settings, onSaved, onDirtyChange }: {
  agents: AgentDef[]; settings: AppSettings | null; onSaved: (value: AppSettings) => void; onDirtyChange: (dirty: boolean, saving: boolean) => void
}): JSX.Element {
  const [draft, setDraft] = useState<TaskTitleGenerationConfig>(settings?.requirementCuration || { enabled: false })
  const [saving, setSaving] = useState(false), [error, setError] = useState('')
  const editing = useRef(false)
  const saved = settings?.requirementCuration || { enabled: false }
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  useEffect(() => { if (!editing.current) setDraft(saved) }, [settings])
  useEffect(() => { onDirtyChange(dirty, saving) }, [dirty, saving])
  const agent = agents.find(agent => agent.id === draft.agentId)
  const key = (model: { model?: string; modelSource?: TaskTitleGenerationConfig['modelSource'] }) => JSON.stringify([model.model, model.modelSource?.kind || 'native', model.modelSource?.sourceId || ''])
  const selected = agent?.models.find(model => key({ model: model.id, modelSource: model.modelSource }) === key(draft))
  const fields = settingSection('/requirement-tasks/curation').fields
  function edit(value: TaskTitleGenerationConfig): void { editing.current = true; setDraft(value); setError('') }
  async function save(): Promise<void> {
    if (saving) return
    setSaving(true); setError('')
    try {
      const value = await window.uniagent.setAppSettings({ requirementCuration: { ...draft, agentId: draft.agentId, model: draft.model, modelSource: draft.modelSource, effort: draft.effort, kimiThinking: draft.kimiThinking } })
      editing.current = false; setDraft(value.requirementCuration || { enabled: false }); onSaved(value)
    } catch (reason) { setError(String(reason)) } finally { setSaving(false) }
  }
  return <section className="requirement-curation-settings" aria-label="需求后台整理配置">
    <SetGroup title="需求后台整理">
      <SetRow label={fields.enabled.label} sub={fields.enabled.description} control={<ToggleSwitch label={fields.enabled.label} checked={draft.enabled} disabled={!settings || saving} onChange={enabled => edit({ ...draft, enabled })}/>}/>
      <SetRow label="整理 Agent" sub="使用支持系统提示词与图片输入的 Agent。" control={<SuperAgentConfigPicker field="agent" agents={agents} value={{ ...draft, agentId: draft.agentId || '' }} disabled={!settings || saving} label="整理 Agent" onChange={choice => edit({ enabled: draft.enabled, ...choice })}/>}/>
      <SetRow label="整理模型" sub="建议选择低成本模型；不沿用任务执行模型。" control={<SuperAgentConfigPicker field="model" agents={agents} value={{ ...draft, agentId: draft.agentId || '' }} disabled={!agent || saving} label="整理模型" onChange={choice => edit({ enabled: draft.enabled, ...choice })}/>}/>
      <SetRow label="思考强度" control={<SuperAgentConfigPicker field="effort" agents={agents} value={{ ...draft, agentId: draft.agentId || '' }} disabled={!selected || saving} label="整理思考强度" onChange={choice => edit({ enabled: draft.enabled, ...choice })}/>}/>
    </SetGroup>
    <div className="set-detail-bar"><span className="set-detail-sub" role={error ? 'alert' : 'status'}>{error || (dirty ? '配置尚未保存' : '每个需求复用一个 Session；保存后从下一整理项生效。')}</span><button className="set-mini-btn primary" disabled={!dirty || saving || draft.enabled && !resolveTaskTitleConfig(draft, agents).enabled} onClick={() => void save()}>{saving ? '保存中…' : '保存整理配置'}</button></div>
  </section>
}
