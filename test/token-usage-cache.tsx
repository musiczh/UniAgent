import { INTERNAL_DISTRIBUTION } from '../src/shared/distribution'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import React, { type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TokenUsagePanel } from '../src/renderer/components/TokenUsagePanel'
import type { KabooProfileResult, KabooUsageQuery } from '../src/shared/types'

const phase = process.argv[2]
if (!phase) {
  const directory = mkdtempSync(join(tmpdir(), 'ua-token-cache-'))
  try {
    for (const step of ['cold', 'auto-source', 'restart', 'updated', 'corrupt', 'storage-error']) {
      const result = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), step, directory])
      process.stdout.write(result.stdout)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
} else {
  const path = join(process.argv[3], 'local-storage.json')
  let stored: Record<string, string> = phase === 'cold' ? {} : JSON.parse(readFileSync(path, 'utf8'))
  stored['uniagent.tokenUsage.source'] = 'native'
  if (phase === 'auto-source') delete stored['uniagent.tokenUsage.source']
  if (phase === 'corrupt') {
    for (const key of Object.keys(stored)) if (key !== 'uniagent.tokenUsage.source') stored[key] = '{broken'
  }
  const storage = {
    get length() { return Object.keys(stored).length },
    key: (index: number) => Object.keys(stored)[index] ?? null,
    getItem: (key: string) => {
      if (phase === 'storage-error' && key !== 'uniagent.tokenUsage.source') throw new Error('storage unavailable')
      return stored[key] ?? null
    },
    setItem: (key: string, value: string) => {
      if (phase === 'storage-error') throw new Error('quota exceeded')
      stored[key] = value
      writeFileSync(path, JSON.stringify(stored))
    },
    removeItem: (key: string) => { delete stored[key] },
    clear: () => { stored = {} }
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })

  let resolve!: (value: KabooProfileResult) => void
  let reject!: (error: Error) => void
  let query!: KabooUsageQuery
  let requests = 0
  let kabooRefreshes = 0
  let failNativeRefresh = false
  const read = (value: KabooUsageQuery) => {
    query = value
    requests++
    return new Promise<KabooProfileResult>((yes, no) => { resolve = yes; reject = no })
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { uniagent: {
    getNativeTokenUsage: read,
    getTokenUsage: read,
    refreshNativeTokenUsage: async () => { if (failNativeRefresh) throw new Error('scan unavailable') },
    refreshTokenUsage: async () => { kabooRefreshes++ },
    logTokenUsage: async () => {}
  } } })
  const dispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
  const previous = dispatcher.current
  const slots: any[] = []
  let cursor = 0
  let effects: (() => void)[] = []
  dispatcher.current = {
    useState(initial: any) {
      const id = cursor++
      if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial
      return [slots[id], (next: any) => { slots[id] = typeof next === 'function' ? next(slots[id]) : next }]
    },
    useRef(current: any) { const id = cursor++; return slots[id] ||= { current } },
    useCallback(callback: any, deps: any[]) {
      const id = cursor++, prior = slots[id]
      if (!prior || deps.some((value, index) => !Object.is(value, prior.deps[index]))) slots[id] = { deps, callback }
      return slots[id].callback
    },
    useEffect(effect: () => unknown, deps: unknown[]) {
      const id = cursor++, prior = slots[id]
      if (!prior || deps.some((value, index) => !Object.is(value, prior.deps[index]))) {
        prior?.cleanup?.()
        slots[id] = { deps }
        effects.push(() => { slots[id].cleanup = effect() })
      }
    }
  }
  function render() {
    cursor = 0
    const tree = TokenUsagePanel({})
    const pending = effects
    effects = []
    pending.forEach(effect => effect())
    return tree
  }
  function elements(node: ReactNode): ReactElement<any>[] {
    return React.Children.toArray(node).flatMap(child => React.isValidElement<any>(child)
      ? [child, ...elements(child.props.children)] : [])
  }
  const stats = (tree: ReactNode) => elements(tree).find(node => node.props.stats)?.props.stats
  const checkRefresh = (busy: boolean) => {
    const button = elements(render()).find(node => node.props['aria-label'] === '刷新 Token 用量')!
    assert.equal(button.props['aria-busy'], busy, '刷新状态必须跟随实际请求，不受缓存命中影响')
    assert.equal(button.props.disabled, busy, '刷新期间禁止重复点击，结束后恢复可用')
    assert.match(renderToStaticMarkup(button), busy ? />刷新中</ : />刷新</)
    assert.equal(elements(button).some(node => node.props.className === 'loading-spinner'), busy,
      '刷新期间必须同时显示旋转图标和刷新中文字')
  }
  const click = (label: string) => {
    const button = elements(render()).find(node => node.type === 'button' &&
      (node.props['aria-label'] === label || node.props.children === label))
    assert.ok(button, `expected button: ${label}`)
    button.props.onClick()
  }
  const unmount = () => { for (const slot of slots) slot?.cleanup?.(); slots.length = 0 }
  const flush = () => new Promise<void>(done => setImmediate(done))
  const result = (tokens: number): KabooProfileResult => ({
    range: query.period,
    reportedAt: new Date().toISOString(),
    stats: { tokens, cost: 0, sessions: 1, hours: 0, codeLines: 0,
      inputTokens: tokens, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 },
    heatmap: [], dailyTrend: [], toolBreakdown: [], modelBreakdown: [],
    skillBreakdown: [], projectBreakdown: [], mcpBreakdown: []
  })
  try {
    const first = render()
    assert.equal(requests, 1, '每次进入页面均应后台刷新')
    if (stats(first)) checkRefresh(true)
    if (phase === 'restart') {
      assert.equal(stats(first)?.tokens, 42, '新进程首帧必须直接展示磁盘缓存，不能等待扫描')
      assert.doesNotMatch(renderToStaticMarkup(first), /正在扫描/)
      const initialStats = stats(first)
      resolve({ ...result(42), reportedAt: '2099-01-01T00:00:00.000Z' })
      await flush()
      assert.strictEqual(stats(render()), initialStats, '仅查询时间或上报时间变化不应替换 UI 数据')
      checkRefresh(false)

      unmount()
      assert.equal(stats(render())?.tokens, 42)
      assert.equal(requests, 2, '内存缓存命中也必须后台刷新')
      checkRefresh(true)
      resolve(result(84))
      await flush()
      assert.equal(stats(render())?.tokens, 84, '新数据应更新 UI')
      assert.match(readFileSync(path, 'utf8'), /84/, '新数据必须写入磁盘缓存')
      checkRefresh(false)

      unmount()
      const beforeFailure = stats(render())
      checkRefresh(true)
      reject(new Error('offline'))
      await flush()
      assert.strictEqual(stats(render()), beforeFailure, '后台刷新异常必须保留缓存')
      assert.doesNotMatch(renderToStaticMarkup(render()), /role="alert"/)
      checkRefresh(false)

      unmount()
      render()
      resolve({ unavailable: true, reason: 'service' })
      await flush()
      assert.equal(stats(render())?.tokens, 84, '数据源暂时不可用不能覆盖有效缓存')
      checkRefresh(false)

      const tree = render()
      const refresh = elements(tree).find(node => node.props['aria-label'] === '刷新 Token 用量')!
      refresh.props.onClick()
      checkRefresh(true)
      await flush()
      assert.equal(stats(render())?.tokens, 84, '手动刷新期间也应保留数据')
      resolve(result(0))
      await flush()
      assert.equal(stats(render())?.tokens, 0, '有效零用量也应替换旧缓存')
      checkRefresh(false)

      failNativeRefresh = true
      click('刷新 Token 用量')
      checkRefresh(true)
      await flush()
      checkRefresh(false)
      assert.equal(stats(render())?.tokens, 0, '清除缓存阶段失败也必须恢复按钮并保留数据')
      failNativeRefresh = false

      if (INTERNAL_DISTRIBUTION) {
      click('Kaboo')
      render()
      await flush()
      assert.equal(stats(render()), undefined, '不同来源不能使用同一份缓存')
      const lateResolve = resolve
      const kabooResult = result(777)
      click('UniAgent 原生')
      render()
      await flush()
      assert.equal(stats(render())?.tokens, 0, '切回原生时立即恢复对应缓存')
      checkRefresh(true)
      lateResolve(kabooResult)
      await flush()
      assert.equal(stats(render())?.tokens, 0, '旧来源的延迟响应不能覆盖当前页面')
      checkRefresh(true)
      resolve(result(0))
      await flush()
      checkRefresh(false)

      click('Kaboo')
      render()
      await flush()
      resolve(result(777))
      await flush()
      click('UniAgent 原生')
      render()
      await flush()
      resolve(result(0))
      await flush()
      click('Kaboo')
      render()
      await flush()
      assert.equal(stats(render())?.tokens, 777)
      assert.equal(kabooRefreshes, 1, 'Kaboo 命中页面缓存后也必须发起后台刷新')
      checkRefresh(true)
      resolve(result(777))
      await flush()
      checkRefresh(false)
      click('UniAgent 原生')
      render()
      await flush()
      resolve(result(0))
      await flush()

      } else {
        assert.doesNotMatch(renderToStaticMarkup(render()), /Kaboo|Token 用量数据来源/, 'public usage has only the native source')
        assert.equal(kabooRefreshes, 0)
      }

      click('上一个周期')
      render()
      await flush()
      assert.equal(stats(render()), undefined, '不同日期不能使用同一份缓存')
      resolve(result(12))
      await flush()
      assert.equal(stats(render())?.tokens, 12)
      click('下一个周期')
      render()
      await flush()
      assert.equal(stats(render())?.tokens, 0, '切回日期后应立即恢复该日期的缓存')
      resolve(result(0))
      await flush()
    } else if (phase === 'updated' || phase === 'auto-source') {
      const expected = phase === 'updated' ? 0 : 42
      assert.equal(stats(first)?.tokens, expected, '重启后即使未手动选择来源，也必须直接显示已有缓存')
      reject(new Error('offline'))
      await flush()
      assert.equal(stats(render())?.tokens, expected)
      checkRefresh(false)
    } else {
      assert.equal(stats(first), undefined, '无缓存、损坏缓存或存储不可用时正常加载')
      resolve(result(42))
      await flush()
      assert.equal(stats(render())?.tokens, 42)
      checkRefresh(false)
      if (phase !== 'storage-error') {
        assert.ok(existsSync(path), '首次读取成功后必须创建磁盘缓存')
        assert.match(readFileSync(path, 'utf8'), /42/, '首次读取或损坏缓存恢复后必须持久化')
      }
    }
    console.log(`token usage cache ${phase}: ok`)
  } finally {
    unmount()
    dispatcher.current = previous
  }
}
