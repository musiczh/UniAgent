export const STARTUP_FLIGHT_MS = 1200
export const STARTUP_ENTRANCE_MS = 2050

export const STARTUP_ROUTES = [
  { id: 'codex', track: 0, phase: 2.95, burstAngle: -154, swirl: 1, stagger: 0, peakDepth: 400, color: '#8fc5ff' },
  { id: 'claude', track: 1, phase: 5.30, burstAngle: -102, swirl: -1, stagger: 18, peakDepth: 370, color: '#c5a4ff' },
  { id: 'kimi', track: 0, phase: 2.95 + Math.PI / 2, burstAngle: -49, swirl: 1, stagger: 36, peakDepth: 444, color: '#a7dcf0' },
  { id: 'deepseek', track: 1, phase: 5.30 - Math.PI * 2 / 3, burstAngle: 158, swirl: -1, stagger: 12, peakDepth: 385, color: '#9c9aff' },
  { id: 'grok', track: 0, phase: 2.95 + Math.PI, burstAngle: 3, swirl: 1, stagger: 44, peakDepth: 420, color: '#d1e5ff' },
  { id: 'minimax', track: 1, phase: 5.30 - Math.PI * 4 / 3, burstAngle: 54, swirl: -1, stagger: 26, peakDepth: 405, color: '#b8a6ff' },
  { id: 'zcode', track: 0, phase: 2.95 + Math.PI * 3 / 2, burstAngle: 107, swirl: 1, stagger: 8, peakDepth: 430, color: '#92b6f5' }
] as const

export type StartupRoute = typeof STARTUP_ROUTES[number]

export function clamp(value: number): number { return Math.max(0, Math.min(1, value)) }
export function smooth(value: number): number {
  const p = clamp(value)
  return p * p * p * (p * (p * 6 - 15) + 10)
}

export function sampleStartupMotion(route: StartupRoute, clock: number, entranceStart?: number, spread = 1) {
  const now = Number.isFinite(clock) ? Math.max(0, clock) : 0
  const start = entranceStart === undefined ? Infinity : entranceStart + route.stagger
  const u = clamp((now - start) / (STARTUP_FLIGHT_MS - route.stagger))
  const approach = smooth(u / .45), retreat = smooth((u - .45) / .55)
  const peakPerspective = 740 / (740 - route.peakDepth)
  const perspective = u < .45 ? 1 + (peakPerspective - 1) * approach : peakPerspective - (peakPerspective - .34) * retreat
  const angle = route.phase + [1, -1][route.track] * Math.PI * 2 * now / [10800, 13600][route.track]
  const rotation = [-19, 32][route.track] * Math.PI / 180
  const ox = [207.68, 174.64][route.track] * Math.cos(angle), oy = [82.6, 81.42][route.track] * Math.sin(angle)
  const orbitX = ox * Math.cos(rotation) - oy * Math.sin(rotation)
  const orbitY = ox * Math.sin(rotation) + oy * Math.cos(rotation)
  const burstAngle = route.burstAngle * Math.PI / 180 + route.swirl * (u - .45) * .9
  const burstX = Math.cos(burstAngle) * 255 * spread
  const burstY = Math.sin(burstAngle) * (160 + Math.sin(burstAngle) * 18) * spread
  const x = u < .45 ? orbitX * (1 - approach) + burstX * approach : burstX * (1 - retreat)
  const y = u < .45 ? orbitY * (1 - approach) + burstY * approach : burstY * (1 - retreat)
  const idleScale = 1 + Math.sin(angle) * .045 * (1 - approach)
  return {
    screenX: x * perspective, screenY: y * perspective,
    scale: Math.min(2.5, idleScale * perspective * (1 - smooth((u - .72) / .28) * .7)),
    depth: 740 - 740 / perspective, front: Math.sin(angle) > 0
  }
}

export function startupGeometry(width: number, height: number, cx: number, cy: number) {
  const dx = Math.max(cx, width - cx), dy = Math.max(cy, height - cy)
  return {
    width, height, cx, cy,
    spread: Math.max(.1, Math.min(1, (Math.min(cx, width - cx) - 36) / 600, (cy - 36) / 300, (height - cy - 36) / 410)),
    target: Math.max(dx / .866, dy + dx / Math.sqrt(3)) * 1.025
  }
}
