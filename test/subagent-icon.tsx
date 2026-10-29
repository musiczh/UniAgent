import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SubAgentIcon } from '../src/renderer/components/SubAgentIcon'

const plate = renderToStaticMarkup(<SubAgentIcon threadId="reviewer-session" size={18} />)
assert.match(plate, /class="sa-ic"/, 'the default mark still uses the shared avatar plate')
assert.match(plate, /style="width:18px;height:18px;background:rgba\(/, 'the default mark keeps its tinted rounded-square background')

const plain = renderToStaticMarkup(<SubAgentIcon threadId="reviewer-session" size={24} plain />)
assert.match(plain, /class="sa-ic sa-ic-plain"/, 'plain marks are distinguishable for the transparent presentation')
assert.match(plain, /style="width:24px;height:24px"/, 'plain marks keep the requested size without an inline background')
assert.ok(!plain.includes('background'), 'plain marks render the vector glyph directly on the card background')
assert.ok(plain.includes('<svg'), 'plain marks still render the inline SVG glyph')

console.log('PASS sub-agent icon plate / transparent rendering')
