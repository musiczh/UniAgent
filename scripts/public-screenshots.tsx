import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import DOMPurify from 'dompurify'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { SessionList } from '../src/renderer/components/SessionList'
import { EventStream } from '../src/renderer/components/EventStream'
import { Composer } from '../src/renderer/components/Composer'
import { FeishuNotificationSettings } from '../src/renderer/components/FeishuNotificationSettings'
import { UiIcon } from '../src/renderer/components/Icons'
import { AgentIcon } from '../src/renderer/components/AgentIcon'
import type { AgentDef, Session, UAEvent, FeishuStatus } from '../src/shared/types'
import { emptyNativeCapabilitySnapshot } from '../src/shared/nativeCapabilities'

const noop = () => {}
Object.assign(globalThis, { localStorage: { getItem: () => null }, window: { localStorage: { getItem: () => null } } })
Object.assign(DOMPurify, { sanitize: (html: string) => html }) // Only the fixed demonstration text below is rendered.
const names = { codex: 'Codex', claude: 'Claude Code', grok: 'Grok', kimi: 'Kimi Code', deepseek: 'DeepSeek Harness', mcode: 'MiniMax Code', zcode: 'ZCode' }
const agents = Object.entries(names).map(([id, name]) => ({
  id, name, bin: id, adapter: id, icon: id, builtin: true, installed: true,
  models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: ['high'] }], defaultModel: 'gpt-6.1-sol',
  capabilities: { modelSelect: true, reasoningEffort: true, streaming: true, permissionModes: [{ id: 'ask', label: '请求批准', hint: '' }] },
  lifecycle: { availability: 'available', detectionStatus: 'ready', updateStatus: 'idle' }
})) as AgentDef[]
const sessions = [
  ['unit-tests', '为开源项目补充单元测试', 'codex'],
  ['review', '检查这次提交的边界处理', 'claude'],
  ['docs', '整理项目的使用说明', 'kimi']
].map(([id, title, agentId]) => ({ id, title, status: 'idle', createdAt: 1, updatedAt: 1, config: { agentId, workdir: '/workspace/demo', model: 'gpt-6.1-sol', effort: 'high', permissionMode: 'ask' } })) as Session[]
const events = [
  ['user_message', { text: '为这个开源项目补充单元测试，覆盖无效输入和边界情况。' }],
  ['agent_message', { id: 'step-1', phase: 'commentary', text: '先查看项目结构和已有测试，确认需要覆盖的行为。' }],
  ['command_exec', { id: 'command-1', command: 'rg --files src test', output: 'src/validation.ts\ntest/validation.test.ts', exitCode: 0 }],
  ['agent_message', { id: 'step-2', phase: 'commentary', text: '已补充正常输入、空输入和边界值的测试，接下来运行相关用例。' }],
  ['command_exec', { id: 'command-2', command: 'pnpm test', output: '12 tests passed', exitCode: 0 }],
  ['agent_message', { id: 'answer', phase: 'final_answer', text: '已补充单元测试，覆盖正常输入、空值和边界值。\n\n相关用例通过，测试文件与实现放在同一套工作流中管理。' }],
  ['turn_completed', {}]
].map(([type, payload], index) => ({ sessionId: 'unit-tests', seq: index + 1, ts: 1_000 + index * 8_000, type, payload, state: 'success' })) as UAEvent[]
const css = readFileSync('src/renderer/styles.css', 'utf8') + readFileSync('out/public-review/public-screenshots.css', 'utf8')
const style = `${css}\nhtml,body{height:auto!important;min-height:0!important;margin:0!important;width:1160px!important}body{display:block!important;background:#101113}.public-demo{height:780px;display:flex;border:1px solid #3a3c40;border-radius:14px;overflow:hidden}.public-demo-sidebar{width:246px;flex:none;background:var(--sidebar-bg,#17181a);display:flex;flex-direction:column;border-right:1px solid var(--border,#303237)}.public-demo-brand{height:62px;padding:20px;display:flex;align-items:center;gap:10px;font-size:18px;font-weight:600}.public-demo-sidebar .session-list{flex:1}.public-demo-main{min-width:0;flex:1;display:flex;flex-direction:column}.public-demo-head{padding:20px 24px;border-bottom:1px solid var(--border,#303237);font-size:15px;font-weight:600;display:flex;gap:12px;align-items:center}.public-demo-events{flex:1;min-height:0;overflow:hidden;padding:10px 22px}.public-demo-composer{padding:10px 20px 20px}.public-demo-label{font-size:11px;color:var(--text-muted,#93969e);margin-left:auto;font-weight:400}.public-demo-settings{height:340px;position:relative;overflow:hidden}.public-demo-settings .main-panel{height:100%;position:relative;inset:auto}.public-demo-settings .settings-inner{height:100%}`
function save(name: string, contents: React.ReactElement) {
  mkdirSync('docs/mockups', { recursive: true })
  writeFileSync(`docs/mockups/${name}.html`, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>UniAgent Public 公开界面示例</title><style>${style}</style></head><body>${renderToStaticMarkup(contents)}</body></html>`)
}
save('public-workbench-v1.1.0', <div className="public-demo">
  <aside className="public-demo-sidebar"><div className="public-demo-brand"><img width="22" height="22" src={'data:image/svg+xml;base64,' + Buffer.from(readFileSync('src/renderer/public/app-icon.svg')).toString('base64')} alt=""/>UniAgent Public</div>
    <SessionList sessions={sessions} agents={agents} activeId="unit-tests" statusBySession={{}} unreadBySession={{}} onSelect={noop} onArchive={noop} onUnarchive={noop} onDelete={noop} onArchiveMany={noop} onDeleteMany={noop} onRename={noop} onPin={noop}/>
  </aside><main className="public-demo-main"><header className="public-demo-head"><UiIcon name="folder" size={18}/>为开源项目补充单元测试<span className="public-demo-label">组件演示 · 示例数据</span></header>
    <section className="public-demo-events"><EventStream events={events} status="idle" sessionId="unit-tests" onRespond={async () => {}}/></section>
    <div className="public-demo-composer"><Composer sessionId="unit-tests" status="idle" agent={agents[0]} config={sessions[0].config} onSend={async () => {}} onForceSend={async () => {}} onInterrupt={noop} onUpdateConfig={noop} onSetCollaborationMode={noop} onRunNativeAction={noop} queue={[]} onDequeue={noop} onPromoteQueue={noop} onEditQueueItem={noop} capabilities={emptyNativeCapabilitySnapshot('codex', '/workspace/demo')} capabilitiesReady contextUsed={0} onCompact={async () => {}} canCompact compacting={false}/></div>
  </main></div>)
save('public-feishu-v1.1.0', <div className="public-demo-settings main-panel"><header className="main-panel-head"><span className="main-panel-title">飞书通知目标</span><span className="public-demo-label">组件演示 · 示例数据</span></header><div className="settings-inner"><div className="set-page">
  <FeishuNotificationSettings status={{ connected: true, appId: 'demo-app', notificationTarget: { kind: 'private', chatId: 'demo-private' } } as FeishuStatus} onStatus={noop}/>
  <FeishuNotificationSettings status={{ connected: true, appId: 'demo-app', notificationTarget: { kind: 'group', chatId: 'demo-group', name: '开源项目讨论' } } as FeishuStatus} onStatus={noop}/>
</div></div></div>)
writeFileSync('out/public-review/nika-logo.html', renderToStaticMarkup(<AgentIcon agentId="nika" size={36}/>))
