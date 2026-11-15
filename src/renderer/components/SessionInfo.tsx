import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { AgentDef, Session } from '@shared/types'
import { APP_NAME } from '@shared/distribution'
import { sessionDisplayTitle } from '@shared/task'
import { taskDisplayDescription } from '@shared/taskTitle'
import { formatSessionInfo, sessionInfoSnapshot, type SessionInfo, type SessionInfoField } from '@shared/sessionInfo'
import { AgentIcon } from './AgentIcon'
import { AnchoredPopover } from './AnchoredPopover'
import { UiIcon } from './Icons'
import './sessionInfo.css'

export function SessionInfoTitle({ session, agent, task = false, onOpenGeneration, className, children }: {
  session: Session
  agent?: AgentDef
  task?: boolean
  onOpenGeneration?: () => void
  className: string
  children: ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const dialogId = useId()
  const close = useCallback((restoreFocus = false): void => {
    setOpen(false)
    if (restoreFocus) anchor.current?.focus({ preventScroll: true })
  }, [])
  return <>
    <button ref={anchor} type="button" className={`${className} session-info-trigger${open ? ' is-open' : ''}`}
      title={`${sessionDisplayTitle(session)}${session.config.workdir ? ` · ${session.config.workdir}` : ''}\n点击查看会话信息`}
      aria-label={`查看会话信息：${sessionDisplayTitle(session)}`} aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? dialogId : undefined} onClick={() => setOpen(value => !value)}>
      {children}<UiIcon name="chevron-down" size={12} />
    </button>
    {open && <SessionInfoDialog session={session} agent={agent} task={task} onOpenGeneration={onOpenGeneration ? () => { close(); onOpenGeneration() } : undefined} anchor={anchor} dialogId={dialogId} onClose={close} />}
  </>
}

function SessionInfoDialog({ session, agent, task, onOpenGeneration, anchor, dialogId, onClose }: {
  session: Session
  agent?: AgentDef
  task: boolean
  onOpenGeneration?: () => void
  anchor: RefObject<HTMLButtonElement>
  dialogId: string
  onClose: (restoreFocus?: boolean) => void
}): JSX.Element {
  const base = sessionInfoSnapshot(session)
  const scope = JSON.stringify(base)
  const [attempt, setAttempt] = useState(0)
  const [response, setResponse] = useState<{ scope: string; info?: SessionInfo; error?: string }>()
  const [feedback, setFeedback] = useState('')
  const current = response?.scope === scope ? response : undefined
  const info = current?.info || base
  const loading = !current
  const agentName = agent?.name || session.config.agentId
  const taskInfo = task ? { title: sessionDisplayTitle(session), description: taskDisplayDescription(session) } : undefined
  const taskFields: SessionInfoField[] = taskInfo ? [{ id: 'taskTitle', label: '任务名称', value: taskInfo.title }, { id: 'taskDescription', label: '任务描述', value: taskInfo.description }] : []
  const retry = (): void => { setResponse(undefined); setAttempt(value => value + 1) }

  useEffect(() => {
    let active = true
    setResponse(undefined)
    setFeedback('')
    void window.uniagent.getSessionInfo(session.id).then(info => {
      if (active) setResponse({ scope, info })
    }).catch(() => {
      if (active) setResponse({ scope, error: '会话信息读取失败' })
    })
    return () => { active = false }
  }, [session.id, scope, attempt])

  async function copy(text: string): Promise<void> {
    try { await navigator.clipboard.writeText(text); setFeedback('已复制') }
    catch { setFeedback('复制失败，请重试') }
  }
  async function reveal(fieldId: string): Promise<void> {
    try { await window.uniagent.revealSessionInfoFile(session.id, fieldId); setFeedback('已在 Finder 中显示') }
    catch { setFeedback('无法定位，请重新打开会话信息后重试') }
  }

  return <AnchoredPopover anchor={anchor} id={dialogId} labelledBy={`${dialogId}-title`} onClose={onClose}>
    <div className="session-info-head">
      <div><h2 id={`${dialogId}-title`}>会话信息</h2><p>查看当前会话实际可获取的信息</p></div>
      <button type="button" className="session-info-close" aria-label="关闭会话信息" title="关闭" onClick={() => onClose(true)}><UiIcon name="close" size={16} /></button>
    </div>
    <div className="session-info-content" aria-busy={loading}>
      {[
        { key: 'task', title: '任务信息', caption: '', fields: taskFields, native: false },
        { key: 'native', title: agentName, caption: '原生会话', fields: info.native, native: true },
        { key: 'local', title: APP_NAME, caption: '本地会话与诊断', fields: info.local, native: false }
      ].filter(section => section.fields.length).map(section => <section key={section.key} className="session-info-section">
        <h3>{section.native && <AgentIcon agentId={session.config.agentId} size={16} />}<strong>{section.title}</strong><span>{section.caption}</span></h3>
        <dl>{section.fields.map(field => <div key={field.id} className="session-info-row" data-field={field.id}>
          <dt>{field.label}</dt><dd>{section.key === 'task' ? <span className="session-info-text">{field.value || '当前记录中暂无任务描述。'}</span> : <code>{field.value}</code>}</dd>
          <div className="session-info-row-actions">
            <button type="button" disabled={!field.value} aria-label={`复制${field.label}`} title={`复制${field.label}`} onClick={() => void copy(field.value)}><UiIcon name="copy" size={14} /></button>
            {field.path && <button type="button" aria-label={`定位${field.label}`} title="在 Finder 中显示" onClick={() => void reveal(field.id)}><UiIcon name="folder" size={14} /></button>}
          </div>
        </div>)}</dl>
      </section>)}
      {(current?.error || info.errors.length > 0) && <div className="session-info-errors" role="alert">
        <div>{current?.error || info.errors.map(error => `${error.label}：${error.message}`).join('；')}</div>
        <button type="button" onClick={retry}>重试</button>
      </div>}
    </div>
    <div className="session-info-footer">
      <span role="status" aria-live="polite">{feedback || (loading ? '正在读取…' : '标识与路径可单独复制')}</span>
      {task && onOpenGeneration && <button type="button" className="session-info-copy-all" onClick={onOpenGeneration}><UiIcon name="message-square" size={13}/>查看生成会话</button>}
      <button type="button" className="session-info-copy-all" onClick={() => void copy(formatSessionInfo(info, agentName, taskInfo))}><UiIcon name="copy" size={13} />复制全部信息</button>
    </div>
  </AnchoredPopover>
}
