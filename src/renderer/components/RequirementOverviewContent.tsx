import { useEffect, useRef, useState } from 'react'
import type { RequirementOverview, RequirementReadingItem, RequirementReadingSection } from '@shared/requirementTypes'
import { classifyImageSrc } from './Markdown'
import { ImageLightbox } from './ImageLightbox'
import { ClockIcon, UiIcon } from './Icons'

const labels = { user: '用户陈述', tool: '工具观察', agent: 'Agent 报告', suggestion: '待确认建议' }
const basis = (item?: RequirementReadingItem) => item?.basis && <small className="rr-basis">{labels[item.basis]}</small>

function RequirementSectionImage({ image }: { image: NonNullable<RequirementReadingSection['image']> }): JSX.Element | null {
  const [src, setSrc] = useState<string>()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let active = true
    setSrc(undefined); setOpen(false)
    const local = classifyImageSrc(image.uri, window.uniagent.homeDir)
    if (local) void window.uniagent.fsReadFile('', local.path, undefined, local.rootOverride).then(result => {
      if (active && result.ok && result.kind === 'image') setSrc(result.dataUrl)
    }).catch(() => {})
    else setSrc(image.uri)
    return () => { active = false }
  }, [image.uri])
  if (!src) return null
  return <><button className="rr-section-image" aria-label={'查看图片：' + image.caption} onClick={() => setOpen(true)}><img src={src} alt={image.caption} onError={() => setSrc(undefined)}/><span>{image.caption}<UiIcon name="external-link" size={12}/></span></button>
    {open && <ImageLightbox images={[{ src, alt: image.caption }]} index={0} onIndexChange={() => {}} onClose={() => setOpen(false)} label={image.caption}/>}</>
}

export function RequirementOverviewContent({ overview, onOpenDocument, onOpenFile, onOpenCode }: {
  overview?: RequirementOverview
  onOpenDocument: (id: string) => void
  onOpenFile?: (path: string, line?: number) => void
  onOpenCode?: (path: string, projectId?: string, directory?: string) => void
}): JSX.Element {
  const reading = overview?.reading
  const sections: RequirementReadingSection[] = reading?.requirements || reading?.topics?.map(topic => ({ ...topic, text: topic.detail || topic.text })) || []
  const [selected, setSelected] = useState<RequirementReadingSection>()
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (selected) dialog.current?.showModal()
    else dialog.current?.close()
  }, [selected])
  useEffect(() => { setSelected(undefined) }, [overview?.revision, reading?.updatedAt])
  const refs = [...new Map([...([selected, selected?.progress, selected?.next].flatMap(item => item?.refs || [])), ...(selected?.image ? [{ documentId: selected.image.documentId, quote: selected.image.caption }] : [])].map(ref => [ref.documentId, ref])).values()]
  const code = overview?.associations?.code.filter(link => refs.some(ref => ref.documentId === link.documentId)) || []
  const skills = overview?.associations?.skills.filter(link => refs.some(ref => ref.documentId === link.documentId)) || []
  function openDocument(id: string): void { setSelected(undefined); onOpenDocument(id) }
  return <div className="rr-overview">
    <header className="rr-hero"><h2>{reading?.goal?.text || overview?.name || '需求概览'}</h2>{basis(reading?.goal)}<button className="scope-link" onClick={() => openDocument('core')}>了解当前目标与边界</button></header>
    <div className="rr-summary-grid">
      <section className="rr-summary-card"><h3><UiIcon name="file" size={16}/>需求描述</h3><p>{reading?.description?.text || reading?.scope?.text || '需求背景与范围尚未整理，可查看原始目标与边界。'}</p>{basis(reading?.description || reading?.scope)}</section>
      <section className="rr-summary-card"><h3><ClockIcon size={16}/>需求进展</h3><p>{reading?.current?.text || '当前进展尚未整理。'}</p>{basis(reading?.current)}</section>
    </div>
    <section className="rr-requirements"><h3>需求内容</h3><div className="rr-requirement-grid">{sections.map((section, index) => <article className="rr-requirement-card" key={index}>
      <h4><UiIcon name="file" size={16}/>{section.title}</h4><p>{section.text}</p>{basis(section)}
      {section.progress && <div className="rr-requirement-progress"><i/>{section.progress.text}{basis(section.progress)}</div>}
      {section.image && <RequirementSectionImage key={section.image.uri} image={section.image}/>}
      <button className="scope-link rr-section-open" onClick={() => setSelected(section)}>查看进展与资料<UiIcon name="chevron-right" size={12}/></button>
    </article>)}</div>{!sections.length && <p className="scope-muted">分项需求尚未整理，可从原始目标与边界了解范围。</p>}</section>
    <dialog className="rr-section-dialog" ref={dialog} onClose={() => setSelected(undefined)} aria-labelledby="rr-section-title">
      {selected && <><header><h2 id="rr-section-title">{selected.title}</h2><button className="rr-back-button" aria-label="关闭分项详情" onClick={() => setSelected(undefined)}><UiIcon name="close" size={16}/></button></header>
        <p>{selected.text}</p>{basis(selected)}
        <h3>当前进展</h3><p>{selected.progress?.text || '尚未整理对应进展，请查看相关记录。'}</p>{basis(selected.progress)}
        {selected.next && <><h3>下一步{selected.next.kind === 'suggested' && <small>建议／待确认</small>}</h3><p>{selected.next.text}</p>{basis(selected.next)}</>}
        <h3>相关记录</h3><div className="rr-section-references">{refs.map(ref => <button className="scope-link" key={ref.documentId} title={ref.quote} onClick={() => openDocument(ref.documentId)}>{overview?.documents.find(doc => doc.id === ref.documentId)?.title || overview?.tasks?.find(task => 'task:' + task.sessionId === ref.documentId)?.title || (ref.documentId === 'core' ? '目标与边界' : ref.documentId === 'state' ? '阶段记录' : ref.quote.slice(0, 70))}<UiIcon name="chevron-right" size={12}/></button>)}</div>
        {!!(code.length || skills.length) && <details className="rr-section-associations"><summary>关联代码与 Skills</summary>{code.map((link, index) => <div key={index}><p>{link.title || link.path} · {link.reason}</p><small>{labels[link.basis]} · {link.freshness === 'needs-review' ? '关联依据待复核' : '已记录关联'}</small><button className="scope-link" disabled={!onOpenCode || link.availability !== 'available'} onClick={() => { setSelected(undefined); onOpenCode?.(link.path, link.projectId, link.directory) }}>打开代码入口</button></div>)}{skills.map((link, index) => <div key={index}><p>{link.name} · {link.reason}</p><small>{labels[link.basis]} · {link.availability === 'available' ? '文件可读取' : link.availability === 'unavailable' ? '入口不可用' : '可用性尚未核验'}</small><button className="scope-link" disabled={!onOpenFile || !link.path || link.availability !== 'available'} onClick={() => { setSelected(undefined); onOpenFile?.(link.path!) }}>查看 Skill</button></div>)}</details>}
      </>}
    </dialog>
  </div>
}
