import { useEffect, useState } from 'react'
import { agentInitializationPrompt } from '@shared/agentInitialization'
import { UiIcon } from './Icons'

export function AgentInstallFallback({ id, name, failure = '' }: { id: string; name: string; failure?: string }): JSX.Element {
  const [open, setOpen] = useState(!!failure)
  const [notice, setNotice] = useState('')
  useEffect(() => { if (failure) setOpen(true) }, [failure])
  const prompt = (failure ? `本次安装未完成：${failure}\n请先定位失败阶段，保留已完成步骤。\n\n` : '') + agentInitializationPrompt(id, name)
  const copy = async () => {
    try { await navigator.clipboard.writeText(prompt); setNotice('安装提示词已复制') }
    catch { setNotice('复制失败，请选中上方原文手动复制') }
  }
  return <div className="agent-install-fallback">
    <button className="mcode-prompt-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}><UiIcon name="chevron-right" size={12} />备用方式：提示词安装</button>
    {open && <div className="mcode-prompt">
      <p>复制给外部 Agent，协助完成本机安装。无需 UniAgent 已有可用 Agent。</p>
      <textarea aria-label={`${name} 完整安装提示词`} readOnly value={prompt} />
      <button className="set-mini-btn primary" onClick={() => void copy()}>复制安装提示词</button>
      <p>外部完成后，点击上方“重新检测”。</p>
      {notice && <p role="status">{notice}</p>}
    </div>}
  </div>
}
