import assert from 'node:assert/strict'
import test from 'node:test'
import { installExternalNavigation, isTrustedExternalUrl } from '../src/main/externalNavigation'

type OpenHandler = (details: { url: string }) => { action: 'deny' }
type NavigateHandler = (event: { preventDefault(): void }, url: string) => void

function harness(): {
  opened: string[]
  windowOpen: OpenHandler
  navigate: NavigateHandler
} {
  let windowOpen: OpenHandler | undefined
  let navigate: NavigateHandler | undefined
  const opened: string[] = []
  const webContents = {
    setWindowOpenHandler(handler: OpenHandler) { windowOpen = handler },
    on(_event: 'will-navigate', handler: NavigateHandler) { navigate = handler }
  }
  installExternalNavigation(webContents, (url) => { opened.push(url) })
  assert.ok(windowOpen, 'window-open handler was installed')
  assert.ok(navigate, 'will-navigate handler was installed')
  return { opened, windowOpen, navigate }
}

test('window.open and target=_blank are denied in-app and opened externally', () => {
  const h = harness()
  assert.deepEqual(h.windowOpen({ url: 'https://example.com/docs?q=1' }), { action: 'deny' })
  assert.deepEqual(h.opened, ['https://example.com/docs?q=1'])
})

test('same-window anchor navigation is prevented and opened externally', () => {
  const h = harness()
  let prevented = false
  h.navigate({ preventDefault: () => { prevented = true } }, 'http://example.com/readme')
  assert.equal(prevented, true)
  assert.deepEqual(h.opened, ['http://example.com/readme'])
})

test('untrusted and malformed protocols are denied without invoking the OS', () => {
  const h = harness()
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'not a url']) {
    assert.deepEqual(h.windowOpen({ url }), { action: 'deny' })
    let prevented = false
    h.navigate({ preventDefault: () => { prevented = true } }, url)
    assert.equal(prevented, true)
  }
  assert.deepEqual(h.opened, [])
})

test('trusted external URL validation is exact and case-insensitive', () => {
  assert.equal(isTrustedExternalUrl('https://example.com'), true)
  assert.equal(isTrustedExternalUrl('HTTP://example.com'), true)
  assert.equal(isTrustedExternalUrl('httpsx://example.com'), false)
  assert.equal(isTrustedExternalUrl('mailto:user@example.com'), false)
})
