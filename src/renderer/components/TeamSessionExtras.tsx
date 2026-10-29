import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentDef, Session } from '@shared/types'
import type { TeamArtifact, TeamProject } from '@shared/teamTypes'
import { codexWireModel } from '@shared/codexModelIdentity'
import { teamMemberStatus } from '../teamTimeline'
import { AgentIcon } from './AgentIcon'
import { UiIcon } from './Icons'
import { TeamAvatar } from './TeamManagement'
import { FileBrowser } from './FileBrowser'
import { Markdown } from './Markdown'
import { HtmlPreview, HtmlPreviewSessionContext } from './HtmlPreview'
import { ImageLightbox } from './ImageLightbox'
import './teams.css'

export const TeamSessionContext = createContext<{ project: TeamProject; sessions: Session[]; agents: AgentDef[]; onOpenMember: (id: string) => void; openArtifact: (id: string) => void } | undefined>(undefined)

export function TeamSessionProvider({ project, sessions, agents = [], onOpenMember, children }: { project?: TeamProject; sessions: Session[]; agents?: AgentDef[]; onOpenMember: (id: string) => void; children: ReactNode }): JSX.Element {
  const [artifact, setArtifact] = useState<TeamArtifact | null>(null)
  const [error, setError] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const owner = useRef(project?.id)
  owner.current = project?.id
  useEffect(() => { setArtifact(null); setError('') }, [project?.id])
  useEffect(() => {
    if (artifact && !artifact.path) dialog.current?.showModal()
    return () => trigger.current?.focus()
  }, [artifact])
  const leader = project?.memberSessions[project.team.leaderMemberId] || ''
  const openArtifact = (id: string): void => {
    if (!project) return
    trigger.current = document.activeElement as HTMLElement
    setError('')
    const projectId = project.id
    void window.uniagent.teamArtifact(projectId, id).then(a => { if (owner.current === projectId) setArtifact(a) }).catch(e => { if (owner.current === projectId) setError(String(e)) })
  }
  return <TeamSessionContext.Provider value={project ? { project, sessions, agents, onOpenMember, openArtifact } : undefined}>
    {children}
    {error && <div className="team-error" role="alert">{error}<button onClick={() => setError('')}>关闭</button></div>}
    {artifact?.path ? <FileBrowser sessionId={leader} workdir={project?.spaceRoots[0] || ''} rootPath={artifact.path.slice(0, artifact.path.lastIndexOf('/'))} focusPath={artifact.path} onClose={() => setArtifact(null)} /> : artifact && <dialog ref={dialog} className="team-modal team-artifact-dialog" aria-label={artifact.title} onCancel={() => setArtifact(null)} onClose={() => setArtifact(null)}>
      <div className="team-section-title"><h3>{artifact.title}</h3><button className="btn-ghost" aria-label="关闭成果" onClick={() => setArtifact(null)}>×</button></div>
      <HtmlPreviewSessionContext.Provider value={leader}><Markdown text={artifact.text || ''} /></HtmlPreviewSessionContext.Provider>
    </dialog>}
  </TeamSessionContext.Provider>
}

export function TeamArtifacts({ ids }: { ids: string[] }): JSX.Element | null {
  const context = useContext(TeamSessionContext)
  if (!context) return null
  const artifacts = context.project.artifacts.filter(a => ids.includes(a.id))
  return artifacts.length ? <div className="team-delivery-artifacts">{artifacts.map(a => <button className="team-delivery-artifact" key={a.id} onClick={() => context.openArtifact(a.id)}>
    <span className="team-delivery-icon"><UiIcon name="file" size={15} /></span><span className="team-delivery-copy"><span>{a.title}</span><small>{a.snapshot ? '固定版本' : '成员交付'} · {new Date(a.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></span><UiIcon name="chevron-right" size={13} />
  </button>)}</div> : null
}

export function TeamDecisionMaterials({ interactionId }: { interactionId?: string }): JSX.Element | null {
  const context = useContext(TeamSessionContext)
  const interaction = context?.project.interactions.find(i => i.id === interactionId)
  if (!interaction?.decision || !context) return null
  return <div className="team-decision-materials"><strong>{interaction.decision.title}</strong><small>材料版本 · {interaction.id.slice(-8)}</small>
    {interaction.decision.materials.map(ref => {
      const a = context.project.artifacts.find(a => a.id === ref.artifactId)
      return a && <div key={a.id}>{(ref.questionId || ref.optionLabel) && <p className="team-muted">{ref.questionId}{ref.optionLabel ? ' · ' + ref.optionLabel : ''}</p>}{a.text ? <details open><summary>{a.title}</summary><Markdown text={a.text} /></details> : <TeamDecisionPreview artifact={a} />}</div>
    })}
  </div>
}

function TeamDecisionPreview({ artifact }: { artifact: TeamArtifact }): JSX.Element | null {
  const context = useContext(TeamSessionContext)
  const [preview, setPreview] = useState<{ ready?: boolean; src?: string; error?: string }>({})
  const [expanded, setExpanded] = useState(false)
  const html = /\.html?$/i.test(artifact.path || '')
  const image = /\.(png|jpe?g|webp|gif|svg|bmp|ico)$/i.test(artifact.path || '')
  const projectId = context?.project.id
  const sessionId = context?.project.memberSessions[context.project.team.leaderMemberId] || ''
  useEffect(() => {
    setPreview({}); setExpanded(false)
    if (!projectId || !artifact.path || !html && !image) return
    let cancelled = false
    void (async () => {
      try {
        const verified = await window.uniagent.teamArtifact(projectId, artifact.id)
        if (!verified.path) throw new Error('材料文件缺失')
        if (html) { if (!cancelled) setPreview({ ready: true }); return }
        const slash = verified.path.lastIndexOf('/')
        const result = await window.uniagent.fsReadFile(sessionId, verified.path.slice(slash + 1), undefined, verified.path.slice(0, slash))
        if (!result.ok || result.kind !== 'image' || !result.dataUrl || result.tooLarge) throw new Error(result.error || '图片过大或无法预览，请打开文件查看')
        if (!cancelled) setPreview({ ready: true, src: result.dataUrl })
      } catch (error) { if (!cancelled) setPreview({ error: error instanceof Error ? error.message : '材料预览失败' }) }
    })()
    return () => { cancelled = true }
  }, [projectId, sessionId, artifact.id, artifact.path, html, image])
  if (!context) return null
  if (!html && !image) return <TeamArtifacts ids={[artifact.id]} />
  if (preview.error) return <><p className="team-error" role="alert">{preview.error}</p><TeamArtifacts ids={[artifact.id]} /></>
  if (!preview.ready) return <p className="team-muted">正在加载 {artifact.title}…</p>
  return <div className="team-decision-preview">
    {html ? <HtmlPreviewSessionContext.Provider value={sessionId}><HtmlPreview reference={{ path: artifact.path, title: artifact.title }} onOpenFile={() => context.openArtifact(artifact.id)} /></HtmlPreviewSessionContext.Provider> : <>
      <div className="team-decision-preview-head"><span>{artifact.title}</span><small>固定版本</small><button className="interaction-link" type="button" onClick={() => setExpanded(true)}>放大查看</button></div>
      <button className="team-decision-image" type="button" onClick={() => setExpanded(true)} aria-label={`放大查看 ${artifact.title}`}><img src={preview.src} alt={artifact.title} /></button>
      {expanded && preview.src && <ImageLightbox images={[{ src: preview.src, alt: artifact.title }]} index={0} onIndexChange={() => {}} onClose={() => setExpanded(false)} />}
    </>}
  </div>
}

const labels: Record<string, string> = { idle: '待命', running: '进行中', queued: '待执行', blocked: '等待 Leader', waiting_user: '等待 Leader', succeeded: '已交付', failed: '失败', cancelling: '停止中', cancelled: '已取消', interrupted: '已中断', 'awaiting-approval': '待授权' }
export function TeamSummary({ onOpenTeam }: { onOpenTeam?: (id: string) => void }): JSX.Element | null {
  const context = useContext(TeamSessionContext)
  const [resumeError, setResumeError] = useState('')
  if (!context) return null
  const { project: p, sessions, agents, onOpenMember } = context
  return <div className="sum-sec team-session-summary"><button type="button" className="sum-h team-summary-heading" disabled={!onOpenTeam} title={`打开 ${p.team.name} 详情`} onClick={() => onOpenTeam?.(p.team.id)}><span>专家团 · {p.team.name}</span><UiIcon name="chevron-right" size={12} /></button>
    <div className="team-progress-roles">{p.team.members.map(m => {
      const leader = m.id === p.team.leaderMemberId
      const sid = p.memberSessions[m.id]
      const session = sessions.find(s => s.id === sid)
      const status = teamMemberStatus(p, m.id, session)
      const agentId = session?.config?.agentId || m.role.agentId
      const agent = agents.find(a => a.id === agentId)
      const model = session?.config?.model || m.role.model
      const modelLabel = session?.agentContract?.models.find(m => m.id === model)?.label
        || agent?.models.find(m => m.id === model)?.label
        || ((agent?.adapter === 'codex' || agentId === 'codex') ? codexWireModel({ model }) : model)
        || '默认模型'
      const identity = `${agent?.name || agentId} · ${modelLabel}`
      const content = <><TeamAvatar name={m.role.name} leader={leader} /><span className="team-progress-role-copy"><strong title={m.role.name}>{m.role.name}</strong></span><span className="team-progress-role-model" title={identity} aria-label={identity}><AgentIcon agentId={agentId} adapter={agent?.adapter} size={10} /><span>{modelLabel}</span></span><span className="team-muted">{leader ? 'Leader' : labels[status] || status}</span>{!leader && <UiIcon name="chevron-right" size={12} />}</>
      return leader ? <div className="team-progress-role team-leader-identity" key={m.id}>{content}</div> : <button className="team-progress-role" key={m.id} disabled={!sid} onClick={() => onOpenMember(sid)}>{content}</button>
    })}</div>
    {!!p.artifacts.length && <details><summary>交付材料 · {p.artifacts.length} 份</summary><TeamArtifacts ids={p.artifacts.map(a => a.id)} /></details>}
    {p.legacyMessagesArchived && !!p.messages.length && <details><summary>回退前的旧版团队对话</summary>{p.messages.map(m => <div key={m.id}><strong>{m.kind === 'user' ? '用户' : 'Leader'}</strong><Markdown text={m.text} /></div>)}</details>}
    {resumeError && <p className="team-error" role="alert">{resumeError}</p>}
    {p.error && <p className="team-error">{p.error}</p>}
    {!p.archivedAt && ['failed', 'interrupted'].includes(p.status) && <button className="set-mini-btn" onClick={() => { setResumeError(''); void window.uniagent.resumeTeamProject(p.id).catch(e => setResumeError(String(e))) }}>恢复协作</button>}
  </div>
}
