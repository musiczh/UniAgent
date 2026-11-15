import { useEffect, useRef, useState } from 'react'
import type { QoderByokInput, QoderByokSource } from '@shared/qoder'
import { SetGroup, SetRow } from './SettingsPrimitives'

export function QoderModelSettings({ onModelsChanged, navigationGuard }: { onModelsChanged: () => Promise<void>; navigationGuard: { current: (() => boolean) | null } }): JSX.Element {
  const [sources, setSources] = useState<QoderByokSource[]>([])
  const [draft, setDraft] = useState<QoderByokInput | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const refresh = async () => { const values = await window.uniagent.listQoderByok(); if (mounted.current) setSources(values) }
  useEffect(() => { mounted.current = true; void refresh().catch(() => setError('Qoder 原生来源读取失败，请先检查登录与连接')); return () => { mounted.current = false } }, [])
  useEffect(() => { navigationGuard.current = draft ? () => window.confirm('尚未保存 Qoder 模型来源，是否离开？') : null; return () => { navigationGuard.current = null } }, [draft])
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError('')
    try { await action(); await refresh(); await onModelsChanged(); setDraft(null) }
    catch (error) { setError(error instanceof Error ? error.message : 'Qoder 模型来源操作失败') }
    finally { setBusy(false) }
  }
  return <>
    <SetGroup title="Qoder 原生模型来源" action={<button className="set-mini-btn primary" disabled={busy} onClick={() => setDraft({ id: '', name: '', baseUrl: '', apiKey: '', protocol: 'openai', models: [] })}>添加来源</button>}>
      {sources.map(source => <SetRow key={source.id} label={source.name} sub={<>{source.baseUrl}<br />{source.models.join('、')}</>} control={<>
        {source.kind === 'provider' && <button className="set-mini-btn" disabled={busy} onClick={() => setDraft({ id: source.id, name: source.name, baseUrl: source.baseUrl || '', protocol: source.protocol || 'openai', models: source.models, existing: true })}>编辑</button>}
        <button className="set-mini-btn" disabled={busy} onClick={() => { if (window.confirm(`删除 Qoder 原生来源“${source.name}”？会影响共用此配置的客户端。`)) void run(() => window.uniagent.deleteQoderByok({ id: source.id, kind: source.kind })) }}>删除</button>
      </>} />)}
      {!sources.length && <p className="settings-dim">暂无已读取的 BYOK 来源。</p>}
    </SetGroup>
    {error && <p className="deepseek-setup-error" role="alert">{error}</p>}
    {draft && <SetGroup title={draft.existing ? '编辑来源' : '添加来源'}>
      <SetRow label="来源 ID" control={<input className="set-fld-inp" value={draft.id} disabled={busy || draft.existing} onChange={event => setDraft({ ...draft, id: event.target.value })} />} />
      <SetRow label="名称" control={<input className="set-fld-inp" value={draft.name} disabled={busy} onChange={event => setDraft({ ...draft, name: event.target.value })} />} />
      <SetRow label="服务 URL" control={<input className="set-fld-inp" value={draft.baseUrl} disabled={busy} placeholder="https://api.example.com/v1" onChange={event => setDraft({ ...draft, baseUrl: event.target.value })} />} />
      <SetRow label="协议" control={<select className="set-fld-inp" value={draft.protocol} disabled={busy} onChange={event => setDraft({ ...draft, protocol: event.target.value as QoderByokInput['protocol'] })}><option value="openai">OpenAI Chat</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic">Anthropic</option></select>} />
      <SetRow label="API Key" sub={draft.existing ? '留空保留原生 Key。' : '经 Qoder 原生校验后保存，配置与原生客户端共用。'} control={<input className="set-fld-inp" type="password" autoComplete="off" value={draft.apiKey || ''} disabled={busy} onChange={event => setDraft({ ...draft, apiKey: event.target.value })} />} />
      <SetRow label="模型 ID" sub="每行一个模型 ID。" control={<textarea className="set-fld-inp" value={draft.models.join('\n')} disabled={busy} onChange={event => setDraft({ ...draft, models: event.target.value.split('\n') })} />} />
      <div className="mcode-actions"><button className="set-mini-btn" disabled={busy} onClick={() => setDraft(null)}>取消</button><button className="set-mini-btn primary" disabled={busy || !draft.id.trim() || !draft.name.trim() || !draft.baseUrl.trim() || !draft.models.some(model => model.trim()) || !draft.existing && !draft.apiKey?.trim()} onClick={() => void run(() => window.uniagent.saveQoderByok({ ...draft, models: draft.models.filter(model => model.trim()) }))}>{busy ? '验证中…' : '验证并保存'}</button></div>
    </SetGroup>}
  </>
}
