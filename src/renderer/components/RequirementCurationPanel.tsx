import { useEffect, useRef, useState } from 'react'
import type { RequirementCurationState } from '@shared/requirementTypes'
import type { AgentDef, Session, TaskTitleGenerationConfig } from '@shared/types'
import { sessionDisplayTitle } from '@shared/task'
import { resolveTaskTitleConfig } from '@shared/taskTitle'
import { UiIcon } from './Icons'
import { SuperAgentConfigPicker, type SuperAgentChoice } from './SuperAgentConfigPicker'

const labels = { idle: '空闲', queued: '等待整理', running: '正在整理', failed: '需要重试', unconfigured: '等待配置', paused: '已暂停' }
export function RequirementCurationPanel({ id, initial, sessions = [], onOpenConversation }: { id: string; initial?: RequirementCurationState; sessions?: Session[]; onOpenConversation?: () => void }): JSX.Element {
  const [open, setOpen] = useState(false), [state, setState] = useState(initial), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [storage, setStorage] = useState('')
  const [queuePage, setQueuePage] = useState(0)
  const [failurePage, setFailurePage] = useState(0)
  const [agents, setAgents] = useState<AgentDef[]>([]), [config, setConfig] = useState<TaskTitleGenerationConfig>()
  const [configNote, setConfigNote] = useState(''), [configError, setConfigError] = useState(''), [saving, setSaving] = useState(false)
  const savedConfig = useRef<TaskTitleGenerationConfig>(), savingConfig = useRef(false)
  const queue = state?.queue || [], lastPage = Math.max(0, Math.ceil(queue.length / 6) - 1), page = Math.min(queuePage, lastPage)
  const failures = state?.failures || [], lastFailurePage = Math.max(0, Math.ceil(failures.length / 6) - 1), failedPage = Math.min(failurePage, lastFailurePage)
  useEffect(() => { if (queuePage > lastPage) setQueuePage(lastPage) }, [queuePage, lastPage])
  useEffect(() => { if (failurePage > lastFailurePage) setFailurePage(lastFailurePage) }, [failurePage, lastFailurePage])
  useEffect(() => setState(initial), [initial])
  useEffect(() => {
    if (!open) return
    let live = true
    setConfig(undefined); setConfigNote(''); setConfigError('')
    void Promise.all([window.uniagent.listAgents(), window.uniagent.getAppSettings()]).then(([available, settings]) => {
      if (!live) return
      const value = settings.requirementCuration || { enabled: false }
      setAgents(available); savedConfig.current = value; setConfig(value)
    }, reason => { if (live) setConfigError('整理配置读取失败：' + String(reason)) })
    return () => { live = false }
  }, [id, open])
  useEffect(() => {
    if (!open) return
    let live = true
    const refresh = () => { void window.uniagent.requirementCuration(id).then(value => { if (live) setState(value) }, reason => { if (live) setError(String(reason)) }) }
    refresh(); const timer = setInterval(refresh, 1500)
    return () => { live = false; clearInterval(timer) }
  }, [id, open])
  async function changeConfig(choice: SuperAgentChoice): Promise<void> {
    if (savingConfig.current || !savedConfig.current) return
    setConfigError(''); setConfigNote('')
    setConfig({ enabled: savedConfig.current.enabled, ...choice })
    if (!choice.model) { setConfigNote('选择模型后保存'); return }
    const resolved = resolveTaskTitleConfig({ enabled: true, ...choice }, agents)
    if (!resolved.enabled) { setConfig(savedConfig.current); setConfigError(resolved.reason); return }
    if ((['agentId','model','modelSource','effort','kimiThinking'] as const).every(key => JSON.stringify(choice[key]) === JSON.stringify(savedConfig.current?.[key]))) return
    savingConfig.current = true; setSaving(true)
    try {
      const settings = await window.uniagent.setAppSettings({ requirementCuration: {
        agentId: choice.agentId, model: choice.model, modelSource: choice.modelSource, effort: choice.effort, kimiThinking: choice.kimiThinking
      } })
      savedConfig.current = settings.requirementCuration || { enabled: false }
      setConfig(savedConfig.current); setConfigNote('已保存，从下一个整理任务生效')
    } catch (reason) { setConfig(savedConfig.current); setConfigError('配置未保存：' + String(reason)) }
    finally { savingConfig.current = false; setSaving(false) }
  }
  async function act(action: 'retry' | 'retryFailed' | 'pause' | 'organize'): Promise<void> {
    if (busy) return
    setBusy(true); setError('')
    try { setState(await window.uniagent.requirementCuration(id, action)) } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }
  async function compact(): Promise<void> {
    if (busy) return
    setBusy(true); setError('')
    try {
      const preview = await window.uniagent.requirementStorage(id)
      if (!preview.files) { setStorage('已使用聚合存储，没有待清理的旧副本。'); return }
      if (!window.confirm(`将 ${preview.files} 个旧资料副本（${(preview.bytes / 1024 / 1024).toFixed(1)} MB）压缩备份，校验成功后删除这些零散副本。当前资料仍可按原 ID 读取，原始会话不变。继续？`)) return
      const result = await window.uniagent.requirementStorage(id, preview.token)
      setStorage(`已压缩 ${result.files} 个旧副本；备份：${result.archive}`)
    } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }
  const current = state?.history.find(item => item.id === state.current?.id)
  const status = state?.status || 'idle'
  const titles = new Map(sessions.map(session => [session.id, sessionDisplayTitle(session)]))
  const currentTitle = (current?.title.startsWith('整理任务：') ? current.title.slice(5).trim() : current?.title) || (state?.current?.kind === 'reading' ? '更新需求重点' : queue.length ? '等待处理队列任务' : '暂无整理任务')
  const statusText = status === 'idle' && failures.length ? `本轮已结束 · ${failures.length} 项失败待处理` : status === 'idle' ? '暂无整理任务' : labels[status]
  return <section className="rr-curation">
    <button className="rr-curation-entry" aria-expanded={open} onClick={() => setOpen(value => !value)}><span className="rr-curation-mark"><UiIcon name="sparkles" size={16}/></span><strong>后台整理</strong><span className={'rr-curation-status ' + status}><i/>{labels[status]}</span>{!!queue.length && <span className="rr-curation-count">{queue.length} 项待整理</span>}{!!failures.length && <span className="rr-curation-count rr-curation-failed-count">{failures.length} 项失败</span>}<UiIcon name="chevron-right" size={14}/></button>
    {open && <div className="rr-curation-panel">
      <header><div className="rr-curation-model" title={'Session：' + (state?.sessionId || 'curation-' + id)}><SuperAgentConfigPicker agents={agents} value={{ ...config, agentId: config?.agentId || '' }} label="后台整理模型" className="rr-curation-model-picker" disabled={!config || saving} onChange={choice => void changeConfig(choice)}/></div><span className={'rr-curation-current-pill ' + status} role="status"><i/>{state?.current && <small>{labels[status]}</small>}<strong title={state?.current ? currentTitle : statusText}>{state?.current ? currentTitle : statusText}</strong></span><div className="rr-curation-links">{onOpenConversation && <button className="scope-button" onClick={onOpenConversation}><UiIcon name="message-square" size={14}/>查看会话</button>}</div></header>
      {(saving || configNote) && <small className="rr-curation-config-note" role="status">{saving ? '正在保存整理配置…' : configNote}</small>}
      {(configError || error || state?.lastError) && <p role="alert" className="rr-curation-error"><UiIcon name="alert-circle" size={15}/><span>{configError || error || state?.lastError}</span></p>}
      <div className="rr-curation-lists">{!!queue.length && <details className="rr-curation-queue"><summary><UiIcon name="table-of-contents" size={15}/><strong>待整理</strong><span className="rr-curation-queue-count">{queue.length}</span><small>按顺序处理</small><UiIcon name="chevron-right" size={14}/></summary><ol start={page * 6 + 1}>{queue.slice(page * 6, page * 6 + 6).map((job, index) => {
        const title = job.kind === 'reading' ? '更新需求重点' : titles.get(job.sessionId) || '整理任务摘要'
        return <li key={job.id}><span className="rr-curation-ordinal">{page * 6 + index + 1}</span><span className="rr-curation-queue-title" title={title}>{title}</span><small>{job.kind === 'reading' ? '需求概览' : '任务摘要'}</small></li>
      })}</ol>{lastPage > 0 && <nav className="rr-curation-pagination" aria-label="待整理队列分页"><span>{page * 6 + 1}–{Math.min((page + 1) * 6, queue.length)} / {queue.length}</span><button type="button" aria-label="上一页待整理任务" disabled={!page} onClick={() => setQueuePage(page - 1)}><UiIcon name="chevron-left" size={14}/></button><button type="button" aria-label="下一页待整理任务" disabled={page === lastPage} onClick={() => setQueuePage(page + 1)}><UiIcon name="chevron-right" size={14}/></button></nav>}</details>}
      {!!failures.length && <details className="rr-curation-queue rr-curation-failures"><summary><UiIcon name="alert-circle" size={15}/><strong>失败任务</strong><span className="rr-curation-queue-count">{failures.length}</span><small>已跳过</small><UiIcon name="chevron-right" size={14}/></summary><ol>{failures.slice(failedPage * 6, failedPage * 6 + 6).map(failure => <li key={failure.id}><div className="rr-curation-failure-copy"><strong>{failure.title.replace(/^整理任务：/, '')}</strong><p>{failure.error}</p></div><time dateTime={new Date(failure.failedAt).toISOString()}>{new Date(failure.failedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</time></li>)}</ol>
        {lastFailurePage > 0 && <nav className="rr-curation-pagination" aria-label="失败任务分页"><span>{failedPage * 6 + 1}–{Math.min((failedPage + 1) * 6, failures.length)} / {failures.length}</span><button type="button" aria-label="上一页失败任务" disabled={!failedPage} onClick={() => setFailurePage(failedPage - 1)}><UiIcon name="chevron-left" size={14}/></button><button type="button" aria-label="下一页失败任务" disabled={failedPage === lastFailurePage} onClick={() => setFailurePage(failedPage + 1)}><UiIcon name="chevron-right" size={14}/></button></nav>}
        <div className="rr-curation-failure-footer"><span>重试后加入待整理队尾</span><button className="scope-button" disabled={busy} onClick={() => void act('retryFailed')}>重试失败项</button></div>
      </details>}</div>
      <div className="rr-curation-footer"><div className="rr-curation-actions"><button className="scope-button" disabled={busy} onClick={() => void act('organize')}><UiIcon name="refresh" size={14}/>整理已有任务</button>{status === 'running' || status === 'queued' ? <button className="scope-button" disabled={busy} onClick={() => void act('pause')}>暂停整理</button> : !!queue.length && <button className="scope-button" disabled={busy} onClick={() => void act('retry')}>继续整理</button>}</div><details className="rr-curation-maintenance"><summary><UiIcon name="archive" size={14}/>资料维护<UiIcon name="chevron-down" size={12}/></summary><button className="scope-link" disabled={busy} onClick={() => void compact()}>压缩旧资料副本</button></details></div>
      {storage && <small className="rr-curation-storage" role="status">{storage}</small>}
    </div>}
  </section>
}
