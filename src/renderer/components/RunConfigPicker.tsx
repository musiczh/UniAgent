import { useRef, useState, type ReactNode } from 'react'
import type { AgentDef, SessionConfig } from '@shared/types'
import { resolveRouterConfig, routerConfig, routerModels } from '@shared/router'
import { AgentIcon } from './AgentIcon'
import { UiIcon } from './Icons'
import { SubmenuPopover } from './SubmenuPopover'
import { PickerMenuPlacement } from './usePickerMenuPlacement'
import { AgentVersionWarning } from './AgentVersionWarning'
import { SuperAgentConfigPicker } from './SuperAgentConfigPicker'

export type RunChoice = Pick<SessionConfig,'agentId'|'model'|'modelSource'|'effort'|'permissionMode'>
export function RunConfigPicker({agents,value,onChange,router=false,settings=false,label='选择 Agent、模型与思考参数',compact=false,summaryValue,disabled=false,onOpen,footer}:{agents:AgentDef[];value:RunChoice;onChange:(value:RunChoice)=>void;router?:boolean;settings?:boolean;label?:string;compact?:boolean;summaryValue?:RunChoice;disabled?:boolean;onOpen?:()=>void;footer?:ReactNode}):JSX.Element {
  const root=useRef<HTMLDetailsElement>(null)
  const menu=useRef<HTMLDivElement>(null)
  const [open,setOpen]=useState(false)
  const [sub,setSub]=useState<'agent'|'model'|'effort'>('agent')
  const agent=agents.find(row=>row.id===value.agentId), models=agent?(router?routerModels(agent):agent.models):[]
  const model=models.find(row=>row.id===value.model&&JSON.stringify(row.modelSource||{kind:'native'})===JSON.stringify(value.modelSource||{kind:'native'}))
  const displayed=summaryValue||value,displayAgent=summaryValue?agents.find(row=>row.id===displayed.agentId):agent
  const displayModel=summaryValue&&displayAgent?(router?routerModels(displayAgent):displayAgent.models).find(row=>row.id===displayed.model):model
  const close=()=>{if(!footer)root.current?.removeAttribute('open')}
  const effortLabel=(effort?:string)=>effort==='max'?'Max':({low:'低',medium:'中',high:'高',xhigh:'极高',off:'关闭'} as Record<string,string>)[effort||'']||effort||'默认'
  if (settings) return <SuperAgentConfigPicker agents={agents} value={value} onChange={onChange} router={router} disabled={disabled} label={label}/>
  return <details ref={root} className={`sb-menu sb-agent run-config-picker${compact?' is-compact':''}`} onToggle={event=>{setOpen(event.currentTarget.open);if(event.currentTarget.open){setSub('agent');onOpen?.()}}}>
    <summary className="sb-effort-btn" aria-label={label} aria-disabled={disabled} title={`${displayAgent?.name||'选择 Agent'} · ${displayModel?.label||'选择模型'} · ${effortLabel(displayed.effort)}`} onClick={event=>{if(disabled)event.preventDefault()}}>
      <AgentIcon agentId={displayAgent?.id} adapter={displayAgent?.adapter} size={16}/>{!compact&&<span className="sb-effort-agent">{displayAgent?.name||'选择 Agent'}</span>}
      {displayAgent&&<>{!compact&&<span className="title-generator-sep">·</span>}<span className="sb-effort-model">{displayModel?.label||'选择模型'}</span><span className="sb-effort-lvl">{effortLabel(displayed.effort)}</span></>}<UiIcon name="chevron-right" size={13}/>
    </summary>
    <div ref={menu} className="sb-menu-pop">{open&&<PickerMenuPlacement anchorRef={root} menuRef={menu}/>}<div className="sb-menu-label">运行配置</div>
      {(['agent','model','effort'] as const).map(key=><div className="sb-sub-wrap" key={key}>
        <button type="button" className={`sb-menu-item sb-sub-entry ${sub===key?'is-sub-open':''}`} onClick={()=>setSub(key)} disabled={disabled||key!=='agent'&&!agent} aria-expanded={sub===key}>
          <UiIcon name={key==='agent'?'bot':key==='model'?'model':'sliders'} size={14}/><span className="sb-entry-body">{key==='agent'?'Agent':key==='model'?'模型':'思考强度'}<small>{key==='agent'?agent?.name:key==='model'?model?.label:effortLabel(value.effort)}</small></span><UiIcon name="chevron-right" size={13}/>
        </button>
        {open&&sub===key&&<SubmenuPopover wide={key==='model'}><div className="sb-menu-label">{key==='agent'?'Agent':key==='model'?'模型':'思考强度'}</div>
          {key==='agent'?agents.map(row=>{
            const selected=row.id===value.agentId
            const choices=router?routerModels(row):row.models,first=choices.find(model=>model.id===row.defaultModel)||choices[0]
            const unavailable=router?resolveRouterConfig(routerConfig({agentId:row.id,model:first?.id||'',effort:undefined}),[row]):{available:!!row.installed&&!row.incompatible&&!row.authenticationRequired}
            return <button key={row.id} type="button" role="option" aria-selected={selected} className={`sb-menu-item sb-sub-opt ${selected?'is-sel':''}`} disabled={disabled||!unavailable.available} title={'reason' in unavailable?unavailable.reason:undefined} onClick={()=>{
              onChange({agentId:row.id,model:first?.id,modelSource:first?.modelSource,effort:router&&first?.efforts.includes('max')?'max':undefined});setSub('model')
            }}><span className="sb-sub-radio"/><span className="sb-agent-name"><AgentIcon agentId={row.id} adapter={row.adapter} size={14}/>{row.name}</span><UiIcon name="check" size={13} className="sb-sub-check"/></button>
          }):key==='model'?models.map(row=><button key={row.id+JSON.stringify(row.modelSource)} type="button" role="option" aria-selected={row===model} disabled={disabled} className={`sb-menu-item sb-sub-opt ${row===model?'is-sel':''}`} onClick={()=>{
            onChange({...value,model:row.id,modelSource:row.modelSource,effort:row.efforts.includes(value.effort!)?value.effort:router&&row.efforts.includes('max')?'max':undefined});if(row.efforts.length)setSub('effort');else close()
          }}><span className="sb-sub-radio"/><span className="sb-entry-body">{row.label}</span><UiIcon name="check" size={13} className="sb-sub-check"/></button>):(model?.efforts||[]).map(effort=><button key={effort} type="button" role="option" aria-selected={effort===value.effort} disabled={disabled} className={`sb-menu-item sb-sub-opt ${effort===value.effort?'is-sel':''}`} onClick={()=>{onChange({...value,effort});close()}}><span className="sb-sub-radio"/><span className="sb-entry-body">{effortLabel(effort)}</span><UiIcon name="check" size={13} className="sb-sub-check"/></button>)}
        </SubmenuPopover>}
      </div>)}
      <AgentVersionWarning agent={agent}/>
      {footer}
    </div>
  </details>
}
