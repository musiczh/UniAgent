import { useEffect, useRef, useState } from 'react'
import type { Project } from '@shared/types'
import type { ProjectMemoryPage, ProjectMemoryRequest } from '@shared/projectMemory'
import { readBrowserValue, saveBrowserValue } from '../scopeBrowser'
import { Markdown } from './Markdown'
import { UiIcon } from './Icons'
import './requirementReader.css'
import './projectMemoryReader.css'

const categories = [['all','全部'],['architecture','架构'],['rule','规则'],['experience','经验'],['pending','待确认']] as const
const typeLabels = { architecture: '架构', rule: '规则', experience: '经验' }
const basisLabels = { user: '用户陈述', tool: '工具观察', agent: 'Agent 报告' }
const date = (time: number) => new Date(time).toLocaleString('zh-CN')

export function ProjectMemoryReader({ project, onOpenTask, onOpenFile, onManage }: {
  project: Project; onOpenTask: (id: string, seq?: number) => void | Promise<void>
  onOpenFile?: (path: string, root: string) => void; onManage: () => void
}): JSX.Element {
  const key = 'ua.scopeBrowser.space:' + project.id + '.memory'
  const [category,setCategory] = useState<ProjectMemoryRequest['category']>(() => { const saved = readBrowserValue(key+'.category','all'); return categories.some(([id]) => id === saved) ? saved as ProjectMemoryRequest['category'] : 'all' })
  const [query,setQuery] = useState(() => readBrowserValue(key+'.query',''))
  const [offset,setOffset] = useState(0)
  const [id,setId] = useState<string>()
  const [history,setHistory] = useState(false)
  const [page,setPage] = useState<ProjectMemoryPage>()
  const [loading,setLoading] = useState(true)
  const [error,setError] = useState('')
  const [busy,setBusy] = useState(false)
  const [version,setVersion] = useState(0)
  const request = useRef(0)
  useEffect(() => window.uniagent.onProjectMemoryChanged(() => setVersion(value => value+1)),[])
  useEffect(() => {
    const ticket = ++request.current
    setLoading(true); setError('')
    const timer = setTimeout(() => {
      void window.uniagent.projectMemory(project.id,{ action:'read', ...(id ? { id,includeHistory:history } : { category,query,offset,limit:30 }) }).then(result => {
        if (ticket !== request.current) return
        if (!id && offset && offset >= result.total) { setOffset(0); return }
        setPage(result); setLoading(false)
      }, reason => { if (ticket === request.current) { setError(String(reason)); setLoading(false) } })
    },query && !id ? 180 : 0)
    return () => { clearTimeout(timer); request.current++ }
  },[project.id,id,history,category,query,offset,version])
  function open(value?: string): void { setId(value); setHistory(false); setPage(undefined); setError('') }
  function filter(value: ProjectMemoryRequest['category']): void { setCategory(value); setOffset(0); setPage(undefined); saveBrowserValue(key+'.category',value) }
  async function change(action: 'confirm' | 'revoke'): Promise<void> {
    const document = page?.document
    if (!document || busy) return
    const ticket = request.current
    setBusy(true); setError('')
    try {
      await window.uniagent.projectMemory(project.id,{ action,id:document.id,expectedRevision:document.revision })
      if (ticket === request.current) open()
    } catch (reason) { if (ticket === request.current) setError(String(reason)) }
    finally { setBusy(false) }
  }
  async function moreHistory(): Promise<void> {
    if (!id || page?.historyNextOffset == null || busy) return
    const ticket = request.current
    setBusy(true)
    try {
      const result = await window.uniagent.projectMemory(project.id,{ action:'read',id,includeHistory:true,offset:page.historyNextOffset })
      if (ticket !== request.current) return
      if (result.document?.revision !== page.document?.revision) throw new Error('记忆已更新，请重新读取一致版本')
      setPage({ ...result,history:[...(page.history || []),...(result.history || [])] })
    } catch (reason) { if (ticket === request.current) setError(String(reason)) }
    finally { setBusy(false) }
  }
  const document = page?.document
  return <article className="scope-context requirement-reader project-memory-reader" aria-busy={loading}>
    {error && <div className="scope-error" role="alert">{error}<button onClick={() => setVersion(value => value+1)}>重试读取</button></div>}
    {loading && <p className="scope-muted" role="status">正在读取项目记忆…</p>}
    {id ? <><header className="rr-document-head"><button className="rr-back-button" aria-label="返回项目记忆" onClick={() => open()}><UiIcon name="back" size={16}/></button><h2>{document?.title || document?.project?.title || '项目记忆'}</h2></header>{document && <>
      <p className="rr-meta">{document.project ? typeLabels[document.project.type] + ' · ' + basisLabels[document.project.basis] : '历史项目记忆'} · {document.status === 'candidate' ? '待确认' : document.status === 'revoked' ? '已撤销' : '有效记录'} · {document.freshness === 'needs-review' ? '依据需要复核' : '来源可核对'}</p>
      <Markdown text={document.content} onOpenFile={onOpenFile ? path => onOpenFile(path,project.primaryDirectory) : undefined}/>
      {!!document.project?.modules.length && <section className="rr-sources"><strong>适用模块</strong>{document.project.modules.map((module,index) => <p key={index}><button className="scope-link" disabled={!onOpenFile} onClick={() => onOpenFile?.(module.path,module.directory || project.primaryDirectory)}>{module.title || module.path}</button>{module.title && <small> · {module.path}</small>}</p>)}</section>}
      {document.status === 'candidate' && <div className="pm-actions"><button className="scope-button primary" disabled={busy || document.freshness === 'needs-review'} onClick={() => void change('confirm')}>确认该项</button><button className="scope-button" disabled={busy} onClick={() => open()}>保留待确认</button><button className="scope-button" disabled={busy} onClick={() => void change('revoke')}>不采用</button></div>}
      <section className="rr-sources"><strong>依据与适用范围</strong>{document.project?.quote && <blockquote>{document.project.quote}</blockquote>}{document.source.sessionId && <button className="scope-link" onClick={() => { void Promise.resolve(onOpenTask(document.source.sessionId!,document.source.seq)).catch(reason => setError(String(reason))) }}>打开原讨论或工具记录</button>}<p className="rr-meta">版本 {document.revision} · {date(document.updatedAt)}</p></section>
      <details className="pm-history" open={history} onToggle={event => { if (event.currentTarget.open !== history) setHistory(event.currentTarget.open) }}><summary>查看历史与替代关系</summary>{page?.history?.map(item => <section key={item.revision}><p className="rr-meta">历史版本 {item.revision} · 当时{item.status === 'candidate' ? '待确认' : item.status === 'revoked' ? '已撤销' : '有效记录'} · {date(item.updatedAt)}</p><Markdown text={item.content}/></section>)}{page?.historyNextOffset != null && <button className="scope-button" disabled={busy} onClick={() => void moreHistory()}>继续读取历史</button>}</details>
    </>}</> : <>
      <header className="rr-page-head"><h2>项目记忆</h2><p>保留跨需求、跨会话的项目知识。由 UniAgent 统一管理，供项目内各 Agent 按需读取。</p></header>
      <div className="pm-toolbar"><nav className="pm-categories" aria-label="项目记忆分类">{categories.map(([value,label]) => <button key={value} aria-pressed={category === value} onClick={() => filter(value)}>{label}</button>)}</nav><input className="rr-search" type="search" aria-label="搜索项目记忆" placeholder="搜索主题或模块" value={query} onChange={event => { setQuery(event.target.value); setOffset(0); saveBrowserValue(key+'.query',event.target.value) }}/></div>
      <div className="rr-columns"><section className="pm-list">{page?.items.map(item => <div className="rr-document" key={item.id}><UiIcon name="file" size={16}/><div><button className="scope-document" onClick={() => open(item.id)}>{item.title || item.project?.title || '历史项目记忆'}</button><p>{item.project ? typeLabels[item.project.type] + ' · ' + basisLabels[item.project.basis] : '历史记录'}{item.project?.modules.length ? ' · '+item.project.modules.map(module => module.title || module.path).join('、') : ''}</p><small>{item.status === 'candidate' ? '待确认 · ' : ''}{item.freshness === 'needs-review' ? '依据需要复核' : '查看依据'}</small></div><UiIcon name="chevron-right" size={13}/></div>)}{!loading && !page?.items.length && <div className="scope-empty"><p>{query.trim() ? '没有匹配的记忆，试试其他主题或关键词。' : category === 'pending' ? '暂无待确认的项目记忆。' : '还没有项目记忆；讨论中的稳定结论可由 Agent 保存，并保留真实依据。'}</p></div>}</section><aside className="rr-attention"><h3>项目目录</h3><p className="pm-directory">{project.primaryDirectory}</p>{project.additionalDirectories.map(path => <p className="pm-directory" key={path}>{path}</p>)}<h3>相关入口</h3><button className="scope-link" onClick={onManage}>项目信息与工作树</button><h3>已有需求资料</h3><p className="scope-muted">沿用需求概览和资料入口，按需读取。</p></aside></div>
      {!!page?.total && <div className="rr-pagination"><button className="scope-button" disabled={!offset} onClick={() => setOffset(Math.max(0,offset-30))}>上一页</button><span>{Math.floor(offset/30)+1} / {Math.ceil(page.total/30)}</span><button className="scope-button" disabled={page.nextOffset === null} onClick={() => setOffset(page.nextOffset!)}>下一页</button></div>}
      <p className="rr-notice">每条记忆保留依据、适用模块与版本。项目记忆不授予任务执行权限。</p>
    </>}
  </article>
}
