import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { buildPublicWebsite, PUBLIC_REPO, PUBLIC_SITE } from '../scripts/public-website.mjs'
import { websiteDownload } from './regression/website-download.mjs'

const input=await readFile(new URL('../docs/share/uniagent-introduction/web-design-preview.html',import.meta.url),'utf8')
const image='data:image/png;base64,aGVsbG8='
const output=buildPublicWebsite(input,{version:'1.2.1',desktopImage:image,connectionImage:image})
const element=id=>output.html.match(new RegExp(`<[^>]+\\bid="${id}"[^>]*>`))?.[0] || ''
const attribute=(tag,name)=>tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]
assert.equal([...output.html.matchAll(/<div class="agent">/g)].length,8)
assert.equal(attribute(element('latest-download'),'href'),PUBLIC_REPO+'/releases/download/v1.2.1/UniAgent-Public-1.2.1-arm64.dmg')
assert.equal(attribute(element('latest-download'),'download'),'UniAgent-Public-1.2.1-arm64.dmg')
assert.match(output.html,/<title>UniAgent Public/)
assert.equal(element('nav-docs'), '', 'the public website omits the Feishu document button')
assert.doesNotMatch(output.html, /飞书文档/)
assert.equal(attribute(element('nav-changelog'),'href'),'#changelog')
assert.ok(output.html.includes("name='UniAgent-Public-'+manifest.version+'-arm64.dmg'"))
assert.ok(output.html.includes(PUBLIC_REPO))
assert.doesNotMatch(output.html,/UniAgent Public Public/)
assert.equal(attribute(element('latest-download'),'data-manifest'),PUBLIC_SITE+'latest.json')
assert.equal(attribute(element('workbench-image'),'src'),image)
assert.equal(attribute(element('mobile-image'),'src'),image)
assert.equal(attribute(element('modal-image'),'src'),image,'the closed image viewer must not retain an old internal screenshot')
const changelog=output.html.slice(output.html.indexOf('id="changelog"'))
for(const version of ['1.2.1','1.2.0','1.1.0','1.0.10','1.0.9','1.0.1'])assert.ok(changelog.includes(version),`keep changelog ${version}`)
const ids=[...output.html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1])
assert.equal(ids.length,new Set(ids).size,'IDs must remain unique')
assert.doesNotMatch(output.html,/再选择\s*。|TraeX|\bNika\b|Kaboo|Bonsai|Bits/)
assert.doesNotMatch(output.html,/id="(?:tab-local|panel-local)"|本地大模型|本地模型|九种 Agent|十种 Agent|第八种 Agent/)
assert.match(output.html,/<meta name="description" content="UniAgent Public 多 Agent 桌面工作台：统一八种 Agent/)
assert.equal(buildPublicWebsite(output.html,{version:'1.2.1',desktopImage:image,connectionImage:image}).html,output.html,'rebuilding the reviewed public page preserves its content and Agent count')
assert.ok(output.html.includes("connect-src 'self'"))
assert.throws(()=>buildPublicWebsite(input,{version:'1.2.1',desktopImage:'https://internal/image',connectionImage:image}),/Missing reviewed public image/)
assert.throws(()=>buildPublicWebsite(input+'https://code.byted.org/private',{version:'1.2.1',desktopImage:image,connectionImage:image}),/Private website content remains/)
const latest = websiteDownload(output.html, { ok: true, json: async () => ({ version: '2.3.4', path: 'release/v2.3.4/UniAgent-Public-2.3.4-arm64.dmg' }) })
await latest.click()
assert.equal(latest.requests[0].url, PUBLIC_SITE+'latest.json')
assert.equal(latest.requests[0].options.credentials, 'omit')
assert.equal(latest.downloads[0].url, PUBLIC_REPO+'/releases/download/v2.3.4/UniAgent-Public-2.3.4-arm64.dmg')
for (const response of [new Error('offline'), { ok: true, json: async () => ({ version: '2.3.4', path: 'release/v2.3.5/UniAgent-Public-2.3.5-arm64.dmg' }) }]) {
  const fallback = websiteDownload(output.html, response)
  await fallback.click()
  assert.equal(fallback.downloads[0].url, PUBLIC_REPO+'/releases/download/v1.2.1/UniAgent-Public-1.2.1-arm64.dmg')
}
console.log('Public website: all eight Agent cards, independent downloads, reviewed images, CSP and preserved changelog passed')
