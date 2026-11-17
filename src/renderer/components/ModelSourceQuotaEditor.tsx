import { useEffect, useState } from 'react'
import { QUOTA_QUERY_TEMPLATES, modelSourceQuotaProvider, validateQuotaQuery, type ModelSourceQuotaQuery, type ModelSourceQuotaCredentials } from '@shared/modelSourceQuota'
import type { ModelSource, ModelSourcesSnapshot } from '@shared/modelSources'

export function ModelSourceQuotaEditor({ source, revision, disabled, onSaved, onCancel, onDirty, onConsole, onSaving }: {
  source: ModelSource; revision: string; disabled: boolean; onSaved: (snapshot: ModelSourcesSnapshot) => void; onCancel: () => void; onDirty: (dirty: boolean) => void; onConsole: (url: string) => void; onSaving?: (saving: boolean) => void
}): JSX.Element {
  const [query, setQuery] = useState<ModelSourceQuotaQuery>(source.quotaQuery ?? { template: 'auto' })
  const [credentials, setCredentials] = useState<ModelSourceQuotaCredentials>({})
  const [expectedRevision] = useState(revision)
  const [saving, setSaving] = useState(false), [error, setError] = useState('')
  const provider = modelSourceQuotaProvider({ ...source, quotaQuery: query })
  const ark = provider?.preset === 'ark-coding-plan' || provider?.preset === 'ark-agent-plan'
  const newApi = query.template === 'new-api'
  useEffect(() => () => onDirty(false), [onDirty])
  const edit = (next: ModelSourceQuotaQuery) => { setQuery(next); setError(''); onDirty(true) }
  const secret = (key: keyof ModelSourceQuotaCredentials, value: string) => { setCredentials(current => ({ ...current, [key]: value })); setError(''); onDirty(true) }
  const save = async (clearCredentials = false) => {
    if (saving || disabled) return
    setSaving(true); onSaving?.(true); setError('')
    try {
      const normalized = validateQuotaQuery(query)
      const entered = Object.fromEntries(Object.entries(credentials).filter(([, value]) => value))
      const input = { sourceId: source.id, expectedRevision, operationId: crypto.randomUUID(), query: normalized, ...(clearCredentials ? { clearCredentials: true } : Object.keys(entered).length ? { credentials: entered } : {}) }
      const saved = await window.uniagent.saveModelSourceQuota(input)
      setCredentials({}); onDirty(false); onSaved(saved)
    } catch (error: any) { setError(error.message || '额度查询设置保存失败，请重试') }
    finally { setSaving(false); onSaving?.(false) }
  }
  return <fieldset className="quota-query-editor" disabled={saving}>
    <fieldset className="quota-query-fields" disabled={disabled}>
    {<label className="set-fld"><span>查询方式</span><select className="set-fld-inp" aria-label="额度查询方式" value={query.template} onChange={event => { edit({ template: event.target.value as ModelSourceQuotaQuery['template'] }); setCredentials({}) }}>{QUOTA_QUERY_TEMPLATES.filter(template => source.preset === 'custom' || ['auto', 'console'].includes(template.id)).map(template => <option key={template.id} value={template.id}>{template.label}</option>)}</select></label>}
    {ark && <><p className="quota-query-help">点击下方“打开密钥管理”，登录开通套餐的火山引擎账号，在 Access Key 区域新建密钥，再复制 AccessKey ID（AK）和 Secret AccessKey（SK），分别填入下方输入框。</p><p className="quota-query-help">查询套餐用量需要具有对应套餐查询权限的密钥；使用子用户时，请联系账号管理员确认权限。</p><div className="set-fld-row"><label className="set-fld"><span>AccessKey ID</span><input className="set-fld-inp" aria-label="AccessKey ID" autoComplete="off" spellCheck={false} value={credentials.accessKeyId ?? ''} placeholder={source.hasQuotaCredentials ? '已保存，填写可替换' : '填写额度查询用的 AccessKey ID'} onChange={event => secret('accessKeyId', event.target.value)} /></label><label className="set-fld"><span>Secret AccessKey</span><input className="set-fld-inp" aria-label="Secret AccessKey" type="password" autoComplete="off" spellCheck={false} value={credentials.secretAccessKey ?? ''} placeholder={source.hasQuotaCredentials ? '已保存，替换时同时填写 AK / SK' : '填写 Secret AccessKey'} onChange={event => secret('secretAccessKey', event.target.value)} /></label></div></>}
    {newApi && <><p className="quota-query-help">New API 使用该站点的访问令牌和用户 ID 查询。金额换算遵循站点配置。</p><div className="set-fld-row"><label className="set-fld"><span>Access Token</span><input className="set-fld-inp" aria-label="额度访问令牌" type="password" autoComplete="off" spellCheck={false} value={credentials.accessToken ?? ''} placeholder={source.hasQuotaCredentials ? '已保存，填写可替换' : '填写该站点的访问令牌'} onChange={event => secret('accessToken', event.target.value)} /></label><label className="set-fld"><span>用户 ID</span><input className="set-fld-inp" aria-label="额度用户 ID" inputMode="numeric" value={query.userId ?? ''} onChange={event => edit({ ...query, userId: event.target.value || undefined })} /></label></div><div className="set-fld-row"><label className="set-fld"><span>额度单位</span><select className="set-fld-inp" aria-label="额度单位" value={query.unit ?? 'quota'} onChange={event => edit({ ...query, unit: event.target.value as ModelSourceQuotaQuery['unit'] })}><option value="quota">原始额度</option><option value="USD">USD</option><option value="CNY">CNY</option></select></label>{query.unit && query.unit !== 'quota' && <label className="set-fld"><span>每单位对应额度</span><input className="set-fld-inp" aria-label="每单位对应额度" type="number" min="1" step="1" value={query.quotaPerUnit ?? ''} placeholder="按站点规则填写" onChange={event => edit({ ...query, quotaPerUnit: event.target.value ? Number(event.target.value) : undefined })} /></label>}</div></>}
    {!ark && !newApi && <p className="quota-query-help">{query.template === 'console' ? '使用该来源的控制台查看额度。' : provider ? '使用已保存的对应 API Key 查询；同一 Key 只查询一次。' : '当前地址未匹配所选查询方式，可选择站点对应模板或使用控制台。'}</p>}
    {(ark || newApi) && <p className="quota-query-help">查询凭据加密保存在本机，仅用于额度查询。模型调用继续使用连接信息中的 API Key。</p>}
    </fieldset>
    {disabled && <p className="quota-query-help">请先取消额度编辑并保存连接与模型配置，再配置额度查询。</p>}
    {error && <div className="model-source-quota-error" role="alert">{error}</div>}
    <div className="quota-actions"><button type="button" className="set-mini-btn primary" disabled={disabled} onClick={() => void save()}>{saving ? '保存中…' : '保存并查询'}</button><button type="button" className="set-mini-btn" onClick={onCancel}>取消</button>{ark && <button type="button" className="set-mini-btn" onClick={() => onConsole('https://console.volcengine.com/iam/keymanage/')}>打开密钥管理</button>}{source.hasQuotaCredentials && <button type="button" className="set-mini-btn" disabled={disabled} onClick={() => void save(true)}>清除查询凭据</button>}</div>
  </fieldset>
}
