import { STARTUP_ENTRANCE_MS, STARTUP_FLIGHT_MS, STARTUP_ROUTES, clamp, sampleStartupMotion, smooth, startupGeometry } from './startupMotion'

function svg<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attributes: Record<string, string | number>) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value))
  parent.append(element)
  return element
}
function opacity(element: HTMLElement | SVGElement, value: number): void { element.style.opacity = String(value) }

export function createStartupAnimation(screen: HTMLElement, elapsed: number, preference: MediaQueryList) {
  const cluster = screen.querySelector<HTMLElement>('.cluster')!
  const core = screen.querySelector<HTMLElement>('.core')!
  const orbit = screen.querySelector<SVGSVGElement>('.orbit')!
  const spokes = orbit.querySelector<SVGPathElement>('.spokes')!
  const halo = screen.querySelector<HTMLElement>('.halo')!
  const rings = [...screen.querySelectorAll<HTMLElement>('.energy-ring,.echo-ring')]
  const dots = [...screen.querySelectorAll<HTMLElement>('.dot,.pulse')]
  const copy = [...screen.querySelectorAll<HTMLElement>('h1,.startup-subtitle,.startup-status,.startup-footer')]
  const ambient = screen.querySelector<HTMLElement>('.glow')!
  const stars = screen.querySelector<HTMLElement>('.constellation')!
  const trails = svg(cluster, 'svg', { class: 'motion-trails', viewBox: '0 0 440 275', 'aria-hidden': 'true' })
  cluster.insertBefore(trails, core)
  const glow = document.createElement('div'), flare = document.createElement('div')
  glow.className = 'fusion-glow'; flare.className = 'fusion-line'
  cluster.insertBefore(glow, trails); cluster.insertBefore(flare, trails)
  const fx = svg(cluster, 'svg', { class: 'motion-fx', viewBox: '0 0 440 275', 'aria-hidden': 'true' })
  cluster.insertBefore(fx, core)
  const waves = [0, 1].map(i => svg(fx, 'circle', { class: `wave ${i ? 'second' : ''}`, cx: 220, cy: 137.5, r: 72 }))
  const sparks = Array.from({ length: 16 }, (_, i) => svg(fx, 'circle', { class: 'spark', r: i % 3 ? .8 : 1.2 }))
  const nodes = STARTUP_ROUTES.map(route => {
    const element = screen.querySelector<HTMLElement>(`[data-agent="${route.id}"]`)!
    element.style.left = '220px'; element.style.top = '137.5px'
    const bloom = svg(trails, 'path', { class: 'trail-bloom', stroke: route.color, 'stroke-width': 5 })
    const segments = Array.from({ length: 12 }, (_, i) => svg(trails, 'path', { stroke: route.color, 'stroke-width': .35 + 1.55 * i / 11 }))
    const motes = Array.from({ length: 6 }, (_, i) => svg(trails, 'circle', { fill: route.color, r: i % 2 ? .9 : 1.25 }))
    return { route, element, bloom, segments, motes }
  })
  const portal = svg(document.body, 'svg', { class: 'startup-portal', 'aria-hidden': 'true' })
  portal.innerHTML = '<defs><linearGradient id="ua-portal-gradient"><stop stop-color="#78b8ff"/><stop offset=".48" stop-color="#c7e1ff"/><stop offset="1" stop-color="#a371f7"/></linearGradient><radialGradient id="ua-portal-charge"><stop stop-color="#e4f4ff" stop-opacity=".7"/><stop offset=".15" stop-color="#a4ceff" stop-opacity=".45"/><stop offset=".45" stop-color="#7b92ff" stop-opacity=".18"/><stop offset="1" stop-color="#7b92ff" stop-opacity="0"/></radialGradient></defs>'
  const edges = ['portal-soft', 'portal-main', 'portal-inner'].map(name => svg(portal, 'path', { class: name }))
  const chargeLight = svg(portal, 'circle', { class: 'portal-charge' })
  portal.style.display = 'none'
  const origin = performance.now() - elapsed
  const clock = (): number => Math.max(0, performance.now() - origin)
  let frame = 0, active = true
  let entrance: { start: number; done: () => void; workspace: HTMLElement; timer: ReturnType<typeof setTimeout> } | undefined
  let geometry: ReturnType<typeof startupGeometry>

  function measure(): void {
    const box = cluster.getBoundingClientRect()
    geometry = startupGeometry(innerWidth, innerHeight, box.left + box.width / 2, box.top + box.height / 2)
    portal.setAttribute('viewBox', `0 0 ${innerWidth} ${innerHeight}`)
  }
  function pathAt(route: typeof STARTUP_ROUTES[number], from: number, to: number, steps = 4): string {
    const path: string[] = []
    for (let i = 0; i <= steps; i++) {
      const point = sampleStartupMotion(route, from + (to - from) * i / steps, entrance?.start, geometry.spread)
      path.push(`${i ? 'L' : 'M'}${(220 + point.screenX).toFixed(2)},${(137.5 + point.screenY).toFixed(2)}`)
    }
    return path.join(' ')
  }
  function draw(now: number): void {
    const t = entrance ? now - entrance.start : -Infinity
    const scatter = smooth(t / 650), gather = smooth((t - 550) / 650)
    const collected = smooth((t - 1080) / 120)
    const reveal = 1 - Math.pow(1 - smooth((t - STARTUP_FLIGHT_MS) / 850), 2)
    const tailAlpha = (.16 * smooth(now / 240) + .84 * smooth(t / 180)) * (1 - smooth((t - 1190) / 190))
    const charge = smooth((t - 620) / 520), fusion = charge * (1 - smooth((t - 1190) / 540))
    const motions = nodes.map(node => sampleStartupMotion(node.route, now, entrance?.start, geometry.spread))
    nodes.forEach((node, index) => {
      const point = motions[index]
      node.element.style.transform = `translate3d(${point.screenX}px, ${point.screenY}px, 0) scale(${point.scale})`
      opacity(node.element, (1 - collected) * (!entrance ? point.front ? 1 : .8 : 1 - Math.max(0, -point.depth) / 1450 * .22))
      node.element.style.zIndex = !entrance && !point.front ? '2' : '4'
      const before = sampleStartupMotion(node.route, now - 16, entrance?.start, geometry.spread)
      const length = 175 + Math.min(105, Math.hypot(point.screenX - before.screenX, point.screenY - before.screenY) * 11)
      node.bloom.setAttribute('d', pathAt(node.route, now - length, now, 18))
      opacity(node.bloom, tailAlpha * .34)
      node.segments.forEach((segment, i) => {
        segment.setAttribute('d', pathAt(node.route, now - length * (1 - i / 12), now - length * (1 - (i + 1) / 12)))
        opacity(segment, tailAlpha * Math.pow((i + 1) / 12, 1.4) * .9)
      })
      node.motes.forEach((mote, i) => {
        const p = sampleStartupMotion(node.route, now - 24 - i * 36, entrance?.start, geometry.spread)
        mote.setAttribute('cx', String(220 + p.screenX)); mote.setAttribute('cy', String(137.5 + p.screenY))
        opacity(mote, tailAlpha * .68 * (1 - i / 7))
      })
    })
    spokes.setAttribute('d', motions.map(p => `M${220 + p.screenX} ${137.5 + p.screenY}L${220 + p.screenX * .35} ${137.5 + p.screenY * .35}`).join(' '))
    opacity(spokes, .17 * (1 - smooth(t / 140)))
    orbit.style.transformOrigin = 'center'
    orbit.style.transform = `scale(${1 + scatter * .45 - gather * .75}) rotate(${scatter * 9 + gather * 16}deg)`
    opacity(orbit, 1 - smooth((t - 700) / 520))
    rings.forEach((ring, i) => {
      opacity(ring, (1 - collected) * (i ? .2 : .8))
      ring.style.transform = `rotate(${now / (i ? 35 : 18)}deg) scale(${1 + scatter * .13 - gather * .34})`
    })
    dots.forEach(dot => opacity(dot, (1 - collected) * .7))
    halo.style.transform = `translate(-50%, -50%) scale(${1 + scatter * .32 - gather * .64})`
    opacity(halo, 1 - reveal)
    core.style.transform = `translate(-50%, -50%) scale(${1 - scatter * .085 + charge * .17 + reveal * .12})`
    opacity(core, 1 - smooth((t - 1195) / 220))
    opacity(glow, fusion * .85); glow.style.transform = `scale(${.68 + charge * .4 + reveal * 1.1})`
    opacity(flare, fusion * .6); flare.style.transform = `scaleX(${.18 + charge * .9 + reveal * 1.2})`
    waves.forEach((wave, i) => {
      const p = clamp((t - 1130 - i * 90) / 640)
      wave.setAttribute('r', String(62 + p * (i ? 280 : 350)))
      opacity(wave, Math.sin(p * Math.PI) * (i ? .27 : .39)); wave.style.strokeWidth = String(1.2 - p * .8)
    })
    sparks.forEach((spark, i) => {
      const p = clamp((t - STARTUP_FLIGHT_MS - i % 4 * 15) / 500)
      const angle = i * Math.PI * 2 / sparks.length + .12 * p, r = 52 + p * (100 + i % 3 * 38)
      spark.setAttribute('cx', String(220 + Math.cos(angle) * r)); spark.setAttribute('cy', String(137.5 + Math.sin(angle) * r * .7))
      opacity(spark, Math.sin(p * Math.PI) * .4)
    })
    copy.forEach((element, i) => {
      const out = smooth((t - i * 12) / 210)
      opacity(element, 1 - out); element.style.transform = `translateY(${-out * 4}px)`
    })
    opacity(ambient, 1 - reveal); opacity(stars, 1 - reveal)
    if (!entrance) return
    const { width, height, cx, cy, target } = geometry
    const radius = 62.5 + (target - 62.5) * reveal
    const vertices = [[0, -1], [.866, -.5], [.866, .5], [0, 1], [-.866, .5], [-.866, -.5]]
    const polygon = vertices.map(([x, y]) => [cx + x * radius, cy + y * radius])
    const workspace = entrance.workspace
    workspace.style.clipPath = reveal > 0 && reveal < 1 ? `polygon(${polygon.map(p => p.join('px ') + 'px').join(',')})` : 'none'
    opacity(workspace, reveal > 0 ? 1 : 0)
    workspace.style.transform = `translate3d(0, ${(1 - reveal) * 5}px, 0) scale(${.993 + reveal * .007})`
    screen.style.clipPath = reveal > 0 && reveal < 1 ? `path(evenodd, 'M0 0H${width}V${height}H0Z M${polygon.map(p => p.join(' ')).join('L')}Z')` : 'none'
    edges.forEach((edge, i) => {
      const r = radius * (i === 2 ? .985 : 1)
      edge.setAttribute('d', `M${vertices.map(([x, y]) => `${cx + x * r} ${cy + y * r}`).join('L')}Z`)
      opacity(edge, (reveal > 0 ? Math.sin(Math.PI * Math.pow(reveal, .45)) * .95 : 0) * [.25, 1, .38][i])
    })
    chargeLight.setAttribute('cx', String(cx)); chargeLight.setAttribute('cy', String(cy))
    chargeLight.setAttribute('r', String(62.5 * (2 + reveal * 4)))
    opacity(chargeLight, smooth((t - 1030) / 170) * (1 - smooth((t - 1185) / 400)) * .75)
    screen.style.background = reveal > 0 ? 'transparent' : '#0f1011'
  }
  function stopFrame(): void { cancelAnimationFrame(frame); frame = 0 }
  function clearEntrance(): void {
    if (entrance) {
      clearTimeout(entrance.timer)
      for (const key of ['clip-path', 'opacity', 'transform']) entrance.workspace.style.removeProperty(key)
    }
    entrance = undefined
    screen.style.removeProperty('clip-path'); screen.style.removeProperty('background')
    screen.classList.remove('entering'); document.body.classList.remove('startup-entering')
    portal.style.display = 'none'
  }
  function finish(): void {
    if (!entrance || !active) return
    const done = entrance.done
    screen.hidden = true
    clearEntrance(); stopFrame(); active = false
    observer.disconnect(); preference.removeEventListener('change', handlePreference)
    done()
  }
  function tick(): void {
    frame = 0
    if (!active || screen.hidden) return
    const now = clock()
    draw(now)
    if (entrance && now - entrance.start >= STARTUP_ENTRANCE_MS) finish()
    else schedule()
  }
  function schedule(): void { if (!frame && active && !preference.matches) frame = requestAnimationFrame(tick) }
  function handlePreference(): void {
    if (preference.matches) { stopFrame(); if (entrance) finish() }
    else schedule()
  }
  const observer = new ResizeObserver(() => { if (active) { measure(); draw(clock()) } })
  measure(); draw(clock()); observer.observe(screen)
  preference.addEventListener('change', handlePreference)
  schedule()
  return {
    enter(done: () => void): () => void {
      clearEntrance()
      const workspace = document.querySelector<HTMLElement>('.app')!
      entrance = { start: clock(), done, workspace, timer: setTimeout(finish, STARTUP_ENTRANCE_MS + 120) }
      const current = entrance
      measure()
      screen.classList.add('entering'); document.body.classList.add('startup-entering')
      portal.style.display = ''
      if (preference.matches) finish()
      else { draw(clock()); schedule() }
      return () => {
        if (entrance === current) {
          clearEntrance()
          screen.setAttribute('aria-busy', 'true'); screen.setAttribute('aria-modal', 'true')
          draw(clock()); schedule()
        }
      }
    },
    fail(): void {
      clearEntrance(); draw(clock()); stopFrame(); active = false
      observer.disconnect(); preference.removeEventListener('change', handlePreference)
      nodes.forEach(node => {
        const point = sampleStartupMotion(node.route, clock())
        node.element.style.top = '100px'
        node.element.style.transform = `translate(${point.screenX}px, ${point.screenY * 200 / 275}px) scale(.8)`
        node.element.style.removeProperty('opacity')
      })
    },
    dispose(): void {
      clearEntrance(); stopFrame(); active = false
      observer.disconnect(); preference.removeEventListener('change', handlePreference)
      for (const element of [portal, trails, glow, flare, fx]) element.remove()
    }
  }
}
