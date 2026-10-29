import assert from 'node:assert/strict'
import { STARTUP_ENTRANCE_MS, STARTUP_FLIGHT_MS, STARTUP_ROUTES, sampleStartupMotion, startupGeometry } from '../src/renderer/startupMotion'
import { embedStartupIcons } from '../src/renderer/startupMarkup'

assert.deepEqual(STARTUP_ROUTES.map(route => route.id), ['codex', 'claude', 'kimi', 'deepseek', 'grok', 'minimax', 'zcode'])
const peakScales = [2.1764705882, 2, 2.5, 2.0845070423, 2.3125, 2.2089552239, 2.3870967742]
for (const [index, route] of STARTUP_ROUTES.entries()) {
  const rotation = [-19, 32][route.track] * Math.PI / 180
  for (const clock of [0, 500, 3000, 60000]) {
    const point = sampleStartupMotion(route, clock)
    const x = point.screenX * Math.cos(rotation) + point.screenY * Math.sin(rotation)
    const y = -point.screenX * Math.sin(rotation) + point.screenY * Math.cos(rotation)
    assert.ok(Math.abs(x * x / [207.68, 174.64][route.track] ** 2 + y * y / [82.6, 81.42][route.track] ** 2 - 1) < 1e-10, `${route.id}: loading follows the 18% larger ellipse`)
  }
  const a = sampleStartupMotion(route, 0), b = sampleStartupMotion(route, 2000)
  assert.ok(Math.hypot(a.screenX - b.screenX, a.screenY - b.screenY) > 45)
  for (const entranceStart of [0, 200, 3600, 15000]) {
    const start = entranceStart + route.stagger
    const peak = start + (STARTUP_FLIGHT_MS - route.stagger) * .45
    const closest = sampleStartupMotion(route, peak, entranceStart)
    assert.ok(Math.abs(closest.scale - peakScales[index]) < 1e-8, `${route.id}: peak size matches the approved path depth`)
    assert.ok(Math.abs(closest.scale - 740 / (740 - closest.depth)) < 1e-10, `${route.id}: perspective controls size`)
    for (const at of [start, peak, entranceStart + STARTUP_FLIGHT_MS]) {
      const before = sampleStartupMotion(route, at - .001, entranceStart)
      const after = sampleStartupMotion(route, at + .001, entranceStart)
      assert.ok(Math.hypot(after.screenX - before.screenX, after.screenY - before.screenY) < .01, `${route.id}: readiness and flight phases must not jump`)
    }
    let lastScale = peakScales[index]
    for (let t = 0; t <= STARTUP_ENTRANCE_MS; t += 4) {
      const point = sampleStartupMotion(route, entranceStart + t, entranceStart)
      assert.ok(point.scale > 0 && point.scale <= 2.5, `${route.id}: 2.5× is a hard maximum`)
      if (entranceStart + t > peak) {
        assert.ok(point.scale <= lastScale + 1e-10, `${route.id}: retreat keeps shrinking`)
        lastScale = point.scale
      }
    }
    const end = sampleStartupMotion(route, entranceStart + STARTUP_FLIGHT_MS, entranceStart)
    assert.equal(Math.hypot(end.screenX, end.screenY), 0)
    assert.ok(end.scale < .12 && end.depth < -1400)
  }
  for (const clock of [-1, NaN, Infinity]) {
    const point = sampleStartupMotion(route, clock)
    assert.ok([point.screenX, point.screenY, point.scale].every(Number.isFinite))
  }
}

const peakPoints = STARTUP_ROUTES.map(route => sampleStartupMotion(route, 4150, 3600))
assert.equal(new Set(peakPoints.map(point => point.scale.toFixed(2))).size, 7, 'paths have distinct perspective sizes')
assert.equal(peakPoints.indexOf(peakPoints.reduce((a, b) => a.depth > b.depth ? a : b)), 2, 'Kimi travels closest to the viewer')
assert.ok(Math.max(...peakPoints.map(point => point.screenX)) - Math.min(...peakPoints.map(point => point.screenX)) > 1050, 'the burst expands beyond the prior design')
assert.equal(new Set(peakPoints.map(p => `${p.screenX < 0 ? 'left' : 'right'}-${p.screenY < 0 ? 'up' : 'down'}`)).size, 4)
assert.ok(peakPoints.filter(p => p.screenY > 180).length >= 2, 'the burst has distinct downward paths')
for (const [width, height] of [[1024, 640], [1280, 820], [1920, 1200]]) {
  const geometry = startupGeometry(width, height, width / 2, height * .49 - 60.5)
  for (const entranceStart of [0, 200, 3600, 15000]) for (const route of STARTUP_ROUTES) for (let t = 0; t <= STARTUP_FLIGHT_MS; t += 8) {
    const point = sampleStartupMotion(route, entranceStart + t, entranceStart, geometry.spread)
    const x = geometry.cx + point.screenX, y = geometry.cy + point.screenY, half = 13 * point.scale
    assert.ok(Math.min(x - half, y - half, width - x - half, height - y - half) >= 9, `${width}×${height}/${route.id}: burst stays inside the window`)
  }
  assert.ok(geometry.target * .866 > width / 2)
  assert.ok(geometry.target > Math.max(geometry.cy, height - geometry.cy) + width / 2 / Math.sqrt(3))
}
assert.equal(startupGeometry(1280, 820, 640, 341).spread, 1, 'normal-size windows retain the approved spread')
assert.match(embedStartupIcons('<img src="{{startup-icon:kimi}}">'), /^<img src="data:image\/png;base64,/)
assert.throws(() => embedStartupIcons('{{startup-icon:missing}}'), /Missing startup icon/)
console.log('startup motion: larger orbits, readiness continuity, wider all-direction burst, distinct depth-based peaks up to 2.5×, retreat, responsive bounds and embedded assets passed')
