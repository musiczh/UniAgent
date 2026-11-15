import { useEffect, useRef, useState } from 'react'
import type { ForkJob } from '../../shared/sessionFork'
import type { AgentDef } from '../../shared/types'

export function useSessionFork(activeId: string | null, onOpen: (id: string) => Promise<void>, onError: (message: string) => void, agents: AgentDef[] = []) {
  const [job, setJob] = useState<ForkJob>()
  const [collapsed, setCollapsed] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [retryModel, setRetryModel] = useState('')
  useEffect(() => setRetryModel(''), [job?.id])
  const refs = useRef({ activeId, onOpen, onError })
  refs.current = { activeId, onOpen, onError }
  const opened = useRef(new Set<string>())
  useEffect(() => {
    let live = true
    if (!window.uniagent.listForkJobs) return
    void window.uniagent.listForkJobs().then(jobs => {
      if (live) setJob(jobs.filter(job => ['running','stopping','failed'].includes(job.status)).sort((a,b) => b.updatedAt - a.updatedAt)[0])
    }).catch(error => { if (live) refs.current.onError(String(error.message || error)) })
    return () => { live = false }
  }, [])
  useEffect(() => {
    if (!job || !['running','stopping'].includes(job.status)) return
    let live = true, timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      try {
        const next = await window.uniagent.getForkJob(job.id)
        if (live && next) { setNow(Date.now()); setJob(current => !current || next.seq >= current.seq ? next : current) }
      } catch (error) { if (live) refs.current.onError(String(error)) }
      if (live) timer = setTimeout(() => { void poll() }, 700)
    }
    void poll()
    return () => { live = false; clearTimeout(timer) }
  }, [job?.id, job?.status])
  useEffect(() => {
    if (!job?.targetSessionId || job.status !== 'completed' || opened.current.has(job.id)) return
    opened.current.add(job.id)
    if (refs.current.activeId === job.sourceSessionId) void refs.current.onOpen(job.targetSessionId).catch(error => refs.current.onError(String(error)))
  }, [job?.id, job?.status, job?.targetSessionId])
  const start = async (planId: string): Promise<void> => {
    try { setJob(await window.uniagent.startFork(planId)); setCollapsed(false); setHidden(false) }
    catch (error) { refs.current.onError(String(error instanceof Error ? error.message : error)) }
  }
  const perform = async (action: () => Promise<ForkJob>): Promise<void> => {
    try { setJob(await action()) } catch (error) { refs.current.onError(String(error)) }
  }
  const running = job && ['running','stopping'].includes(job.status)
  const stageIndex = job && ['preparing','compacting'].includes(job.stage) ? 0 : job && ['exporting','validating'].includes(job.stage) ? 1 : 2
  const view = !job || hidden ? null : collapsed ? (
    <button className="fork-job-collapsed" onClick={() => setCollapsed(false)}>{running ? job.detail : job.status === 'completed' ? '分支已创建，打开' : job.detail}</button>
  ) : <aside className="fork-job-card loading-modal history-confirm-modal" aria-label="会话分叉进度">
    <div className="loading-modal-title">{job.status === 'completed' ? '分支已创建' : '分叉新会话'}</div>
    <div className="fork-job-stages" aria-live="polite">
      {['压缩上下文','导出上下文与历史资料','创建新分支'].map((title, index) => <div key={title} className={index === stageIndex ? 'current' : ''}>
        <span className={running && index === stageIndex ? 'loading-spinner' : 'fork-step-marker'}>{running && index === stageIndex ? '' : index < stageIndex || job.status === 'completed' ? '✓' : index + 1}</span>
        <span>{title}{index === 0 && job.reusedCompaction && job.compacted ? ' · 已复用' : ''}</span>
      </div>)}
    </div>
    <p className="loading-modal-note" role="status">{job.detail}{running ? ` · ${Math.max(0, Math.floor((now - job.createdAt) / 1000))} 秒` : ''}</p>
    {job.error && <p className="history-fork-error" role="alert">{job.error}</p>}
    {job.status === 'failed' && <label className="history-confirm-target"><span>目标模型</span><select className="settings-select" value={retryModel || job.request.targetModel} onChange={event => setRetryModel(event.target.value)}>
      {agents.find(agent => agent.id === job.request.targetAgentId)?.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
    </select></label>}
    {!!job.missing?.length && <details><summary>部分历史资料未保存（{job.missing.length}）</summary><ul className="fork-missing-list">{job.missing.map(item => <li key={item}>{item}</li>)}</ul></details>}
    <div className="rewind-actions">
      {running ? <><button className="loading-modal-cancel" disabled={job.status === 'stopping'} onClick={() => void perform(() => window.uniagent.cancelForkJob(job.id))}>停止分叉</button><button className="fork-btn" onClick={() => setCollapsed(true)}>收起</button></>
        : job.status === 'completed' ? <><button className="loading-modal-cancel" onClick={() => setHidden(true)}>关闭</button><button className="fork-btn" onClick={() => void window.uniagent.revealForkArchive(job.id)}>查看历史资料</button><button className="fork-btn fork-btn-primary" onClick={() => { void refs.current.onOpen(job.targetSessionId!).catch(error => refs.current.onError(String(error))); setCollapsed(true) }}>打开分支</button></>
          : <><button className="loading-modal-cancel" onClick={() => setHidden(true)}>关闭</button><button className="fork-btn fork-btn-primary" onClick={() => void perform(() => window.uniagent.retryForkJob(job.id, !!job.missing?.length, retryModel || undefined))}>{job.missing?.length && !job.allowMissing ? '接受资料缺失并继续' : job.compacted ? '重试导出' : '重试压缩'}</button></>}
    </div>
  </aside>
  return { start, view }
}
