import { runInNewContext } from 'node:vm'

export function websiteDownload(html, fetchResponse) {
  const anchor = html.match(/<a id="latest-download"[\s\S]*?<\/a>/)?.[0]
  if (!anchor) throw new Error('Missing website download button')
  const attribute = name => anchor.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1].replaceAll('&amp;', '&')
  const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(value => value.includes("const download=document.getElementById('latest-download')"))
  const start = script.indexOf('const bitsFileUrl=') >= 0
    ? script.indexOf('const bitsFileUrl=') : script.indexOf('const download=')
  const end = script.indexOf('const motionAllowed=', start)
  if (end < 0) throw new Error('Missing end of website download handler')
  const requests = [], downloads = [], listeners = {}, label = { textContent: '下载最新版' }
  const button = {
    href: attribute('href'), download: attribute('download'), dataset: { manifest: attribute('data-manifest') },
    addEventListener(type, listener) { listeners[type] = listener },
    querySelector() { return label }
  }
  runInNewContext(script.slice(start, end), {
    document: {
      getElementById() { return button }, body: { appendChild() {} },
      createElement() { return { click() { downloads.push({ url: this.href, name: this.download }) }, remove() {} } }
    },
    async fetch(url, options) {
      requests.push({ url, options })
      if (fetchResponse instanceof Error) throw fetchResponse
      return fetchResponse
    }
  })
  return {
    button, label, requests, downloads,
    async click() {
      let prevented = false
      await listeners.click({ preventDefault() { prevented = true } })
      if (!prevented) throw new Error('Download handler did not handle the click')
    }
  }
}
