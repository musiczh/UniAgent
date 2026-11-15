import { useEffect, useRef, useState } from 'react'
import type { AgentDef, AppSettings } from '@shared/types'
import { routerConfig, resolveRouterConfig, type RouterConfig } from '@shared/router'
import { SetGroup, SetRow } from './SettingsPrimitives'
import { ToggleSwitch } from './Icons'
import { RunConfigPicker } from './RunConfigPicker'
import { settingSection } from '@shared/settingsDefinition'

export function RouterSettings({agents,settings,onDirtyChange,onReview}:{agents:AgentDef[];settings?:AppSettings|null;onDirtyChange?:(dirty:boolean,saving:boolean)=>void;onReview?:()=>void}):JSX.Element {
  const field = settingSection('/requirement-tasks/router').fields.enabled
  const [saved,setSaved]=useState(()=>routerConfig(settings?.router)),[draft,setDraft]=useState<RouterConfig>(()=>routerConfig(settings?.router))
  const [saving,setSaving]=useState(false),[error,setError]=useState('')
  const alive=useRef(true),draftRef=useRef(draft),savedRef=useRef(saved)
  draftRef.current=draft;savedRef.current=saved
  const dirty=JSON.stringify(saved)!==JSON.stringify(draft),availability=resolveRouterConfig(draft,agents)
  useEffect(()=>{
    alive.current=true
    const refresh=()=>void window.uniagent.getRouterSnapshot().then(snapshot=>{
      if(!alive.current||snapshot.config.version<savedRef.current.version)return
      const pristine=JSON.stringify(draftRef.current)===JSON.stringify(savedRef.current)
      savedRef.current=snapshot.config;setSaved(snapshot.config);if(pristine){draftRef.current=snapshot.config;setDraft(snapshot.config)}
    }).catch(reason=>{if(alive.current)setError(String(reason))})
    refresh();const stop=window.uniagent.onRouterChanged(refresh)
    return()=>{alive.current=false;stop()}
  },[])
  useEffect(()=>{onDirtyChange?.(dirty,saving)},[dirty,saving,onDirtyChange])
  async function save(){setSaving(true);setError('');try{const snapshot=await window.uniagent.saveRouterConfig(draft,saved.version);if(alive.current){setSaved(snapshot.config);setDraft(snapshot.config)}}catch(reason){if(alive.current)setError(String(reason))}finally{if(alive.current)setSaving(false)}}
  return <div className="router-settings">
    <header className="set-detail-top"><div className="set-detail-title"><div className="sdt-main"><h2>RouterAgent</h2><div className="set-detail-sub">自动判断新输入的归属，创建新任务或继续已有任务。</div></div></div></header>
    <SetGroup title="自动分配"><SetRow label={field.label} sub={field.description} control={<ToggleSwitch label={field.label} checked={draft.enabled} disabled={saving||!availability.available&&!draft.enabled} onChange={enabled=>setDraft({...draft,enabled})}/>}/></SetGroup>
    <SetGroup title="路由模型"><SetRow label="运行配置" sub="一起选择 Agent、模型和思考参数。" control={<RunConfigPicker router settings agents={agents} value={draft} disabled={saving} label="选择 Router Agent、模型与思考强度" onChange={choice=>{if(!saving)setDraft({...draft,agentId:choice.agentId,model:choice.model||'',effort:choice.effort})}}/>}/>
      <SetRow label="配置状态" sub={availability.available?`${agents.find(row=>row.id===draft.agentId)?.name} / ${agents.find(row=>row.id===draft.agentId)?.models.find(row=>row.id===draft.model)?.label} · ${draft.effort==='max'?'Max':draft.effort||'默认'}，配置可用。`:availability.reason} control={<span className="status-pill"><i className={`dot ${availability.available&&draft.enabled?'ok':'off'}`}/>{dirty?'未保存':!availability.available?'未配置':saved.enabled?'已保存 · 已启用':'已保存 · 已关闭'}</span>}/>
    </SetGroup>
    {onReview && <SetGroup title="路由反馈"><SetRow label="路由记录与反馈" sub="查看历史输入与分配结果，记录预期并复制优化提示词。" onClick={onReview}/></SetGroup>}
    <div className="set-detail-bar"><span className="dirty" role={error?'alert':undefined}>{error|| (dirty?'配置尚未保存':'配置已保存')}</span><button type="button" className="set-mini-btn primary" disabled={saving||!dirty||draft.enabled&&!availability.available} onClick={()=>void save()}>{saving?'保存中…':'保存配置'}</button></div>
  </div>
}
