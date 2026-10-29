import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentDef, AgentRole, AgentRoleCatalogEntry, Project } from '@shared/types'
import { DEFAULT_TEAM_LIMITS, DEFAULT_TEAM_RULES, type TeamDefinition, type TeamDefinitionInput, type TeamMember } from '@shared/teamTypes'
import { RoleDetail } from './SettingsPanel'
import { UiIcon, ToggleSwitch } from './Icons'

export const teamError = (error: unknown): string => error instanceof Error ? error.message : String(error)
export function TeamAvatar({ name, leader = false }: { name: string; leader?: boolean }): JSX.Element {
  return <span className={'team-avatar' + (leader ? ' leader' : '')}>{Array.from(name)[0] || '角'}</span>
}
function teamDraft(team?: TeamDefinition): TeamDefinitionInput {
  return team ? { id: team.id, revision: team.revision, name: team.name, description: team.description, rules: team.rules, leaderMemberId: team.leaderMemberId, members: structuredClone(team.members), limits: { ...team.limits }, status: team.status } : { name: '', description: '', rules: DEFAULT_TEAM_RULES, leaderMemberId: '', members: [], limits: { ...DEFAULT_TEAM_LIMITS }, status: 'draft' }
}
const emptyRole = (): AgentRole => ({ id: '', name: '', agentId: '', permissionMode: 'ask' })
const TEAM_LIMIT_FIELDS = [
  ['concurrency', '并行成员', 16, 3, '并行'],
  ['maxAssignments', '最多派单', 100, 12, '最多派单'],
  ['taskMinutes', '单任务分钟', 180, 20, '单任务'],
  ['runMinutes', '项目执行分钟', 720, 60, '项目执行']
] as const
const teamLimitText = (value: number, unit = ''): string => value === 0 ? '不限制' : value + unit

export function TeamManagement({ kind, initialTeamId, teams, agents, spaces, onChanged }: { kind: 'roles' | 'teams'; initialTeamId?: string; teams: TeamDefinition[]; agents: AgentDef[]; spaces: Project[]; onChanged: () => void }): JSX.Element {
  const [roles, setRoles] = useState<AgentRoleCatalogEntry[]>([])
  const [draft, setDraft] = useState<TeamDefinitionInput | null>(null)
  const openedTeam = useRef<string>()
  useEffect(() => {
    if (!initialTeamId || openedTeam.current === initialTeamId) return
    const team = teams.find(t => t.id === initialTeamId)
    if (!team) return
    openedTeam.current = initialTeamId
    setDraft(teamDraft(team))
  }, [initialTeamId, teams])
  const [role, setRole] = useState<AgentRole | null>(null)
  const [editingMember, setEditingMember] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const roleRequest = useRef({ input: '', id: '' })
  const [saveGlobal, setSaveGlobal] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [roleSaving, setRoleSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const form = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!deleting && !picking) return
    const trigger = document.activeElement as HTMLElement | null
    const dialog = form.current?.querySelector<HTMLElement>('[role=alertdialog], [role=dialog]')
    const controls = () => [...(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') || [])]
    controls()[0]?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy && !roleSaving) { event.preventDefault(); setDeleting(false); setPicking(false); setRole(null); setEditingMember(null) }
      if (event.key === 'Tab') {
        const items = controls(), first = items[0], last = items.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', keyboard)
    return () => { document.removeEventListener('keydown', keyboard); trigger?.focus() }
  }, [deleting, picking, role, busy, roleSaving])
  useLayoutEffect(() => {
    form.current?.querySelectorAll<HTMLTextAreaElement>('textarea.team-text-input').forEach(el => {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight + 2, 246) + 'px'
      el.style.overflowY = el.scrollHeight > 244 ? 'auto' : 'hidden'
    })
  }, [draft])
  const loadRoles = () => window.uniagent.listRoles().then(setRoles).catch(e => setError(teamError(e)))
  useEffect(() => { void loadRoles() }, [])
  function closePicker(): void { if (!roleSaving) { setRole(null); setEditingMember(null); setPicking(false) } }
  function addRole(value: AgentRole, global: boolean): void {
    setDraft(d => {
      if (!d) return d
      const sourceRoleId = editingMember ? d.members.find(m => m.id === editingMember)?.sourceRoleId : global ? value.id : undefined
      const member: TeamMember = { id: editingMember || 'member_' + crypto.randomUUID(), role: { ...value }, ...(sourceRoleId ? { sourceRoleId } : {}) }
      delete member.role.projectId; delete member.role.workdir
      return { ...d, leaderMemberId: d.leaderMemberId || member.id, members: editingMember ? d.members.map(m => m.id === editingMember ? member : m) : [...d.members, member] }
    })
    setRole(null); setEditingMember(null); setPicking(false)
  }
  async function save(): Promise<void> {
    if (!draft || busy) return
    setBusy(true); setError('')
    try { await window.uniagent.saveTeam(draft); setDraft(null); onChanged() }
    catch (e) { setError(teamError(e)) }
    finally { setBusy(false) }
  }
  async function remove(): Promise<void> {
    if (!draft?.id || busy) return
    setBusy(true); setError('')
    try { await window.uniagent.deleteTeam(draft.id, draft.revision!); setDraft(null); setDeleting(false); onChanged() }
    catch (e) { setError(teamError(e)); setDeleting(false) }
    finally { setBusy(false) }
  }
  if (role && (!draft || editingMember)) return <div className="team-page team-form team-role-form">
    <div className="role-scope-note"><span>{draft ? draft.name || "新团队" : "角色列表"} / {role.name || "创建角色"}</span><span>{draft ? "团队内配置" : "全局角色"}</span></div>
    <RoleDetail agents={agents} projects={spaces} role={role} entry={draft ? null : roles.find(r => r.role.id === role.id) || null} teamScope={!!draft}
      onBack={() => { setRole(null); setEditingMember(null) }}
      onSave={async value => {
        if (draft) addRole(value, false)
        else { await window.uniagent.saveRole(value); await loadRoles(); setRole(null) }
      }} onDelete={!draft && role.id ? async () => { await window.uniagent.deleteRole(role.id); await loadRoles(); setRole(null) } : undefined} />
  </div>
  if (draft) return <div ref={form} className="team-page team-form">
    <div className="team-page-title"><button className="team-back-icon" aria-label="返回团队" onClick={() => { setDraft(null); setPicking(false) }}><UiIcon name="chevron-right" size={20} /></button><h2>{draft.id ? '编辑团队' : '创建团队'}</h2><span className="sb-spacer" />{draft.id && <button className="set-mini-btn danger" disabled={busy} onClick={() => setDeleting(true)}>删除团队</button>}<span className="team-switch-label">启用<ToggleSwitch checked={draft.status === 'active'} label="启用团队" disabled={busy} onChange={checked => setDraft({ ...draft, status: checked ? 'active' : 'draft' })} /></span><button className="set-save-btn" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button></div>
    {error && <div className="team-error" role="alert">{error}</div>}
    <label className="team-field">团队名称<textarea className="team-text-input" rows={1} maxLength={100} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="例如：产品专家团" /></label>
    <label className="team-field">团队描述<textarea className="team-text-input" rows={2} maxLength={4000} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} /></label>
    <div className="team-section-title"><h3>团队成员</h3><button className="set-mini-btn" onClick={() => { void loadRoles(); setPicking(true) }}>＋ 添加成员</button></div>
    <p className="team-muted">指定一位 Leader 负责协调，其他成员接受 Leader 派单。每位成员在项目中拥有固定会话。</p>
    {draft.members.map(m => <div className="team-member-row" key={m.id}><TeamAvatar name={m.role.name} leader={m.id === draft.leaderMemberId} /><button className="team-member-label" onClick={() => { setEditingMember(m.id); setRole(m.role) }}><strong>{m.role.name}</strong><small>{m.role.agentId} · {m.role.model || '默认模型'}{!m.sourceRoleId ? ' · 团队专属' : ''}</small></button><label><input type="radio" name="team-leader" checked={draft.leaderMemberId === m.id} onChange={() => setDraft({ ...draft, leaderMemberId: m.id })} /> Leader</label><button className="btn-ghost" aria-label={'移除 ' + m.role.name} onClick={() => setDraft({ ...draft, leaderMemberId: draft.leaderMemberId === m.id ? '' : draft.leaderMemberId, members: draft.members.filter(x => x.id !== m.id) })}>×</button></div>)}
    <label className="team-field">团队规则<textarea className="team-text-input" rows={3} value={draft.rules} onChange={e => setDraft({ ...draft, rules: e.target.value })} /></label>
    <details className="limit-settings" open><summary>执行限制 <span className="team-muted">{TEAM_LIMIT_FIELDS.map(([key, , , , summary]) => `${summary} ${teamLimitText(draft.limits[key], key.endsWith('Minutes') ? ' 分钟' : '')}`).join(' · ')}</span></summary><div className="team-limit-grid">{TEAM_LIMIT_FIELDS.map(([key, label, max, fallback]) => { const unlimited = draft.limits[key] === 0; return <div className="team-field" key={key}><span className="team-limit-head">{label}<span className={unlimited ? 'team-limit-unlimited active' : 'team-limit-unlimited'}>不限制<ToggleSwitch checked={unlimited} label={`${label}不限制`} onChange={checked => setDraft({ ...draft, limits: { ...draft.limits, [key]: checked ? 0 : fallback } })} /></span></span><input key={String(unlimited)} aria-label={label} type="number" min={1} max={max} disabled={unlimited} placeholder="不限制" defaultValue={unlimited ? '' : draft.limits[key]} onChange={e => { if (e.target.value) setDraft({ ...draft, limits: { ...draft.limits, [key]: Number(e.target.value) } }) }} onBlur={e => { if (!e.target.value) e.target.value = String(draft.limits[key]) }} /></div> })}</div></details>
    {deleting && <div className="team-modal-backdrop" onClick={() => !busy && setDeleting(false)}><div className="team-modal" role="alertdialog" aria-modal="true" aria-label="删除团队" onClick={e => e.stopPropagation()}><h3>删除「{draft.name}」？</h3><p className="team-summary">只删除团队模板。已有项目、角色会话、交付物及全局角色保留。</p><div className="detail-actions"><button className="set-mini-btn" autoFocus disabled={busy} onClick={() => setDeleting(false)}>取消</button><button className="set-mini-btn danger" disabled={busy} onClick={() => void remove()}>确认删除</button></div></div></div>}
    {picking && <div className="team-modal-backdrop" onClick={closePicker}>{role ? <div className="team-modal team-role-form team-role-modal" role="dialog" aria-modal="true" aria-label="创建团队专属角色" onClick={e => e.stopPropagation()}><RoleDetail agents={agents} projects={spaces} role={role} entry={null} teamScope inline saveGlobal={{ checked: saveGlobal, onChange: setSaveGlobal }} onBack={() => setRole(null)} onClose={closePicker} onSave={async value => {
      setRoleSaving(true)
      try {
        const input = JSON.stringify([value, saveGlobal])
        if (roleRequest.current.input !== input) roleRequest.current = { input, id: crypto.randomUUID() }
        const saved = await window.uniagent.createTeamRole(value, saveGlobal, roleRequest.current.id)
        roleRequest.current = { input: '', id: '' }
        addRole(saved, saveGlobal); await loadRoles()
      } finally { setRoleSaving(false) }
    }} /></div> : <div className="team-modal" role="dialog" aria-modal="true" aria-label="添加成员" onClick={e => e.stopPropagation()}><div className="team-section-title"><h3>添加成员</h3><button className="btn-ghost" onClick={closePicker}>×</button></div><div className="team-role-options">{roles.map(entry => <button className="team-member-row" key={entry.role.id} disabled={!entry.executable || draft.members.some(m => m.sourceRoleId === entry.role.id)} title={entry.unavailableReason} onClick={() => addRole(entry.role, true)}><TeamAvatar name={entry.role.name} /><span className="team-member-label"><strong>{entry.role.name}</strong><small>{entry.unavailableReason || entry.role.instructions || entry.role.agentId}</small></span><small className="team-picker-state">{draft.members.some(m => m.sourceRoleId === entry.role.id) ? "已添加" : !entry.executable ? "不可用" : "＋"}</small></button>)}{!roles.length && <p className="team-muted">还没有可选角色</p>}</div><button className="team-create-role" onClick={() => { setEditingMember(null); setSaveGlobal(false); setRole(emptyRole()) }}>＋ 创建团队专属角色</button></div>}</div>}
  </div>
  return <div className="team-page"><div className="team-page-title"><h2>{kind === 'roles' ? '角色列表' : '团队管理'}</h2><span className="sb-spacer" /><button className="set-save-btn" onClick={() => { setError(''); kind === 'roles' ? setRole(emptyRole()) : setDraft(teamDraft()) }}><UiIcon name="plus" size={14} />{kind === 'roles' ? '创建角色' : '创建团队'}</button></div>
    {error && <div className="team-error">{error}</div>}
    {kind === 'roles' ? <div className="team-grid">{roles.map(entry => <button key={entry.role.id} className="team-tile" onClick={() => setRole(entry.role)}><div className="tile-top"><TeamAvatar name={entry.role.name} /><strong>{entry.role.name}</strong></div><p>{entry.role.instructions || '暂无描述'}</p><small>{entry.role.agentId} · {entry.role.model || '默认模型'}</small>{!entry.executable && <span className="team-error">{entry.unavailableReason}</span>}</button>)}{!roles.length && <p className="team-muted">创建角色，为团队配备不同能力的成员。</p>}</div> : <div className="team-grid">{teams.map(t => <button key={t.id} className="team-tile" onClick={() => { setDraft(teamDraft(t)); setError('') }}><div className="tile-top"><strong>{t.name}</strong><span className={"team-status " + (t.status === "active" ? "completed" : "")}>{t.status === "active" ? "已启用" : t.status === "draft" ? "未启用" : "已归档"}</span></div><p>{t.description || '暂无描述'}</p><small>{t.members.length} 位角色 · {t.members.find(m => m.id === t.leaderMemberId)?.role.name || '未指定'}任 Leader</small><div className="team-avatar-stack">{t.members.map(m => <TeamAvatar key={m.id} name={m.role.name} leader={m.id === t.leaderMemberId} />)}</div></button>)}{!teams.length && <p className="team-muted">创建一个团队，选择 Leader 和成员后即可开始项目。</p>}</div>}
  </div>
}
