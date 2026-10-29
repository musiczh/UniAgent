import assert from 'node:assert/strict'
import React, { type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingsPanel } from '../src/renderer/components/SettingsPanel.tsx'

function renderFeishuSettings(configured = true): ReactElement {
  const dispatcher = (React as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
      ReactCurrentDispatcher: { current: unknown }
    }
  }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
  const previous = dispatcher.current
  let stateIndex = 0
  dispatcher.current = {
    useState(initial: unknown) {
      const index = stateIndex++
      // feishu 状态位于 SettingsPanel 主组件 useState 序列的第 27 个（紧邻 assistantPage 的 'config' 状态之后）；
      // 在此之前新增 useState 时需同步更新该索引。
      const value = index === 27 && configured
        ? { appId: 'cli_test', connected: true }
        : initial === 'config' ? 'feishu' : typeof initial === 'function' ? (initial as () => unknown)() : initial
      return [value, () => {}]
    },
    useRef(initial: unknown) { return { current: initial } },
    useEffect() {}
  }
  try {
    return SettingsPanel({
      initialCategory: 'assistants',
      agents: [],
      onRedetect: () => {},
      onInitialize: () => {},
      onAgentsChanged: () => {},
      onOpenSync: () => {},
      onBack: () => {}
    })
  } finally {
    dispatcher.current = previous
  }
}

const markup = renderToStaticMarkup(renderFeishuSettings())
const selectAt = markup.indexOf('aria-label="无操作后视为离开"')
assert.notEqual(selectAt, -1, 'the Feishu idle-threshold select is rendered')
const selectMarkup = markup.slice(selectAt, selectAt + 1200)

assert.match(
  selectMarkup,
  /width:100%;min-width:0;padding-right:22px/,
  'the native select extends underneath the caret hit area'
)
assert.match(
  selectMarkup,
  /class="set-caret" style="position:absolute;right:11px;top:50%;transform:translateY\(-50%\);pointer-events:none"/,
  'the caret cannot intercept clicks intended for the native select'
)
assert.match(selectMarkup, /d="m9 6 6 6-6 6"/, 'the select uses a right-facing chevron')
assert.doesNotMatch(
  renderToStaticMarkup(renderFeishuSettings(false)),
  /aria-label="无操作后视为离开"/,
  'notification settings stay hidden until a bot is bound'
)

console.log('settings-select-hit-target: ok')
