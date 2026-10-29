import { useEffect, useRef, useState } from 'react'
import type { FeishuGroupChat, FeishuNotificationBinding, FeishuStatus } from '@shared/types'
import { SetGroup, SetRow } from './SettingsPrimitives'
import { UiIcon } from './Icons'

export function FeishuNotificationSettings({ status, onStatus }: {
  status: FeishuStatus | null
  onStatus: (status: FeishuStatus) => void
}): JSX.Element {
  const [choosing, setChoosing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [groups, setGroups] = useState<FeishuGroupChat[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const version = useRef(0)
  const binding = status?.notificationBinding
  const target = status?.notificationTarget
  const connected = !!status?.connected
  useEffect(() => {
    version.current++
    setGroups(null); setError(''); setCopied(false); setChoosing(false); setScanning(false); setBusy(false)
  }, [status?.appId, target?.chatId, target?.kind])
  useEffect(() => () => { version.current++ }, [])

  async function run(operation: () => Promise<FeishuStatus>): Promise<void> {
    const current = version.current
    setBusy(true); setError(''); setCopied(false)
    try { const next = await operation(); if (current === version.current) onStatus(next) }
    catch (error) { if (current === version.current) setError((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')) }
    finally { if (current === version.current) setBusy(false) }
  }
  async function start(input: FeishuNotificationBinding): Promise<void> {
    version.current++; setScanning(false); setChoosing(false)
    if (!input.chatId) setGroups(null)
    await run(() => window.uniagent.feishuBeginNotificationBinding(input))
  }
  async function scan(): Promise<void> {
    const current = ++version.current
    setScanning(true); setError('')
    try {
      const result = await window.uniagent.feishuScanGroups()
      if (current === version.current) setGroups(result)
    } catch {
      if (current === version.current) setError('扫描失败，请确认机器人已连接后重试')
    } finally { if (current === version.current) setScanning(false) }
  }
  async function copy(): Promise<void> {
    try { await navigator.clipboard.writeText('绑定通知'); setCopied(true) }
    catch { setError('复制失败，请在飞书中手动输入“绑定通知”') }
  }
  const cancel = () => {
    version.current++; setScanning(false); setChoosing(false); setGroups(null)
    return run(() => window.uniagent.feishuCancelNotificationBinding())
  }
  const choices = <div className="feishu-notification-actions">
    <button className="set-mini-btn primary" disabled={!connected || busy} onClick={() => void start({ kind: 'private' })}>绑定到私人聊天</button>
    <button className="set-mini-btn" disabled={!connected || busy} onClick={() => void start({ kind: 'group' })}>绑定到群聊</button>
  </div>
  return <SetGroup title="通知目标">
    <SetRow
      label={binding ? `绑定到${binding.kind === 'private' ? '私人聊天' : '群聊'}` : target
        ? <span className="feishu-notification-success"><UiIcon name="check" size={15} />已绑定到{target.kind === 'private' ? '私人聊天' : '群聊'}</span> : '接收任务通知'}
      sub={binding ? binding.kind === 'private' ? '与当前会话机器人私聊，接收任务进度和回复' : '将任务通知发送到你选择的飞书群聊'
        : target ? target.kind === 'private' ? '任务通知将发送到你的机器人私聊' : `任务通知将发送到「${target.name || target.chatId}」`
          : '尚未绑定，请选择私人聊天或群聊'}
      control={binding ? <div className="feishu-notification-actions"><span className="feishu-notification-pending">待完成</span><button className="set-mini-btn ghost" disabled={busy} onClick={() => void cancel()}>取消</button></div>
        : target ? <div className="feishu-notification-actions"><span className="txt-ok" role="status">绑定成功</span><button className="set-mini-btn" disabled={!connected || busy} onClick={() => setChoosing(value => !value)}>更换目标</button><button className="set-mini-btn ghost" disabled={busy} onClick={() => void run(() => window.uniagent.feishuUnbindNotificationTarget())}>解绑</button></div>
          : choices}
    />
    {choosing && !binding && target && <div className="feishu-notification-guide">{choices}<div className="set-detail-sub">新目标绑定成功前，原通知目标保持生效。</div></div>}
    {binding && <div className="feishu-notification-guide">
      {binding.kind === 'private' ? <>
        <div className="feishu-notification-step"><span className="feishu-step-number">1</span><div>打开当前会话机器人的飞书私聊<div className="feishu-notification-actions"><button className="set-mini-btn primary" disabled={!connected || !status?.appId} onClick={() => void window.uniagent.openExternal(`https://applink.feishu.cn/client/bot/open?appId=${encodeURIComponent(status!.appId!)}`).catch(() => setError('无法打开飞书，请在飞书中搜索当前会话机器人'))}>打开机器人私聊<UiIcon name="external-link" size={13} /></button></div><div className="set-detail-sub">请使用“会话同步”绑定的机器人。</div></div></div>
        <div className="feishu-notification-step"><span className="feishu-step-number">2</span><div>发送一条消息，即可完成绑定<div className="feishu-notification-message"><span>绑定通知</span><button className="set-mini-btn" onClick={() => void copy()}>{copied ? '已复制' : '复制消息'}</button></div><div className="set-detail-sub">也可发送其他文字；本次消息仅用于绑定，不会创建任务。</div></div></div>
      </> : <>
        <div className="feishu-notification-step"><span className="feishu-step-number">1</span><div>将当前会话机器人添加到目标群聊<div className="set-detail-sub">在飞书群设置中，打开“群机器人”，添加当前会话机器人。</div></div></div>
        <div className="feishu-notification-step"><span className="feishu-step-number">2</span><div><div className="feishu-notification-group-heading"><span>扫描并选择要绑定的群聊</span><button className="set-mini-btn" disabled={!connected || busy || scanning} onClick={() => void scan()}>{scanning ? '扫描中…' : groups ? '重新扫描' : '扫描群聊'}</button></div>
          {groups?.length === 0 && <div className="set-detail-sub">未找到群聊，请确认机器人已加入后重新扫描。</div>}
          {!!groups?.length && <div className="feishu-notification-groups">{groups.map(group => <div className="feishu-notification-group" key={group.chatId}><span>{group.name || group.chatId}</span><button className="set-mini-btn" disabled={!connected || busy} aria-label={`绑定到${group.name || group.chatId}`} onClick={() => void start({ kind: 'group', chatId: group.chatId, name: group.name })}>选择</button></div>)}</div>}
        </div></div>
      </>}
      <div className="feishu-notification-wait" role="status">{!connected || binding.kind === 'private'
        ? <><span className="feishu-notification-pending">{!connected ? '机器人未连接，等待恢复…' : '等待你发送消息…'}</span>{binding.kind === 'private' && <span className="set-detail-sub">收到后自动显示绑定结果，无需刷新。</span>}</>
        : <span className="set-detail-sub">选择后立即完成绑定。</span>}</div>
      {target && <div className="set-detail-sub">新目标绑定成功前，原通知目标保持生效。</div>}
    </div>}
    {!connected && !binding && <div className="set-detail-sub feishu-notification-hint">{target ? '机器人未连接，恢复后继续通知。' : '请先连接会话机器人，再选择通知目标。'}</div>}
    {(error || binding?.error) && <div className="feishu-notification-error" role="alert">{error || binding?.error}</div>}
  </SetGroup>
}
