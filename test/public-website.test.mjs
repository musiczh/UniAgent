import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { buildPublicWebsite, PUBLIC_REPO, PUBLIC_SITE } from '../scripts/public-website.mjs'

const input=await readFile(new URL('../docs/share/uniagent-introduction/web-design-preview.html',import.meta.url),'utf8')
const image='data:image/png;base64,aGVsbG8='
const output=buildPublicWebsite(input,{version:'1.1.0',desktopImage:image,connectionImage:image})
const element=id=>output.html.match(new RegExp(`<[^>]+\\bid="${id}"[^>]*>`))?.[0] || ''
const attribute=(tag,name)=>tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]
assert.equal([...output.html.matchAll(/<div class="agent">/g)].length,7)
assert.equal(attribute(element('latest-download'),'href'),PUBLIC_REPO+'/releases/download/v1.1.0/UniAgent-Public-1.1.0-arm64.dmg')
assert.equal(attribute(element('latest-download'),'download'),'UniAgent-Public-1.1.0-arm64.dmg')
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
for(const version of ['1.1.0','1.0.10','1.0.9','1.0.1'])assert.ok(changelog.includes(version),`keep changelog ${version}`)
const ids=[...output.html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1])
assert.equal(ids.length,new Set(ids).size,'IDs must remain unique')
assert.doesNotMatch(output.html,/再选择\s*。|TraeX|\bNika\b|Kaboo|Bonsai|Bits/)
assert.doesNotMatch(output.html,/id="(?:tab-local|panel-local)"|本地大模型|本地模型|八种 Agent|九种 Agent|第八种 Agent/)
assert.match(output.html,/<meta name="description" content="UniAgent Public 多 Agent 桌面工作台：统一七种 Agent/)
assert.ok(output.html.includes("connect-src 'self'"))
assert.throws(()=>buildPublicWebsite(input,{version:'1.1.0',desktopImage:'https://internal/image',connectionImage:image}),/Missing reviewed public image/)
assert.throws(()=>buildPublicWebsite(input+'https://code.byted.org/private',{version:'1.1.0',desktopImage:image,connectionImage:image}),/Private website content remains/)
console.log('Public website: all seven Agent cards, independent downloads, reviewed images, CSP and preserved changelog passed')
