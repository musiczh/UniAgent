import assert from 'node:assert/strict'
import type { UAEvent } from '../src/shared/types'
import { viewImagePath } from '../src/shared/viewImage'
import { renderEventStream } from './regression/render-event-stream.mjs'

const event = (seq: number, name: string, path: unknown, state: UAEvent['state'] = 'success'): UAEvent => ({
  sessionId: 'view-session', seq, ts: 1_000 + seq, type: 'tool_call', state,
  payload: { id: `view-${seq}`, name, input: { path } }
})
const first = event(1, 'view_image', '/repo/first.png')
const second = event(2, 'view_image', '/repo/second.png')
assert.equal(viewImagePath(first), '/repo/first.png')
assert.equal(viewImagePath(event(3, 'viewImage', '/repo/alias.png')), '/repo/alias.png')
for (const path of ['', '   ', null, 123, '/repo/bad\0.png']) {
  assert.equal(viewImagePath(event(3, 'view_image', path)), undefined)
}
assert.equal(viewImagePath(event(3, 'read_file', '/repo/first.png')), undefined)
assert.equal(viewImagePath({ ...first, type: 'command_exec' }), undefined)

// Exercise the real React components in the existing offline Electron DOM fixture.
const result = await renderEventStream([
  { sessionId: 'view-session', seq: 0, ts: 1_000, type: 'user_message', payload: { text: '查看图片' } },
  first, second,
  event(3, 'read_file', '/repo/plain.txt'),
  event(4, 'view_image', '/repo/missing.png'),
  event(5, 'view_image', '/repo/running.png', 'running'),
  event(6, 'view_image', '/repo/failed.png', 'failed'),
  event(7, 'view_image', '/repo/error.png'),
  event(8, 'view_image', '/repo/corrupt.png'),
  event(9, 'view_image', '/repo/cancelled.png', 'cancelled'),
], 'running', 'view-session', {
  setup: `
    window.imageReads = [];
    window.uniagent = {
      fsReadAttachmentImage: async (sessionId, path) => {
        window.imageReads.push({ sessionId, path });
        if (path.endsWith('missing.png')) return null;
        if (path.endsWith('error.png')) throw new Error('unreadable');
        if (path.endsWith('corrupt.png')) return 'data:image/png;base64,invalid';
        if (path.endsWith('slow.png')) return new Promise(resolve => { window.resolveSlowImage = resolve; });
        return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6f7sAAAAASUVORK5CYII=';
      }
    };
    window.mountImageFixture = (events, sessionId) => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      const render = (events, sessionId) => root.render(React.createElement(EventStream, {events, sessionId, status: 'running'}));
      render(events, sessionId);
      return {host, render, unmount: () => root.unmount()};
    };
  `,
  inspect: `(async () => {
    const check = (value, message) => { if (!value) throw new Error(message); };
    const settle = () => new Promise(resolve => setTimeout(resolve, 30));
    const row = document.querySelector('.step-call-image-row');
    const thumbs = [...row.querySelectorAll('button.tool-image-thumbnail')];
    check(thumbs.length === 2, 'each batched view_image keeps its thumbnail');
    check(!document.querySelector('button button'), 'preview and disclosure must be separate buttons');
    const rect = row.getBoundingClientRect();
    const thumbRect = thumbs[0].getBoundingClientRect();
    check(rect.height === 30 && thumbRect.width === 28 && thumbRect.height === 22, 'thumbnail must preserve the compact row height');
    check(document.elementFromPoint(thumbRect.x + thumbRect.width / 2, thumbRect.y + thumbRect.height / 2).closest('button') === thumbs[0], 'preview button must receive pointer input');
    check(document.elementFromPoint(rect.right - 10, rect.y + rect.height / 2).classList.contains('step-call-image-details'), 'remaining row area must open tool details');
    for (const [index, thumb] of thumbs.entries()) {
      thumb.click(); await settle();
      const dialog = document.querySelector('[role="dialog"]');
      check(dialog?.getAttribute('aria-label') === (index ? 'second.png' : 'first.png'), 'clicked thumbnail must open its own image');
      check(row.querySelector('.step-call-image-details').getAttribute('aria-expanded') === 'false', 'preview click must not toggle tool details');
      dialog.querySelector('.image-lightbox-toolbar button[title="放大"]').click(); await settle();
      check(dialog.querySelector('.image-lightbox-scale').textContent === '125%', 'preview reuses existing zoom controls');
      window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'})); await settle();
      check(!document.querySelector('[role="dialog"]'), 'Escape must close preview');
    }
    thumbs[0].click(); await settle();
    document.querySelector('.bubble-image-preview-close').click(); await settle();
    check(!document.querySelector('[role="dialog"]'), 'close button must close preview');
    const toggle = row.querySelector('.step-call-image-details');
    toggle.click(); await settle();
    check(toggle.getAttribute('aria-expanded') === 'true', 'tool details remain expandable');
    check(row.parentElement.querySelector('.step-call-detail').textContent.includes('/repo/first.png'), 'tool details retain original arguments');
    const ordinary = [...document.querySelectorAll('.step-call')].find(item => item.querySelector('.step-call-name')?.textContent === 'read_file');
    check(!ordinary.querySelector('.tool-image-preview'), 'ordinary tools must not get image previews');
    check(document.querySelector('[aria-label="正在加载图片：running.png"]'), 'running tools show a loading placeholder');
    for (const name of ['missing.png', 'failed.png', 'error.png', 'corrupt.png', 'cancelled.png']) {
      check(document.querySelector('[aria-label="图片不可用：' + name + '"]'), 'unavailable image must preserve its placeholder: ' + name);
    }
    const firstEvent = ${JSON.stringify(first)};
    const readsBeforeRemount = window.imageReads.length;
    const fixture = window.mountImageFixture([firstEvent], 'view-session');
    await settle();
    check(fixture.host.querySelector('button.tool-image-thumbnail'), 'remount must reuse the cached preview');
    check(window.imageReads.length === readsBeforeRemount, 'cached preview must not reread disk');
    const nextSession = {...firstEvent, sessionId: 'next-session'};
    fixture.render([nextSession], 'next-session'); await settle();
    check(window.imageReads.at(-1).sessionId === 'next-session', 'a different session must authorize and load its own image');
    const slow = {...nextSession, payload: {...nextSession.payload, input: {path: '/repo/slow.png'}}};
    fixture.render([slow], 'next-session'); await settle();
    check(fixture.host.querySelector('[aria-label="正在加载图片：slow.png"]'), 'pending read must not display the previous image');
    fixture.render([nextSession], 'next-session'); await settle();
    window.resolveSlowImage(null); await settle();
    check(fixture.host.querySelector('[aria-label="查看图片 first.png"]'), 'late completion must not overwrite the current image');
    const readsBeforeReusedId = window.imageReads.length;
    fixture.render([{...nextSession, seq: 100}], 'next-session'); await settle();
    check(window.imageReads.length === readsBeforeReusedId + 1, 'a later call reusing the same id and path must reload the image');
    fixture.unmount();
    return { reads: window.imageReads, thumbnails: thumbs.length, height: rect.height };
  })()`
})
assert.deepEqual(result.reads.filter((item: { sessionId: string }) => item.sessionId === 'view-session').map((item: { path: string }) => item.path).sort(), [
  '/repo/corrupt.png', '/repo/error.png', '/repo/first.png', '/repo/missing.png', '/repo/second.png'
])
assert.deepEqual(result.reads.filter((item: { sessionId: string }) => item.sessionId === 'next-session').map((item: { path: string }) => item.path), [
  '/repo/first.png', '/repo/slow.png', '/repo/first.png'
])
assert.equal(result.thumbnails, 2)
assert.equal(result.height, 30)
console.log('view-image-preview: ok')
