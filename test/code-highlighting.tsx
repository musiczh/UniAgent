import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { codeLanguageFromPath, highlightedLine } from '../src/renderer/components/CodeHighlight.tsx'
import * as reviewPanel from '../src/renderer/components/ReviewPanel.tsx'

assert.deepEqual(
  ['Main.java', 'User.kt', 'config.json', 'native.cpp', 'page.vue', 'README.unknown'].map(codeLanguageFromPath),
  ['java', 'kotlin', 'json', 'cpp', 'vue', 'plaintext']
)

const kotlin = renderToStaticMarkup(createElement('code', null, highlightedLine('fun answer(): Int = 42 // value', 'kotlin')))
assert.match(kotlin, /fb-syn-keyword[^>]*>fun</)
assert.match(kotlin, /fb-syn-number[^>]*>42</)
assert.ok(kotlin.includes('fb-syn-comment'))
assert.ok(kotlin.includes('// value'))

const json = renderToStaticMarkup(createElement('code', null, highlightedLine('{"enabled": true}', 'json')))
assert.match(json, /fb-syn-string[^>]*>&quot;enabled&quot;</)
assert.match(json, /fb-syn-literal[^>]*>true</)

const plaintext = renderToStaticMarkup(createElement('code', null, highlightedLine('const value = 1', 'plaintext')))
assert.doesNotMatch(plaintext, /fb-syn-/)

const typescript = renderToStaticMarkup(createElement('code', null, highlightedLine('const data = "#fff"', 'typescript')))
assert.doesNotMatch(typescript, />data</)
assert.match(typescript, /fb-syn-string[^>]*>&quot;#fff&quot;</)
const css = renderToStaticMarkup(createElement('code', null, highlightedLine('color: #fff', 'css')))
assert.doesNotMatch(css, /fb-syn-comment/)

const grids = reviewPanel as unknown as Record<string, unknown>
assert.equal(typeof grids.DiffGrid, 'function', 'unified Review must expose its real syntax-highlighted grid')
assert.equal(typeof grids.SplitDiffGrid, 'function', 'split Review must expose its real syntax-highlighted grid')
if (typeof grids.DiffGrid === 'function' && typeof grids.SplitDiffGrid === 'function') {
  const rows = [{ t: 'add' as const, rno: 1, r: 'fun answer() = 42' }]
  for (const grid of [
    createElement(grids.DiffGrid as React.ComponentType<any>, { rows, view: 'unified', language: 'kotlin', onExpandFold: () => undefined }),
    createElement(grids.SplitDiffGrid as React.ComponentType<any>, { rows, side: 'right', language: 'kotlin', onExpandFold: () => undefined })
  ]) {
    const markup = renderToStaticMarkup(grid)
    assert.match(markup, /class="[^"]*add[^"]*"/)
    assert.match(markup, /fb-syn-keyword[^>]*>fun</)
  }
}

console.log('Code highlighting: 17/17 checks passed')
