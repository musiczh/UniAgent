import assert from 'node:assert/strict'
import test from 'node:test'
import React, { type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppUpdateState } from '../src/shared/types'
import { AppUpdateRequestController, SettingsPanel } from '../src/renderer/components/SettingsPanel'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function update(latestVersion: string): AppUpdateState {
  return {
    currentVersion: '1.0.0',
    latestVersion,
    hasUpdate: true,
    releaseUrl: 'https://code.byted.org/zhenghuan.zheng/UniAgent',
    checkedAt: Date.now()
  }
}

test('the latest app-update check exclusively owns result and busy settlement', async () => {
  const controller = new AppUpdateRequestController()
  const automatic = deferred<AppUpdateState>()
  const manual = deferred<AppUpdateState>()
  let result: AppUpdateState | null = null
  let busy = true

  const automaticRun = controller.run(() => automatic.promise, (value) => { result = value })
  const manualRun = controller.run(
    () => manual.promise,
    (value) => { result = value },
    () => { busy = false }
  )

  automatic.resolve(update('1.1.0'))
  await automaticRun
  assert.equal(result, null, 'the startup response must not overwrite a newer manual check')
  assert.equal(busy, true, 'an obsolete request must not settle the active busy state')

  manual.resolve(update('1.2.0'))
  await manualRun
  assert.equal(result?.latestVersion, '1.2.0')
  assert.equal(busy, false)

  const afterUnmount = deferred<AppUpdateState>()
  let committedAfterUnmount = false
  const unmountedRun = controller.run(
    () => afterUnmount.promise,
    () => { committedAfterUnmount = true },
    () => { committedAfterUnmount = true }
  )
  controller.invalidate()
  afterUnmount.resolve(update('2.0.0'))
  await unmountedRun
  assert.equal(committedAfterUnmount, false)
})

test('the active app-update check reports transport rejection and settles busy state', async () => {
  const controller = new AppUpdateRequestController()
  let committed = false
  let rejected = false
  let settled = false

  await controller.run(
    async () => { throw new Error('IPC transport failed') },
    () => { committed = true },
    () => { settled = true },
    () => { rejected = true }
  )

  assert.equal(committed, false)
  assert.equal(rejected, true)
  assert.equal(settled, true)
})

function renderSettingsWithUpdate(appUpdate: AppUpdateState): ReactElement {
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
      const value = index === 0
        ? 'general'
        : index === 1 ? 'update'
        // SettingsPanel's current top-level state order injects appUpdate at slot 15.
        : index === 15
          ? appUpdate
          : typeof initial === 'function' ? (initial as () => unknown)() : initial
      return [value, () => {}]
    },
    useRef(initial: unknown) { return { current: initial } },
    useEffect() {}
  }
  try {
    return SettingsPanel({
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

function nodeText(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (React.isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children)
  return typeof node === 'string' || typeof node === 'number' ? String(node) : ''
}

function findButtons(node: ReactNode, label: string, found: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findButtons(child, label, found)
  } else if (React.isValidElement(node)) {
    if (node.type === 'button' && nodeText(node) === label) found.push(node)
    findButtons((node.props as { children?: ReactNode }).children, label, found)
  }
  return found
}

test('app-update fallback states expose actionable Bits guidance', () => {
  const releaseUrl = APP_REPOSITORY
  const cases: Array<{ error: NonNullable<AppUpdateState['error']>; hasUpdate: boolean; message: string }> = [
    { error: 'auth_required', hasUpdate: false, message: INTERNAL_DISTRIBUTION ? '无法访问 Bits，请先在终端完成 Bits Git 登录后重试。' : '无法读取公开版本，请稍后重试。' },
    { error: 'git_unavailable', hasUpdate: false, message: INTERNAL_DISTRIBUTION ? '未找到 Git，无法检查 Bits 更新。' : '无法读取公开版本，请稍后重试。' },
    { error: 'network', hasUpdate: false, message: INTERNAL_DISTRIBUTION ? '无法连接 Bits，请检查网络或代理后重试。' : '无法连接 GitHub 更新源，请检查网络或代理后重试。' },
    { error: 'invalid_manifest', hasUpdate: false, message: INTERNAL_DISTRIBUTION ? 'Bits 中的更新清单格式无效，请联系维护者。' : '公开更新清单格式无效，请联系维护者。' },
    { error: 'no_asset', hasUpdate: false, message: '最新版本缺少 arm64 DMG，请联系维护者。' },
    { error: 'no_release', hasUpdate: false, message: INTERNAL_DISTRIBUTION ? '当前 Bits 仓库尚未发布可下载版本' : '当前尚未发布可下载的公开版本' }
  ]

  for (const scenario of cases) {
    const tree = renderSettingsWithUpdate({
      currentVersion: '1.0.0',
      latestVersion: scenario.hasUpdate ? '1.1.0' : undefined,
      hasUpdate: scenario.hasUpdate,
      releaseUrl,
      checkedAt: 1,
      error: scenario.error
    })
    assert.ok(renderToStaticMarkup(tree).includes(scenario.message), `${scenario.error} must show its mapped guidance`)

    const actions = findButtons(tree, INTERNAL_DISTRIBUTION ? '打开 Bits 仓库' : '打开 GitHub 发布页')
    const actionable = scenario.error !== 'no_release'
    assert.equal(actions.length, Number(actionable), `${scenario.error} Bits action visibility`)
    if (!actionable) continue

    let opened = ''
    const target = globalThis as unknown as { window?: unknown }
    const previousWindow = target.window
    target.window = { uniagent: { openExternal: (url: string) => { opened = url } } }
    try {
      ;(actions[0].props as { onClick: () => void }).onClick()
    } finally {
      target.window = previousWindow
    }
    assert.equal(opened, releaseUrl, `${scenario.error} must open its Bits URL`)
  }
})

test('available Bits update downloads the exact trusted DMG URL', () => {
  const downloadUrl = 'https://code.byted.org/zhenghuan.zheng/UniAgent/raw/master/release/v1.2.0/UniAgent-1.2.0-arm64.dmg'
  const tree = renderSettingsWithUpdate({
    currentVersion: '1.0.0',
    latestVersion: '1.2.0',
    hasUpdate: true,
    downloadUrl,
    releaseUrl: 'https://code.byted.org/zhenghuan.zheng/UniAgent',
    checkedAt: 1
  })
  const markup = renderToStaticMarkup(tree)
  assert.ok(markup.includes(INTERNAL_DISTRIBUTION ? '从 Bits 下载最新 arm64 DMG' : '替换 Applications 中的 UniAgent Public.app'))
  if (!INTERNAL_DISTRIBUTION) assert.ok(!markup.includes('Bits'), 'public update instructions use the public channel')
  const actions = findButtons(tree, '下载 DMG')
  assert.equal(actions.length, 1)
  let opened = ''
  const target = globalThis as unknown as { window?: unknown }
  const previousWindow = target.window
  target.window = {
    uniagent: { openExternal: (url: string) => { opened = url } }
  }
  try {
    ;(actions[0].props as { onClick: () => void }).onClick()
  } finally {
    target.window = previousWindow
  }
  assert.equal(opened, downloadUrl)
})
import { INTERNAL_DISTRIBUTION, APP_REPOSITORY } from '../src/shared/distribution'
