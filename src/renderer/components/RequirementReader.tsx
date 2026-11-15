import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import './projectMemoryReader.css'
import type { RequirementMaterial, RequirementOverview, RequirementReadableDocument } from '@shared/requirementTypes'
import type { Session } from '@shared/types'
import { sessionDisplayTitle } from '@shared/task'
import { requirementDecisionTime } from '@shared/requirementTimeline'
import { readBrowserValue, saveBrowserValue } from '../scopeBrowser'
import { classifyAnchorHref, classifyExternalHref, Markdown } from './Markdown'
import { UiIcon } from './Icons'
import { RequirementCurationPanel } from './RequirementCurationPanel'
import { RequirementOverviewContent } from './RequirementOverviewContent'
import './requirementReader.css'

type Tab = 'context' | 'decisions' | 'resources'
const categories = [['all', '全部资料'], ['user', '用户提供'], ['agent', 'Agent 产出']] as const
const date = (time?: number) => time ? new Date(time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '尚未记录更新时间'
const basisLabels = { user: '用户陈述', tool: '工具观察', agent: 'Agent 报告', suggestion: '待确认建议' }
function documentStatus(doc: Pick<RequirementReadableDocument, 'status' | 'freshness' | 'memory'>): string {
  if (doc.memory && doc.status === 'draft') return basisLabels[doc.memory.basis] + ' · 待核实'
  return doc.status === 'draft' ? '待确认资料' : doc.status === 'superseded' ? '已被替代' : doc.status === 'archived' ? '历史资料' : doc.freshness === 'needs-review' ? '记录待复核' : '当前资料'
}
function decisionLabels(doc: Pick<RequirementReadableDocument, 'memory' | 'kind' | 'status'>): string[] {
  const source = doc.memory ? doc.memory.basis === 'suggestion' ? '建议' : basisLabels[doc.memory.basis] : doc.kind === 'spec' ? '需求约定' : doc.kind === 'decision' ? '决策记录' : '建议'
  return [source, ...(doc.status === 'superseded' ? ['已被替代'] : doc.status === 'archived' ? ['历史资料'] : [])]
}
function decisionDate(doc: Omit<RequirementReadableDocument, 'content'>): string {
  const time = requirementDecisionTime(doc)
  return time === undefined ? '时间未记录' : (doc.memory?.occurredAt === time ? '发生于 ' : '记录于 ') + new Date(time).toLocaleString('zh-CN')
}
function DecisionTime({ doc }: { doc: Omit<RequirementReadableDocument, 'content'> }): JSX.Element {
  const time = requirementDecisionTime(doc)
  if (time === undefined) return <span className="rr-decision-time">时间未记录</span>
  const value = new Date(time)
  const day = value.getFullYear() === new Date().getFullYear() ? value.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' }) : value.toLocaleDateString('zh-CN')
  return <time className="rr-decision-time" dateTime={value.toISOString()} title={decisionDate(doc)}><span className="rr-time-day">{day}</span><span className="rr-time-clock">{doc.memory?.occurredAt !== time && <small>记录于 </small>}{value.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</span></time>
}

export function RequirementReader({ id, tab, sessions, onOpenTask, onOpenFile, onOpenCode, onOpenCuration }: { id: string; tab: Tab; sessions: Session[]; onOpenTask: (id: string, seq?: number) => void | Promise<void>; onOpenFile?: (path: string, line?: number) => void; onOpenCode?: (path: string, projectId?: string, directory?: string) => void; onOpenCuration?: () => void }): JSX.Element {
  const key = 'ua.scopeBrowser.requirement:' + id + '.reader.' + tab
  const savedCategory = readBrowserValue(key + '.category', 'all')
  const validCategory = tab !== 'resources' || categories.some(([value]) => value === savedCategory)
  const [documentId, setDocumentId] = useState<string | undefined>(() => readBrowserValue(key + '.document', undefined))
  const [query, setQuery] = useState(() => readBrowserValue(key + '.query', ''))
  const [category, setCategory] = useState(() => validCategory ? savedCategory : 'all')
  const [offset, setOffset] = useState(() => validCategory ? readBrowserValue(key + '.offset', 0) : 0)
  const [overview, setOverview] = useState<RequirementOverview>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [version, setVersion] = useState(0)
  const [moreLoading, setMoreLoading] = useState(false)
  const [sourceError, setSourceError] = useState('')
  const root = useRef<HTMLElement>(null)
  const request = useRef(0)
  const requestedRetry = useRef(0)
  const restoredScroll = useRef('')
  useEffect(() => window.uniagent.onRequirementsChanged(() => setVersion(value => value + 1)), [])
  useEffect(() => {
    const ticket = ++request.current
    setLoading(true); setError('')
    const timer = setTimeout(() => {
      const refresh = retry > requestedRetry.current
      requestedRetry.current = retry
      void window.uniagent.readRequirementOverview(id, documentId, documentId ? { refresh } : { query, ...(tab === 'resources' ? { materials: category as 'all' | 'user' | 'agent' } : { category: tab === 'decisions' ? 'decisions' : category }), offset, limit: 30, includeHistory: tab === 'decisions', refresh }).then(result => {
        if (ticket !== request.current) return
        if (tab === 'resources' && !documentId && offset > 0 && offset >= (result.total || 0)) { saveBrowserValue(key + '.offset', 0); setOffset(0); return }
        setOverview(result); setLoading(false)
      }, reason => { if (ticket === request.current) { setError(String(reason)); setLoading(false) } })
    }, query ? 180 : 0)
    return () => { clearTimeout(timer); request.current++ }
  }, [id, tab, documentId, query, category, offset, retry, version])
  useLayoutEffect(() => {
    const navigation = JSON.stringify([id,tab,documentId])
    if (loading || restoredScroll.current === navigation) return
    restoredScroll.current = navigation
    const scroll = root.current?.closest('.workspace-detail-scroll')
    if (scroll) scroll.scrollTop = readBrowserValue('ua.scopeBrowser.requirement:' + id + '.' + tab + '.scroll', 0)
  }, [loading, id, tab, documentId])

  function openDocument(value?: string): void {
    saveBrowserValue(key + '.document', value); setDocumentId(value); setOverview(undefined); setLoading(true); setError('')
  }
  function page(value: number): void { saveBrowserValue(key + '.offset', value); setOffset(value); setOverview(undefined); setLoading(true) }
  function filter(value: string): void { saveBrowserValue(key + '.category', value); setCategory(value); page(0) }
  async function openMaterial(material: RequirementMaterial): Promise<void> {
    setSourceError('')
    try {
      const external = classifyExternalHref(material.uri)
      if (external) await window.uniagent.openExternal(external)
      else {
        const local = classifyAnchorHref(material.uri)
        if (!local || !onOpenFile) throw new Error('当前无法打开该资料文件')
        await onOpenFile(local.path, local.line)
      }
    } catch (reason) { setSourceError(String(reason)) }
  }
  async function loadMore(): Promise<void> {
    if (!overview?.nextOffset || !documentId || moreLoading) return
    setMoreLoading(true)
    const ticket = request.current
    try {
      const result = await window.uniagent.readRequirementOverview(id, documentId, { offset: overview.nextOffset })
      if (ticket !== request.current) return
      if (result.revision !== overview.revision) throw new Error('资料已更新，请重新打开以读取一致版本')
      setOverview({ ...result, document: result.document && { ...result.document, content: (overview.document?.content || '') + result.document.content } })
    } catch (reason) { if (ticket === request.current) setError(String(reason)) } finally { setMoreLoading(false) }
  }
  const docs = overview?.documents || []
  const materials = overview?.materials || []
  const reading = overview?.reading
  const returnLabel = '返回' + (tab === 'context' ? '概览' : tab === 'decisions' ? '变更与决策' : '资料')
  const sourceLinks = (doc: Pick<RequirementReadableDocument, 'sources'>) => <div className="rr-sources">{doc.sources?.map((source, index) => {
    if (!source.sessionId) return source.uri ? <div key={index}><Markdown text={`[查看参考资料](<${source.uri}>)`} onOpenFile={onOpenFile}/></div> : null
    const session = sessions.find(session => session.id === source.sessionId && session.config.requirementId === id)
    return <div key={index}>{source.quote && <blockquote>{source.quote}</blockquote>}<button className="scope-link" onClick={() => { setSourceError(''); void Promise.resolve(onOpenTask(source.sessionId!, source.seq)).catch(reason => setSourceError(String(reason))) }}>{session ? '原讨论：' + sessionDisplayTitle(session) : '打开原讨论'}</button></div>
  })}</div>
  const searchLabel = tab === 'resources' ? '搜索资料名称或用途' : '搜索变更或讨论主题'
  const searchInput = <input className="rr-search" type="search" aria-label={searchLabel} placeholder={searchLabel} value={query} onChange={event => { saveBrowserValue(key + '.query', event.target.value); setQuery(event.target.value); page(0) }}/>

  return <article ref={root} className="scope-context requirement-reader" aria-busy={loading}>
    {error && <div className="scope-error" role="alert">{error}<button onClick={() => setRetry(value => value + 1)}>重试正文</button></div>}
    {sourceError && <p className="scope-error" role="alert">{sourceError}</p>}
    {loading && !overview && <p className="scope-muted" role="status">正在读取资料…</p>}
    {documentId ? <><header className="rr-document-head"><button type="button" className="rr-back-button" title={returnLabel} aria-label={returnLabel} onClick={() => openDocument()}><UiIcon name="back" size={16}/></button>{overview?.document && <h2>{overview.document.title}</h2>}</header>{overview?.document && <>
      <p className="rr-meta">{tab === 'decisions' ? decisionLabels(overview.document).join(' · ') + ' · ' + decisionDate(overview.document) : documentStatus(overview.document) + ' · ' + date(overview.document.updatedAt)}</p>
      <Markdown text={overview.document.content} onOpenFile={onOpenFile}/>{overview.nextOffset !== null && overview.nextOffset !== undefined && <button className="scope-button" disabled={moreLoading} onClick={() => void loadMore()}>继续读取正文</button>}
      {!!overview.document.dependencies?.length && <div className="rr-sources">相关依赖：{overview.document.dependencies.map(id => <button key={id} className="scope-link" onClick={() => openDocument(id)}>{id === 'core' ? '目标与约束' : id === 'state' ? '当前进展' : id}</button>)}</div>}
      {sourceLinks(overview.document)}
    </>}</> : tab === 'context' ? <>
      <RequirementCurationPanel id={id} initial={overview?.curation} sessions={sessions} onOpenConversation={onOpenCuration}/>
      <div className="rr-meta"><i className="rr-dot"/>{overview?.status === 'done' ? '已完成' : overview?.status === 'archived' ? '已归档' : '进行中'}<span className="rr-meta-end">{reading ? '概览整理于 ' + date(reading.updatedAt) : '尚未整理阅读概览'}</span></div>
      <RequirementOverviewContent overview={overview} onOpenDocument={openDocument} onOpenFile={onOpenFile} onOpenCode={onOpenCode}/>
      {(overview?.readingStatus !== 'ready' || overview?.sync?.status === 'pending' || reading?.coverage?.complete === false) && <p className="rr-notice" role="status">{overview?.readingStatus !== 'ready' ? overview?.readingError || (reading ? '资料已有变化，当前显示上一版概览。' : '概览尚未整理，已有资料可以直接查看。') : '部分历史讨论或资料尚未整理。'} <button className="scope-link" onClick={() => openDocument('sync')}>查看整理范围</button><button className="scope-link" onClick={() => setRetry(value => value + 1)}>重新整理</button></p>}
    </> : <>
      <header className="rr-page-head"><h2>{tab === 'decisions' ? '变更与决策' : '资料'}</h2><p>{tab === 'decisions' ? '按时间回看需求约定、变更与历史建议，最新记录在最上方。' : '集中查看用户提供的参考资料和 Agent 产出的材料。'}</p></header>
      <div className="rr-toolbar">{tab === 'decisions' ? <label className="rr-decision-search"><UiIcon name="search" size={14}/>{searchInput}</label> : searchInput}{overview && <span className="rr-material-count">{overview.total || 0} {tab === 'decisions' ? '条记录' : '份资料'}</span>}</div>
      <div className={tab === 'resources' ? 'rr-library' : ''}>{tab === 'resources' && <nav className="rr-categories" aria-label="资料来源">{categories.map(([id, label]) => <button key={id} aria-pressed={category === id} onClick={() => filter(id)}>{label}</button>)}</nav>}<div className={'rr-documents' + (tab === 'decisions' ? ' rr-timeline' : '')}>{tab === 'decisions' ? docs.map(doc => <details className="rr-decision" key={doc.id}><summary><DecisionTime doc={doc}/><span className="rr-timeline-mark" aria-hidden="true"><i/></span><span className="rr-decision-main"><span className="rr-decision-copy"><span className="rr-decision-title">{doc.title}</span><span className="rr-decision-labels">{decisionLabels(doc).map((label, index) => <small className={index ? 'rr-decision-history' : 'rr-decision-basis'} key={label}>{label}</small>)}</span></span><UiIcon name="chevron-right" size={13}/></span></summary><div className="rr-decision-body"><p>{doc.summary || '展开原资料查看结论与适用范围。'}</p>{doc.supersedes && <p>替代历史版本：<button className="scope-link" onClick={() => openDocument(doc.supersedes)}>{doc.supersedes}</button></p>}<button className="scope-link" onClick={() => openDocument(doc.id)}>查看结论、原因与来源</button></div></details>) : materials.map(material => <div className="rr-document" key={material.uri}><UiIcon name="file" size={15}/><div><button className="scope-document" onClick={() => void openMaterial(material)}>{material.title}</button>{material.summary && <p>{material.summary}</p>}<small className="rr-material-meta">{material.origin === 'user' ? '用户提供' : 'Agent 产出'}<span>·</span>{material.format}</small></div><button className="scope-link rr-material-open" onClick={() => void openMaterial(material)}>{material.format === 'Figma' ? '打开设计稿' : classifyExternalHref(material.uri) ? material.format === '飞书文档' ? '打开文档' : '打开资料' : '查看文件'}<UiIcon name="external-link" size={12}/></button></div>)}{!loading && !(tab === 'resources' ? materials.length : docs.length) && <p className="scope-muted">{query ? '未找到匹配资料，试试其它关键词。' : '暂无已记录的资料。'}</p>}</div></div>
      {!!overview?.total && <div className="rr-pagination"><button className="scope-button" disabled={offset === 0} onClick={() => page(Math.max(0, offset - 30))}>上一页</button><span>{Math.floor(offset / 30) + 1} / {Math.ceil(overview.total / 30)}</span><button className="scope-button" disabled={!overview.nextOffset} onClick={() => page(overview.nextOffset!)}>下一页</button></div>}
    </>}
  </article>
}
