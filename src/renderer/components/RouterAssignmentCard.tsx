import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { AgentDef, SessionConfig, UAEvent } from '@shared/types'
import { canRetryRouterRequest, routerAssignmentCall, routerOutcomeLabel, type RouterRequest, type RouterResolution } from '@shared/router'
import { routerCardView, type RouterClarificationRound } from '@shared/routerClarification'
import { routerActionLabels as actionLabels, routerDeliveryLabels as deliveryLabels } from '@shared/routerReview'
import { RunConfigPicker, type RunChoice } from './RunConfigPicker'
import { SetSelect } from './SettingsPrimitives'
import { UiIcon } from './Icons'
import './router.css'

export const RouterAssignmentContext=createContext<{requests:RouterRequest[];sessionIds?:string[];agents:AgentDef[];resolve:(input:RouterResolution)=>Promise<unknown>;openTask:(id:string)=>void;openFeedback?:(id:string)=>void}|undefined>(undefined)
export function RouterAssignmentEvent({event}:{event:UAEvent}):JSX.Element|null {
  const context=useContext(RouterAssignmentContext),call=routerAssignmentCall(event)
  const request=context?.requests.find(row=>row.requestId===call?.requestId)
  if(!context||!request)return <details className="card tool-call"><summary>分配任务 · {event.state==='failed'?'调用失败':'正在读取回执'}</summary><pre>{JSON.stringify(event.payload,null,2)}</pre></details>
  const view=routerCardView(request,event)
  return <RouterAssignmentCard key={view.key} request={view.request} clarification={view.clarification} agents={context.agents} resolve={context.resolve} openTask={context.openTask} openFeedback={context.openFeedback} event={event}/>
}
function formatAssignmentDuration(ms:number):string {
  const seconds=Math.max(0,Math.floor(ms/1000)),minutes=Math.floor(seconds/60),hours=Math.floor(minutes/60)
  return hours?`${hours} 小时 ${minutes%60} 分 ${seconds%60} 秒`:minutes?`${minutes} 分 ${seconds%60} 秒`:`${seconds} 秒`
}
function RouterAssignmentTime({request,frozen}:{request:RouterRequest;frozen:boolean}):JSX.Element {
  const timing=request.timing,active=!frozen&&(timing?.runningSince!==undefined||!timing&&['routing','committing'].includes(request.state)&&request.roundStartedAt!==undefined)
  const ticking=active||!frozen&&!!timing&&request.state==='queued'&&timing.startedAt===undefined&&timing.stoppedAt===undefined
  const [now,setNow]=useState(()=>Date.now())
  useEffect(()=>{
    if(!ticking)return
    setNow(Date.now())
    const timer=setInterval(()=>setNow(Date.now()),1000)
    return()=>clearInterval(timer)
  },[ticking,timing?.queuedAt,timing?.runningSince,request.roundStartedAt])
  const waiting=timing?formatAssignmentDuration((timing.startedAt??timing.stoppedAt??now)-timing.queuedAt):undefined
  const elapsed=timing?.startedAt!==undefined?timing.elapsedMs+(active&&timing.runningSince!==undefined?Math.max(0,now-timing.runningSince):0)
    :active&&request.roundStartedAt!==undefined?Math.max(0,now-request.roundStartedAt):undefined
  const text=`${waiting===undefined?'等待未记录':'等待 '+waiting} · ${elapsed===undefined?timing?'分配未开始':'分配未记录':(active?'分配中 ':'分配 ')+formatAssignmentDuration(elapsed)}`
  return <span className="router-assignment-time" data-motion-ignore aria-label={'分配用时：'+text} title="等待：本轮入队至开始分配；分配：开始至结果及投递处理完成，等待补充信息期间暂停。">{text}</span>
}
export function RouterAssignmentCard({request,clarification,agents,resolve,openTask,openFeedback,event}:{request:RouterRequest;clarification?:RouterClarificationRound;agents:AgentDef[];resolve:(input:RouterResolution)=>Promise<unknown>;openTask:(id:string)=>void;openFeedback?:(id:string)=>void;event?:UAEvent}):JSX.Element|null {
  const first=agents.find(row=>row.installed&&!row.incompatible&&!row.authenticationRequired)
  const [choice,setChoice]=useState<RunChoice>(()=>request.execution||{agentId:first?.id||'',model:first?.defaultModel||first?.models[0]?.id})
  const [answer,setAnswer]=useState(''),[error,setError]=useState(''),[saving,setSaving]=useState(false)
  const [supplementing,setSupplementing]=useState(false),submitting=useRef(false)
  const [selectedOption,setSelectedOption]=useState<number|'custom'>()
  const options=request.decision?.clarificationOptions||[],hasOptions=options.length>0||request.decision?.action==='clarify'
  const agent=agents.find(row=>row.id===choice.agentId)
  const conflict=request.state==='needs_input'&&request.decision?.action==='reuse_task'&&request.question?.includes('配置')
  const configure=request.state==='needs_input'&&request.decision?.action!=='clarify'&&!conflict&&!request.execution&&!request.targetId
  async function submit(action:RouterResolution['action'],withAnswer=false){
    if(submitting.current)return
    submitting.current=true
    setSaving(true);setError('')
    try{
      const execution:SessionConfig={...choice,workdir:request.execution?.workdir||'',permissionMode:choice.permissionMode||agent?.capabilities.permissionModes[0]?.id}
      await resolve({requestId:request.requestId,expectedVersion:request.version,action,...(action==='answer'&&hasOptions&&typeof selectedOption==='number'?{answer:options[selectedOption]?.label}:action==='answer'||withAnswer?{answer}:{}),...(action==='configure'||action==='create_new'?{execution}:{})})
      setAnswer('');setSupplementing(false)
    }catch(reason){setError(String(reason))}finally{submitting.current=false;setSaving(false)}
  }
  const retryable=canRetryRouterRequest(request),recovering=request.state==='queued'&&!!request.autoRecovery?.nextAt||request.state==='routing'&&!!request.autoRecovery?.attempts
  const stopped=request.state==='failed'||request.state==='cancelled'
  const assigning=!clarification&&(recovering||request.state==='routing'||request.state==='committing')
  const pending=!clarification&&(['needs_input','failed'].includes(request.state)||request.delivery==='unknown')
  const footerText=clarification?'澄清结束':recovering?'系统正在继续处理，无需操作':retryable?'原输入与附件已保留，无需重新创建任务':request.state==='needs_input'?'尚未发送输入':assigning||['accepted','running'].includes(request.delivery)?undefined:deliveryLabels[request.delivery]
  const failedCall=event?.state==='failed'?event.payload.error??event.payload.output??event.payload.result:undefined
  const errorText=error||request.error||(typeof failedCall==='string'?failedCall:failedCall===undefined?undefined:JSON.stringify(failedCall,null,2))
  if(request.state==='queued'&&!recovering)return null
  return <article className="card router-assignment" data-router-request={request.requestId} data-router-clarification={clarification?.id} data-motion-key={`router:${request.requestId}:${clarification?.id||'current'}`}>
    <header><UiIcon name="router" size={15}/><strong>分配任务</strong><div className="router-assignment-header-actions">
      {openFeedback&&request.state!=='queued'&&request.state!=='routing'&&<button type="button" className="set-mini-btn" onClick={()=>openFeedback(request.requestId)}>反馈</button>}
      {request.targetId&&<button type="button" className="set-mini-btn" onClick={()=>openTask(request.targetId!)}>打开目标任务<UiIcon name="external-link" size={13}/></button>}
    </div><span className={`router-assignment-status ${pending?'pending':request.state==='cancelled'?'cancelled':recovering||['routing','queued','committing'].includes(request.state)?'working':''}`}>{clarification?'澄清结束':routerOutcomeLabel(request)}</span><RouterAssignmentTime request={request} frozen={!!clarification}/></header>
    <div className="router-assignment-body">
      <div className="router-assignment-method"><UiIcon name="router" size={13}/><span>分配方式</span><strong>{request.decision?actionLabels[request.decision.action]:stopped?'未完成分配':'正在判断'}</strong></div>
      {!assigning&&<section className="router-assignment-task" aria-label="本次任务"><h3 className="router-assignment-label"><UiIcon name="file" size={13}/>本次任务</h3><div>
        <p className="router-assignment-task-title">{request.targetTitle||(stopped?'未确定':'正在确定')}</p>
        <div className="router-assignment-ownership">
          {request.projectName&&<span><UiIcon name="folder" size={13}/>{request.projectName}</span>}
          {request.projectName&&request.requirementName&&<span className="router-assignment-ownership-divider">/</span>}
          {request.requirementName&&<span className="router-assignment-requirement"><UiIcon name="file" size={13}/>{request.requirementName}</span>}
          {!request.projectName&&!request.requirementName&&<span>{stopped?'未确定':'正在确定'}</span>}
        </div>
      </div></section>}
      <section className="router-assignment-user-input" aria-label="本次输入"><h3 className="router-assignment-label"><UiIcon name="message-square" size={13}/>本次输入</h3><p className="router-assignment-input">{request.prompt}</p></section>
      {!assigning&&<section className="router-assignment-explanation" aria-label="分配原因"><h3 className="router-assignment-label"><UiIcon name="lightbulb" size={13}/>分配原因</h3><p className="router-assignment-reason">{request.decision?.reason||(request.state==='cancelled'?'本次分配已取消':request.state==='failed'?'本次分配未完成':'正在读取候选')}</p></section>}
    {!!request.supplements?.length&&<div className="router-supplements"><strong>已补充信息</strong>{request.supplements.map((row,index)=><p key={index}>{row.text}{row.attachments?.map(item=><span key={item.path}> · {item.name}</span>)}</p>)}</div>}
    {recovering&&<p className="router-recovery" role="status">{request.autoRecovery?.reason}<small>第 {request.autoRecovery?.attempts} 次自动恢复 · 原输入与附件已保留，无需操作。</small></p>}
    {request.delivery==='unknown'&&<p className="router-recovery pending" role="status">{request.autoRecovery?.nextAt?'正在核对原任务的接收记录，无需操作。':'原目标已保留，暂时无法确认是否已接收；不会重复发送。'}</p>}
    {request.question&&<p className="router-question">{request.question}</p>}
    {hasOptions&&<div className="question-options router-clarification-options" role="radiogroup" aria-label="澄清候选">{options.map((option,index)=>clarification?<div className="router-clarification-option" key={index}>{option.label}{option.description&&<small>{option.description}</small>}</div>:<label className={`question-opt ${selectedOption===index?'checked':''}`} key={index}><input type="radio" name={`router-${request.requestId}`} value={index} checked={selectedOption===index} disabled={saving} onChange={()=>setSelectedOption(index)}/><span>{option.label}{option.description&&<small>{option.description}</small>}</span></label>)}{!clarification&&<label className={`question-opt ${selectedOption==='custom'?'checked':''}`}><input type="radio" name={`router-${request.requestId}`} checked={selectedOption==='custom'} disabled={saving} onChange={()=>setSelectedOption('custom')}/><span>其他</span></label>}</div>}
    {clarification&&<div className="router-clarification-answer"><strong>你的回答</strong><p>{clarification.answer}{clarification.attachments?.map(item=><span key={item.path}> · {item.name}</span>)}</p></div>}
    {!clarification&&configure&&<div className="router-execution"><RunConfigPicker agents={agents} value={choice} onChange={setChoice}/><SetSelect ariaLabel="任务执行权限" value={choice.permissionMode||agent?.capabilities.permissionModes[0]?.id||''} onChange={permissionMode=>setChoice({...choice,permissionMode:permissionMode as SessionConfig['permissionMode']})}>{agent?.capabilities.permissionModes.map(row=><option key={row.id} value={row.id}>{row.label}</option>)}</SetSelect></div>}
    {!clarification&&request.state==='needs_input'&&<div className="router-decision-actions">
      {conflict?<><button className="set-mini-btn primary" disabled={saving} onClick={()=>void submit('continue_original')}>按原任务配置继续</button><button className="set-mini-btn" disabled={saving} onClick={()=>void submit('create_new')}>按本次配置新建</button></>:configure?<button className="set-mini-btn primary" disabled={saving||!choice.agentId||!choice.model} onClick={()=>void submit('configure')}>确认并创建</button>:<>{(!hasOptions||selectedOption==='custom')&&<input aria-label="补充路由信息" value={answer} onChange={event=>setAnswer(event.target.value)} placeholder="补充目标或所属项目…" maxLength={4000}/>}<button className="set-mini-btn primary" disabled={saving||(hasOptions&&selectedOption!=='custom'?selectedOption===undefined||!options[selectedOption]:!answer.trim())} onClick={()=>void submit('answer')}>继续分配</button></>}
    </div>}
    {retryable&&supplementing&&<form className="router-decision-actions" onSubmit={event=>{event.preventDefault();if(answer.trim())void submit('retry',true)}}><input autoFocus aria-label="补充路由信息" value={answer} onChange={event=>setAnswer(event.target.value)} placeholder="补充目标、范围或其它信息…" maxLength={4000}/><button className="set-mini-btn primary" type="submit" disabled={saving||!answer.trim()}>提交并重试</button></form>}
    {errorText&&<p role="alert" className="router-error">{errorText}</p>}
    </div>{(footerText||request.state==='queued'||retryable||request.delivery==='unknown')&&<footer><span>{footerText}</span><div className="router-assignment-actions">
      {request.state==='queued'&&<button className="set-mini-btn" disabled={saving} onClick={()=>void submit('cancel')}>取消分配</button>}
      {retryable&&<><button className="set-mini-btn" disabled={saving} onClick={()=>setSupplementing(true)}>补充信息后重试</button><button className="set-mini-btn primary" disabled={saving} onClick={()=>void submit('retry')}>{saving?'提交中…':'重试'}</button></>}
      {request.delivery==='unknown'&&<button className="set-mini-btn primary" disabled={saving||!!request.autoRecovery?.nextAt} onClick={()=>void submit('verify')}>{saving?'正在核对…':'再次核对'}</button>}
    </div></footer>}
  </article>
}
