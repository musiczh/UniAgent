import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react'
import type { AgentDef, Session, UAEvent } from '@shared/types'
import { isSessionBusy } from '@shared/sessionStatus'
import { mergeHydratedEvents } from '@shared/eventSnapshots'
import { DEFAULT_ROUTER_CONFIG, compareRouterQueue, routerAssignmentCall, type RouterSnapshot, type RouterConversationSession } from '@shared/router'
import { routerCardViews } from '@shared/routerClarification'
import { ROUTER_FEEDBACK_PROMPT_DURATION_MS, type RouterReviewPrompt } from '@shared/routerReview'
import { NewTaskPanel } from './NewTaskPanel'
import { SessionConversation } from './SessionConversation'
import { SessionHeader } from './SessionHeader'
import { RouterRunConfig } from './RouterRunConfig'
import { EventStream, ReadOnlyConversationContext, TurnStatusBar } from './EventStream'
import { RouterAssignmentCard, RouterAssignmentContext } from './RouterAssignmentCard'
import { UiIcon } from './Icons'
import { RouterReviewPanel, RouterQuickFeedback } from './RouterReviewPanel'
import './router.css'
import { retireRouterSubmissions, useRouterSubmissions } from '../routerSubmissions'
import { animateSentContent, useLayoutMotion } from '../conversationMotion'

export interface RouterPanelViewState {
  snapshot?: RouterSnapshot
  session?: Session
  events: UAEvent[]
  history: Record<string, UAEvent[]>
  segments: RouterConversationSession[]
}

export function RouterPanel({agents,enabledAgentIds,requirementsEnabled,focusRequestId,onOpenTask,onSettings,onOpenFile,mergeEvent,viewState}:{agents:AgentDef[];enabledAgentIds?:string[];requirementsEnabled?:boolean;focusRequestId?:string;onOpenTask:(id:string)=>void;onSettings:()=>void;onOpenFile?:(path:string,line?:number)=>void;mergeEvent:(events:UAEvent[],event:UAEvent)=>UAEvent[];viewState?:MutableRefObject<RouterPanelViewState|undefined>}):JSX.Element {
  const [snapshot,setSnapshot]=useState(viewState?.current?.snapshot),[session,setSession]=useState(viewState?.current?.session),[events,setEvents]=useState<UAEvent[]>(viewState?.current?.events||[]),[error,setError]=useState('')
  const sessionRef=useRef(session),alive=useRef(true)
  const requestDockRef=useRef<HTMLDivElement>(null)
  const motionRef=useRef<HTMLDivElement>(null)
  const submissions=useRouterSubmissions()
  const [history,setHistory]=useState<Record<string,UAEvent[]>>(viewState?.current?.history||{})
  const [segments,setSegments]=useState<RouterConversationSession[]>(viewState?.current?.segments||[])
  const [loadError,setLoadError]=useState(''),[historyRetry,setHistoryRetry]=useState(0)
  const eventsRef=useRef(events)
  const loadedHistory=useRef(new Set(segments.filter(row=>history[row.sessionId]!==undefined).map(row=>row.sessionId)))
  const incoming=useRef<{id:string;generation:number;events:UAEvent[];status?:Session['status']}>()
  eventsRef.current=events
  const historySessions=useRef(new Set(segments.filter(row=>row.sessionId!==session?.id).map(row=>row.sessionId)))
  const loading=useRef(0),refreshing=useRef(0),creatingRef=useRef(false)
  const [creating,setCreating]=useState(false)
  const [review, setReview] = useState<string>(), [prompt, setPrompt] = useState<RouterReviewPrompt>()
  const [detail,setDetail]=useState<{requestId?:string;sessionId?:string}>(),[detailLoading,setDetailLoading]=useState(false),[detailError,setDetailError]=useState(''),[detailRetry,setDetailRetry]=useState(0),[detailLocated,setDetailLocated]=useState(false)
  useLayoutMotion(motionRef,!!session&&!review&&!detail,'.router-assignment[data-motion-key]')
  const listRef=useRef<HTMLDivElement>(null),listScroll=useRef<number>()
  const detailRequest=snapshot?.requests.find(row=>row.requestId===detail?.requestId)
  const detailSessionId=detail?.sessionId||detailRequest?.routerSessionId||detailRequest?.failure?.sessionId||detailRequest?.recovery?.previousSessionId
  const detailSessionRef=useRef(detailSessionId)
  detailSessionRef.current=detailSessionId
  const dismissed = useRef(new Set<string>())
  function openDetails(requestId?:string,sessionId?:string):void{
    listScroll.current=listRef.current?.querySelector('.event-stream, .router-unavailable')?.scrollTop
    setDetailLocated(false);setDetailRetry(0);setDetailError('');setDetail({requestId,sessionId})
  }
  useLayoutEffect(()=>{
    if(detail||listScroll.current===undefined)return
    const top=listScroll.current
    const frame=requestAnimationFrame(()=>{
      const stream=listRef.current?.querySelector('.event-stream, .router-unavailable')
      if(stream)stream.scrollTop=top
      listScroll.current=undefined
    })
    return()=>cancelAnimationFrame(frame)
  },[detail])
  useEffect(()=>{
    setDetailLoading(false);setDetailError('')
    if(!detailSessionId||detailSessionId===sessionRef.current?.id||loadedHistory.current.has(detailSessionId)&&!detailRetry)return
    let active=true
    historySessions.current.add(detailSessionId)
    setDetailLoading(true)
    void window.uniagent.getEvents(detailSessionId).then(rows=>{
      if(active){loadedHistory.current.add(detailSessionId);setHistory(current=>({...current,[detailSessionId]:mergeHydratedEvents(rows.filter(event=>event.sessionId===detailSessionId),current[detailSessionId]||[],mergeEvent)}))}
    }).catch(reason=>{if(active)setDetailError(String(reason))}).finally(()=>{if(active)setDetailLoading(false)})
    return()=>{active=false}
  },[detailSessionId,detailRetry,mergeEvent])
  useEffect(()=>{
    if(viewState)viewState.current={snapshot,session,events,history,segments}
  },[viewState,snapshot,session,events,history,segments])
  useEffect(() => {
    if (!prompt) setPrompt(snapshot?.feedbackPrompts?.find(row => !dismissed.current.has(row.attemptId) && row.endedAt + ROUTER_FEEDBACK_PROMPT_DURATION_MS > Date.now()))
  }, [snapshot?.feedbackPrompts, prompt])
  const refresh=useCallback(async()=>{
    const version=++refreshing.current
    try{const next=await window.uniagent.getRouterSnapshot();if(alive.current&&version===refreshing.current)setSnapshot(current=>{
      const requests=new Map(current?.requests.map(row=>[row.requestId,row])||[])
      for(const row of next.requests)if(!requests.has(row.requestId)||requests.get(row.requestId)!.version<=row.version)requests.set(row.requestId,row)
      return {...next,requests:[...requests.values()].sort((a,b)=>a.createdAt-b.createdAt)}
    })}catch(reason){if(alive.current&&version===refreshing.current)setError(String(reason))}
  },[])
  useEffect(()=>{
    alive.current=true;void refresh()
    const stopChanged=window.uniagent.onRouterChanged(()=>void refresh())
    const stopEvent=window.uniagent.onEvent(event=>{
      if(event.sessionId===incoming.current?.id)incoming.current.events=mergeEvent(incoming.current.events,event)
      if(event.sessionId===sessionRef.current?.id)setEvents(current=>{const next=mergeEvent(current,event);eventsRef.current=next;return next})
      else if(historySessions.current.has(event.sessionId))setHistory(current=>({...current,[event.sessionId]:mergeEvent(current[event.sessionId]||[],event)}))
    })
    const stopStatus=window.uniagent.onStatusChange(update=>{
      if(update.sessionId===sessionRef.current?.id){sessionRef.current={...sessionRef.current,status:update.status};setSession(sessionRef.current)}
      if(update.sessionId===incoming.current?.id)incoming.current.status=update.status
    })
    return()=>{alive.current=false;refreshing.current++;stopChanged();stopEvent();stopStatus()}
  },[refresh,mergeEvent,agents])
  useEffect(()=>{
    if(!snapshot?.config.enabled&&!snapshot?.sessionId)return
    let active=true
    const generation=++loading.current
    setLoadError('');setError('')
    void window.uniagent.openRouter().then(async next=>{
      if(!next||!active||generation!==loading.current||snapshot?.sessionId&&next.id!==snapshot.sessionId)return
      incoming.current={id:next.id,generation,events:[]}
      const previous=(snapshot?.conversationSessions||[]).filter(row=>row.sessionId!==next.id)
      historySessions.current=new Set([...previous.map(row=>row.sessionId),...(detailSessionRef.current?[detailSessionRef.current]:[])])
      await Promise.all([next.id,...previous.map(row=>row.sessionId)].map(async id=>{
        try{
          const rows=(await window.uniagent.getEvents(id)).filter(event=>event.sessionId===id)
          if(!active||generation!==loading.current)return
          loadedHistory.current.add(id)
          if(id!==next.id){setHistory(current=>({...current,[id]:mergeHydratedEvents(rows,current[id]||[],mergeEvent)}));return}
          const old=sessionRef.current,same=old?.id===next.id
          if(old&&previous.some(row=>row.sessionId===old.id)){loadedHistory.current.add(old.id);setHistory(current=>({...current,[old.id]:mergeHydratedEvents(current[old.id]||[],eventsRef.current,mergeEvent)}))}
          const buffered=incoming.current?.generation===generation?incoming.current.events:[]
          setEvents(current=>mergeHydratedEvents(mergeHydratedEvents(same?current:[],rows,mergeEvent),buffered,mergeEvent))
          setSegments(snapshot?.conversationSessions||[])
          const ready={...next,status:incoming.current?.generation===generation?incoming.current.status||next.status:next.status}
          sessionRef.current=ready;setSession(ready)
        }catch(reason){if(active&&generation===loading.current){if(id===next.id)setLoadError(String(reason));else setError(String(reason))}}
        finally{if(id===next.id&&incoming.current?.generation===generation)incoming.current=undefined}
      }))
    }).catch(reason=>{if(active&&generation===loading.current)setLoadError(String(reason))})
      .finally(()=>{if(incoming.current?.generation===generation)incoming.current=undefined})
    return()=>{active=false}
  },[snapshot?.config.version,snapshot?.sessionId,historyRetry,mergeEvent])
  async function newSession():Promise<void>{
    const id=sessionRef.current?.id
    if(!id||creatingRef.current)return
    creatingRef.current=true;setCreating(true);setError('')
    try{await window.uniagent.newRouterSession(id);await refresh()}
    catch(reason){if(alive.current)setError(String(reason))}
    finally{creatingRef.current=false;if(alive.current)setCreating(false)}
  }
  async function cancelInput(id:string,version:number):Promise<void>{
    setError('')
    try{await window.uniagent.cancelRouterInput(id,version);await refresh()}
    catch(reason){setError(String(reason))}
  }
  const requests=snapshot?.requests||[],queued=requests.filter(row=>row.state==='queued').sort(compareRouterQueue)
  const activeRequestId=snapshot?.activeRequestId||requests.find(row=>row.state==='routing'||row.state==='committing')?.requestId
  const waiting=[...queued.filter((row,index)=>activeRequestId?row.requestId!==activeRequestId:!snapshot?.config.enabled||!snapshot.available||index>0),
    ...submissions.filter(row=>activeRequestId&&!row.error&&!requests.some(request=>request.requestId===row.requestId)).map(row=>({...row,version:0}))]
  const imageOnlyInputs=new Set(requests.filter(row=>row.prompt===''&&row.attachments?.length).map(row=>row.requestId))
  const withOriginalInput=(rows:UAEvent[]):UAEvent[]=>rows.map(event=>{
    if(event.type!=='user_message'||typeof event.payload.displayText==='string')return event
    return imageOnlyInputs.has(event.payload.routedInputId)?{...event,payload:{...event.payload,displayText:''}}:event
  })
  const receivedInputs=new Set([...events,...Object.values(history).flat()].filter(event=>event.type==='user_message').map(event=>event.payload.routedInputId))
  const retiredInputs=new Set([...receivedInputs,...requests.filter(row=>row.state==='cancelled').map(row=>row.requestId)])
  useEffect(()=>{retireRouterSubmissions(retiredInputs)},[events,history,requests])
  const localInputs=submissions.filter(row=>{
    const owner=requests.find(request=>request.requestId===row.requestId)?.routerSessionId||row.routerSessionId
    return !retiredInputs.has(row.requestId)&&!waiting.some(request=>request.requestId===row.requestId)&&(!session||!owner||owner===session.id)
  })
  const conversationEvents=withOriginalInput([...events,...localInputs.map(row=>({sessionId:session?.id||'router-pending',seq:-row.createdAt,ts:row.createdAt,type:'user_message' as const,
    payload:{text:row.prompt,displayText:row.prompt,attachments:row.attachments,optimistic:true,clientTurnKey:row.requestId,routedInputId:row.requestId}}))])
  const submissionError=submissions.at(-1)?.error?`创建任务失败：${submissions.at(-1)!.error}`:undefined
  const orphaned=requests.filter(row=>row.requestId===focusRequestId||row.state==='needs_input'||!row.routerSessionId||row.routerSessionId===session?.id||row.clarifications?.some(round=>round.snapshot.routerSessionId===session?.id))
  const focusedRequest=requests.find(row=>row.requestId===focusRequestId)||requests.find(row=>row.state==='needs_input')
  const conversationRequest=focusedRequest||requests.findLast(row=>row.routerSessionId===session?.id)||(!session?requests.at(-1):undefined)
  const unavailable=!!(snapshot&&!session&&(!snapshot.config.enabled||!snapshot.available))
  const detailEvents:UAEvent[]=detailSessionId?withOriginalInput(detailSessionId===session?.id?conversationEvents:history[detailSessionId]||[])
    :detailRequest?[{sessionId:'router-pending',seq:0,ts:detailRequest.createdAt,type:'user_message',payload:{text:detailRequest.prompt,attachments:detailRequest.attachments}}]:[]
  const detailCallIndex=detailEvents.findIndex(event=>routerAssignmentCall(event)?.requestId===detail?.requestId)
  const detailInput=detailEvents.find(event=>event.type==='user_message'&&event.payload.routedInputId===detail?.requestId)
    ||(detailCallIndex>=0?detailEvents.slice(0,detailCallIndex).findLast(event=>event.type==='user_message'):undefined)
  const resolve=async(input:Parameters<typeof window.uniagent.resolveRouterInput>[0])=>{try{return await window.uniagent.resolveRouterInput(input)}finally{await refresh()}}
  const previousConversation=segments.slice(0,-1).map((row,index)=>{
    const rows=history[row.sessionId]||[],next=segments[index+1]
    const cards=loadedHistory.current.has(row.sessionId)?requests.filter(request=>request.routerSessionId===row.sessionId||request.clarifications?.some(round=>round.snapshot.routerSessionId===row.sessionId)):[]
    return <div key={row.sessionId}>
      <ReadOnlyConversationContext.Provider value><div className="router-history-segment" data-router-history-session={row.sessionId}>
        <EventStream sessionId={row.sessionId} events={withOriginalInput(rows)} status="idle" onJumpToSession={onOpenTask} onOpenFile={onOpenFile}
          routerFallbackRequests={cards}/>
      </div></ReadOnlyConversationContext.Provider>
      <div className="router-agent-switch" role="separator" aria-label={`已切换 Agent：${agents.find(agent=>agent.id===row.agentId)?.name||row.agentId} → ${agents.find(agent=>agent.id===next.agentId)?.name||next.agentId}`}><span>已切换 Agent：{agents.find(agent=>agent.id===row.agentId)?.name||row.agentId} → {agents.find(agent=>agent.id===next.agentId)?.name||next.agentId}</span></div>
    </div>
  })
  const headerSession=session||{id:snapshot?.sessionId||'router',title:'RouterAgent',createdAt:0,status:'draft' as const,config:{agentId:snapshot?.config.agentId||DEFAULT_ROUTER_CONFIG.agentId,workdir:''}}
  const inputQueue=waiting.length>0&&<div className="queue-stack router-input-queue">
    <div className="queue-head"><span className="queue-title">待分配 · {waiting.length}</span><span className="queue-hint">当前分配结束后，按提交顺序处理</span></div>
    {waiting.map((request,index)=><div className="queue-card" key={request.requestId} title={request.prompt} ref={node=>{animateSentContent(node,request.requestId)}}>
      <span className="queue-idx">{index+1}</span><span className="queue-text">{request.prompt.slice(0,80)||'(附件)'}</span>
      {!!request.attachments?.length&&<span className="queue-imgcount"><UiIcon name="paperclip" size={14}/>附件 × {request.attachments.length}</span>}
      <div className="queue-card-acts"><button type="button" className="queue-act queue-del" disabled={!request.version} aria-label="取消待分配任务" title="取消待分配任务" onClick={()=>void cancelInput(request.requestId,request.version)}><UiIcon name="close" size={16}/></button></div>
    </div>)}
  </div>
  return <><div className="session-view" data-router-conversation ref={motionRef} style={{ display: review ? 'none' : undefined }}>
    <SessionHeader session={headerSession} agents={agents} onSettings={onSettings} onNewSession={()=>void newSession()}
      onViewConversation={detail?undefined:()=>openDetails(conversationRequest?.requestId,conversationRequest?conversationRequest.routerSessionId:session?.id||snapshot?.sessionId)}
      onReturn={detail?()=>setDetail(undefined):undefined} returnLabel="返回分配列表"
      titleConfiguration={<RouterRunConfig agents={agents} config={snapshot?.config}/>}
      newSessionBusy={creating||snapshot?.switchingSession} newSessionDisabled={!session||!snapshot?.config.enabled||!snapshot.available||isSessionBusy(session.status)||requests.some(row=>row.state==='routing'||row.state==='committing')}/>
    {(error||submissionError||session&&loadError)&&<p role="alert" className="router-error">{error||submissionError||loadError}</p>}
    {segments.length<2&&session&&snapshot?.sessionNotice?.sessionId===session.id&&<div className="router-session-notice" role="status"><span aria-hidden="true"/><div>{snapshot.sessionNotice.kind==='recovery'?(isSessionBusy(session.status)?'已自动创建新会话，正在继续处理任务':'已自动创建新会话，并接续上一条任务'):'新会话已就绪'}<small>{snapshot.sessionNotice.kind==='recovery'?'原输入和附件已接续；上一会话记录已保留。':'沿用当前配置，上一会话记录已保留。'}</small></div></div>}
    {detail&&<div className="router-detail-view" data-router-detail aria-busy={detailLoading}>
      <SessionConversation sessionId={detailSessionId} events={detailEvents} status={session&&detailSessionId===session.id?session.status:'idle'} readOnly
        loading={detailLoading} loadError={detailError} onRetryLoad={()=>setDetailRetry(value=>value+1)}
        workspaceNotice={!detailSessionId?'暂无对话记录，已保留原始输入':!detailEvents.length?'暂无对话记录':undefined}
        beforeConversation={detailSessionId===session?.id?previousConversation:undefined}
        focusSeq={detailLocated?undefined:detailInput?.seq} onFocusLocated={()=>setDetailLocated(true)} onJumpToSession={onOpenTask} onOpenFile={onOpenFile}/>
    </div>}
    <div className="router-list-view" hidden={!!detail} ref={listRef}>
    {unavailable?<div className="router-unavailable"><div className={`router-disabled ${requests.length?'has-requests':''}`}><h2>{snapshot!.config.enabled?'正在准备 RouterAgent…':'RouterAgent 尚未启用'}</h2><p>{snapshot!.reason||'配置一个可用的 Agent 后启用，新的自动归属输入会在这里排队，分配记录保存在同一段对话中。'}</p><button type="button" className="set-mini-btn primary" onClick={onSettings}><UiIcon name="settings" size={14}/>前往配置</button></div>{requests.flatMap(routerCardViews).map(view=><RouterAssignmentCard key={view.key} request={view.request} clarification={view.clarification} agents={agents} resolve={resolve} openTask={onOpenTask} openFeedback={setReview}/>)}</div>:
      <RouterAssignmentContext.Provider value={{requests,sessionIds:segments.map(row=>row.sessionId),agents,resolve,openTask:onOpenTask,openFeedback:setReview}}>
        <SessionConversation sessionId={session?.id||'router-pending'} events={conversationEvents} status={session?.status||'idle'} loading={!session&&!localInputs.length&&!loadError} loadError={!session?loadError:undefined} onRetryLoad={()=>setHistoryRetry(value=>value+1)} onJumpToSession={onOpenTask} onOpenFile={onOpenFile} focusRouterRequestId={focusedRequest?.requestId}
          requestDockRef={requestDockRef} onRespond={async(requestId,answer)=>{if(!session||sessionRef.current?.id!==session.id)throw new Error('Router 会话已切换，请重新打开提问后回答');await window.uniagent.respondRequest(session.id,requestId,answer)}}
          beforeConversation={previousConversation}
          routerFallbackRequests={orphaned}/>
      </RouterAssignmentContext.Provider>
    }
    </div>
    {unavailable&&inputQueue}
    {!unavailable&&<>
      <TurnStatusBar events={conversationEvents} status={session?.status||'idle'}/>
      {session&&isSessionBusy(session.status)&&<div className="router-input-actions"><button type="button" aria-label="停止当前分配" onClick={()=>{void window.uniagent.interruptRouter().catch(reason=>setError(String(reason)))}}><span aria-hidden="true"/>停止当前分配</button></div>}
      {inputQueue}
      <div className="interaction-dock-slot" ref={requestDockRef}/>
      {snapshot&&<NewTaskPanel agents={agents} enabledAgentIds={enabledAgentIds} requirementsEnabled={requirementsEnabled} routerMode={snapshot} onRouterSubmitted={()=>void refresh()} onOpenSettings={onSettings}/>}
    </>}
    {prompt && <RouterQuickFeedback key={prompt.attemptId} requestId={prompt.requestId} attemptId={prompt.attemptId} endedAt={prompt.endedAt} onDismissError={setError} onClose={() => { dismissed.current.add(prompt.attemptId); setPrompt(undefined); void refresh() }} />}
  </div>
  {review && <RouterReviewPanel key={review} initialRequestId={review} returnLabel="返回对话" onBack={() => setReview(undefined)} onOpenTask={onOpenTask} conversation/>}</>
}
