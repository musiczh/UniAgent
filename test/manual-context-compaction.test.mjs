import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const read = (path) => readFile(resolve('test', path), 'utf8')
const [app, composer, meter, eventStream, styles, orchestrator, preload, main, types] = await Promise.all([
  read('../src/renderer/App.tsx'),
  read('../src/renderer/components/Composer.tsx'),
  read('../src/renderer/components/ContextMeter.tsx'),
  read('../src/renderer/components/EventStream.tsx'),
  read('../src/renderer/styles.css'),
  read('../src/main/orchestrator.ts'),
  read('../src/preload/index.ts'),
  read('../src/main/index.ts'),
  read('../src/shared/types.ts')
])

// Component contract: App owns eligibility, Composer forwards it without
// reinterpretation, and ContextMeter owns the visible action/control state.
assert.match(meter, /className="ctx-compact-btn"/, 'ContextMeter popover must expose the compact action')
for (const prop of ['onCompact', 'canCompact', 'compacting', 'disabledReason']) {
  assert.equal(composer.includes(prop), true, `Composer must accept and forward ${prop}`)
  assert.equal(meter.includes(prop), true, `ContextMeter must accept ${prop}`)
}
assert.match(composer, /<ContextMeter[\s\S]*?onCompact=\{onCompact\}[\s\S]*?canCompact=\{canCompact\}[\s\S]*?compacting=\{compacting\}[\s\S]*?disabledReason=\{disabledReason\}/)
assert.match(
  composer,
  /<details className="sb-menu sb-add">[\s\S]*?暂无可添加内容[\s\S]*?<\/details>/,
  'Composer must always render its add menu and provide an explicit empty state'
)
assert.match(app, /onCompact=\{handleCompactSession\}/)
assert.match(app, /window\.uniagent\.compactSession\(activeId\)/)
assert.doesNotMatch(app, /window\.uniagent\.(?:runCommand|listCandidates)/)
assert.doesNotMatch(preload, /\b(?:runCommand|listCandidates):/)
assert.doesNotMatch(main, /IPC\.(?:runCommand|listCandidates)/)
assert.doesNotMatch(types, /runCommand:\s*'session:runCommand'|listCandidates:\s*'agent:candidates'/)
assert.match(app, /runtime\.hasLiveStreamer/, 'renderer must use authoritative process-local runner state')
assert.match(orchestrator, /hasLiveStreamer:\s*this\.streamers\.has\(sessionId\)/)
assert.match(orchestrator, /hasLiveStreamer:\s*true/)
assert.match(orchestrator, /hasLiveStreamer:\s*false/)
assert.match(meter, /disabled=\{!canCompact \|\| compactBusy\}/)
assert.match(meter, /await onCompact\(\)/, 'enabled button must invoke and await the callback')
assert.match(meter, /requestPending\.current/, 'clicks must be synchronously deduplicated')
assert.match(meter, /aria-expanded=\{open\}/, 'popover trigger must be keyboard accessible')
assert.match(meter, /ctx-compact-reason/, 'disabled state must show a human-readable reason')

// Hovering from the meter into its interactive popover must cross one continuous
// hit area. A short, cleaned-up grace timer also tolerates diagonal pointer paths.
assert.match(meter, /className="ctx-pop-anchor"/, 'popover must have a transparent hover anchor')
assert.match(meter, /onPointerEnter=\{openFromPointer\}/)
assert.match(meter, /onPointerLeave=\{scheduleHoverClose\}/)
assert.match(meter, /hoverCloseTimer[\s\S]*?setTimeout[\s\S]*?clearTimeout/, 'hover close timer must be scheduled and cleaned up')
assert.match(meter, /event\.key === 'Escape'/, 'keyboard users must be able to dismiss the popover')
assert.match(meter, /onBlurCapture=/, 'keyboard focus leaving the widget must dismiss the popover')
assert.match(meter, /onClick=\{\(event\) =>[\s\S]*?togglePopover\(\)/, 'trigger activation must use the shared toggle path')
assert.match(
  styles,
  /\.ctx-pop-anchor\s*\{[\s\S]*?bottom:\s*calc\(100% - 2px\);[\s\S]*?padding-bottom:\s*10px;/,
  'the anchor hitbox must overlap the trigger and bridge the visual gap'
)
assert.doesNotMatch(
  styles,
  /\.ctx-pop\s*\{[^}]*bottom:\s*130%;/,
  'the visible popover must not recreate the non-interactive 130% gap'
)

// The lifecycle row is keyed, mergeable UI state and intentionally one line.
assert.match(eventStream, /data-compaction-id=\{ev\.payload\.id\}/)
assert.match(eventStream, /role="status"/)
assert.match(eventStream, /上下文压缩中…/)
assert.match(eventStream, /上下文压缩完成/)
assert.match(
  eventStream,
  /previousTurn\?\.done && \(ev\.type === 'context_compaction' \|\| ev\.type === 'model_switch'\)/,
  'idle manual compaction must start a visible synthetic turn after turn_completed'
)
assert.match(styles, /\.context-compaction\s*\{[\s\S]*?white-space:\s*nowrap;/)
assert.match(styles, /\.context-compaction > span \{ line-height:\s*16px;/)

const { contextCompactionAvailability, supportsManualContextCompaction } = await import('../src/renderer/contextCompaction.ts')
assert.equal(
  supportsManualContextCompaction({ adapter: 'codex', capabilities: { streaming: true } }),
  true,
  'streaming Codex uses the app-server compact path'
)
assert.equal(
  supportsManualContextCompaction({ adapter: 'traex', capabilities: { streaming: true } }),
  true,
  'streaming TraeX uses the app-server compact path'
)
assert.equal(
  supportsManualContextCompaction({ adapter: 'claude', capabilities: { streaming: true } }),
  true,
  'streaming Claude accepts /compact in a resumed turn'
)
for (const agent of [
  { adapter: 'codex', capabilities: { streaming: false } },
  undefined
]) {
  assert.equal(supportsManualContextCompaction(agent), false)
}
assert.deepEqual(
  contextCompactionAvailability(true, 'idle', [], true),
  { canCompact: true, compacting: false, providerSwitchCompacting: false, disabledReason: undefined },
  'idle sessions with the /compact candidate may compact'
)
assert.deepEqual(
  contextCompactionAvailability(true, 'completed', [], true),
  { canCompact: true, compacting: false, providerSwitchCompacting: false, disabledReason: undefined },
  'completed Goal sessions remain reusable for manual compaction'
)
assert.match(
  contextCompactionAvailability(false, 'idle', [], false).disabledReason ?? '',
  /不支持/,
  'agents without the /compact candidate explain that compaction is unsupported'
)
assert.match(
  contextCompactionAvailability(true, 'running', [], false).disabledReason ?? '',
  /运行中/,
  'busy sessions explain why the action is disabled'
)
const running = [{ type: 'context_compaction', state: 'running' }]
assert.deepEqual(
  contextCompactionAvailability(true, 'idle', [], true, true),
  { canCompact: false, compacting: false, providerSwitchCompacting: false, disabledReason: '正在切换模型，请等待准备完成。' },
  '压缩结束后等待目标模型连接期间，不得开始第二次压缩'
)
assert.deepEqual(
  contextCompactionAvailability(true, 'idle', running, true),
  { canCompact: false, compacting: true, providerSwitchCompacting: false, disabledReason: '上下文正在压缩，请等待完成。' },
  'a running lifecycle prevents duplicate requests'
)
assert.equal(contextCompactionAvailability(true, 'idle', [
  { type: 'context_compaction', state: 'running', payload: { reason: 'provider-switch' } }
], true).providerSwitchCompacting, true, '跨来源主动压缩显示输入框提示')
assert.equal(contextCompactionAvailability(true, 'idle', [
  { type: 'context_compaction', state: 'success', payload: { reason: 'provider-switch' } }
], true).providerSwitchCompacting, false, '压缩结束不能遗留输入框提示')
assert.match(
  contextCompactionAvailability(true, 'idle', [], false).disabledReason ?? '',
  /尚未建立实时连接/,
  'a restored idle session without a process-local runner must not enable compaction'
)

console.log('manual-context-compaction: ok')
