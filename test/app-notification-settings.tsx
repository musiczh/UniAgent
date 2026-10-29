import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingsPanel } from '../src/renderer/components/SettingsPanel'
import { APP_NAME } from '../src/shared/distribution'

const dispatcher = (React as unknown as {
  __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } }
}).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
const previous = dispatcher.current
let stateIndex = 0
dispatcher.current = {
  useState(initial: unknown) {
    const index = stateIndex++
    const value = index === 11
      ? { schemaVersion: 1, autoUpdateAgentsOnLaunch: false, autoCheckUpdate: true, notificationMode: 'unfocused' }
      : typeof initial === 'function' ? (initial as () => unknown)() : initial
    return [value, () => {}]
  },
  useRef(initial: unknown) { return { current: initial } },
  useEffect() {}
}

try {
  const markup = renderToStaticMarkup(SettingsPanel({
    agents: [],
    onRedetect: () => {},
    onInitialize: () => {},
    onAgentsChanged: () => {},
    onOpenSync: () => {},
    onBack: () => {}
  }))
  assert.match(markup, /aria-label="桌面通知"/)
  assert.ok(markup.includes(`离开 ${APP_NAME} 时通知`))
  assert.match(markup, /始终通知/)
  assert.match(markup, /关闭通知/)
} finally {
  dispatcher.current = previous
}
