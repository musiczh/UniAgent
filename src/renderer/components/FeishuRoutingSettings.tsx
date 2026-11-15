import { useEffect, useState } from 'react'
import type { FeishuSettings } from '@shared/types'
import type { RouterSnapshot } from '@shared/router'
import { SetGroup, SetRow } from './SettingsPrimitives'
import { ToggleSwitch } from './Icons'

export function FeishuRoutingSettings({ config, onPatch, onOpenRouter }: {
  config?: FeishuSettings
  onPatch: (patch: Partial<FeishuSettings>) => void
  onOpenRouter: () => void
}): JSX.Element {
  const [router, setRouter] = useState<RouterSnapshot | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    const refresh = () => void window.uniagent.getRouterSnapshot().then(value => {
      if (alive) { setRouter(value); setError('') }
    }).catch(() => { if (alive) { setRouter(null); setError('RouterAgent 状态读取失败') } })
    refresh()
    const stop = window.uniagent.onRouterChanged(refresh)
    return () => { alive = false; stop() }
  }, [])
  const ready = router?.config.enabled && router.available
  return <SetGroup title="新话题归属">
    <SetRow label="自动路由新对话"
      sub="开启后不再弹出选择卡片，由 RouterAgent 自动判断项目、需求和任务归属，随后显示路由结果与会话进展。"
      control={<ToggleSwitch label="自动路由新对话" checked={config?.autoRouteNewConversations === true} onChange={value => onPatch({ autoRouteNewConversations: value })} />} />
    <SetRow label="RouterAgent"
      sub={error || (!router ? '正在读取路由配置…' : !router.config.enabled ? '尚未启用；新话题仍可手动选择。' : !router.available ? router.reason : '沿用 superAgent配置中的路由模型；新建任务使用下方默认参数，已有任务沿用原配置。')}
      control={<><span className={ready ? 'txt-ok' : 'txt-off'}>{ready ? '已启用' : router && !router.config.enabled ? '未启用' : '暂不可用'}</span><button type="button" className="set-mini-btn" onClick={onOpenRouter}>查看配置</button></>} />
  </SetGroup>
}
