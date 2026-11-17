import { Component, createElement, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode, type RefObject } from 'react'
import type { QueueItem } from '@shared/types'
const origins = new Map<string, { rect: DOMRect; at: number; copy: HTMLElement; source: HTMLElement; signature: string; received?: boolean }>()
const aliases = new Map<string, string>()
const flights = new Map<HTMLElement, { key: string; cancel: () => void }>()
let flightObserver: MutationObserver | undefined
const sendDuration = 420
const sourceFades = new Map<string, { source: HTMLElement; cancel: () => void }>()
const queueDepartures = new Map<string, { start: () => void; cancel: () => void }>()
const reduceMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches

function draftSignature(source: HTMLElement): string {
  return [...source.querySelectorAll<HTMLElement>('[contenteditable],textarea,.attach-bar')].map(node =>
    node instanceof HTMLTextAreaElement ? node.value : node.innerHTML).join('|') ||
    (source instanceof HTMLTextAreaElement ? source.value : source.textContent || '')
}

export function captureSendOrigin(element: HTMLElement | null | undefined, key: string = crypto.randomUUID()): string {
  const now = Date.now()
  for (const [id, origin] of origins) if (id !== key && !queueDepartures.has(id) && now - origin.at > 30_000) cancelSendOrigin(id)
  if (element) {
    for (const fade of sourceFades.values()) if (fade.source === element) fade.cancel()
    const rect = element.getBoundingClientRect(), copy = visualCopy(element, rect)
    copy.querySelectorAll('.config-bar,.slash-menu,.sb-menu-pop,.queue-card-acts').forEach(node => node.remove())
    origins.set(key, { rect, at: now, copy, source: element, signature: draftSignature(element) })
  }
  return key
}

export function associateSendOrigin(scope: string, key: string): void { if (origins.has(key)) aliases.set(scope, key) }
export function cancelSendOrigin(key: string): void {
  queueDepartures.get(key)?.cancel()
  origins.delete(key)
  for (const [scope, id] of aliases) if (id === key) aliases.delete(scope)
  for (const flight of flights.values()) if (flight.key === key) flight.cancel()
  sourceFades.get(key)?.cancel()
}

function visualCopy(element: HTMLElement, rect: DOMRect): HTMLElement {
  const copy = element.cloneNode(true) as HTMLElement
  const style = getComputedStyle(element)
  copy.removeAttribute('id')
  copy.removeAttribute('data-queue-send-key')
  copy.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'))
  copy.querySelectorAll('input,textarea,select,button').forEach(node => { node.removeAttribute('name'); node.removeAttribute('form') })
  copy.inert = true
  copy.setAttribute('aria-hidden', 'true')
  Object.assign(copy.style, {
    position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`,
    height: `${rect.height}px`, margin: '0', zIndex: '10000', pointerEvents: 'none',
    animation: 'none', transform: 'none', opacity: style.opacity, maxWidth: 'none', boxSizing: 'border-box',
    backgroundColor: style.backgroundColor, color: style.color, font: style.font,
    padding: style.padding, border: style.border, borderRadius: style.borderRadius, boxShadow: style.boxShadow
  })
  return copy
}

type FlowEntry = { element: HTMLElement; cancel: () => void; resize: () => void; progress: number; height: number; targetHeight: number }
const flowEntries = new Map<HTMLElement, FlowEntry>()
const smooth = (value: number): number => value * value * (3 - 2 * value)

/** Grow real occupied space; flex gaps are included so insertion never jumps the transcript. */
function animateFlowEntry(element: HTMLElement, duration: number, from = 0, done: () => void = () => {}, to = 1): FlowEntry {
  flowEntries.get(element)?.cancel()
  const properties = ['height', 'minHeight', 'overflow', 'flexShrink', 'marginTop', 'marginBottom', 'paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth', 'opacity', 'transform'] as const
  const saved = Object.fromEntries(properties.map(key => [key, element.style[key]]))
  const style = getComputedStyle(element), number = (value: string): number => parseFloat(value) || 0
  const top = number(style.marginTop), bottom = number(style.marginBottom)
  const paddingTop = number(style.paddingTop), paddingBottom = number(style.paddingBottom)
  const borderTop = number(style.borderTopWidth), borderBottom = number(style.borderBottomWidth)
  const parent = element.parentElement && getComputedStyle(element.parentElement)
  let previous = element.previousElementSibling
  while (previous && getComputedStyle(previous).display === 'none') previous = previous.previousElementSibling
  const gap = previous && parent?.display.includes('flex') && parent.flexDirection === 'column' ? number(parent.rowGap) : 0
  const children = [...element.children].filter((node): node is HTMLElement => node instanceof HTMLElement)
  const childFlex = new Map(children.map(node => [node, node.style.flexShrink]))
  if (style.display.includes('flex')) children.forEach(node => { node.style.flexShrink = '0' })
  let frame = 0, resizeFrame = 0, finished = false, segment = from, fromHeight = element.getBoundingClientRect().height * from
  const entry: FlowEntry = { element, progress: from, height: fromHeight, targetHeight: to ? element.getBoundingClientRect().height : 0, cancel: () => finish(), resize: () => resize() }
  const started = performance.now()
  const paint = (): void => {
    const p = entry.progress, local = Math.min(1, (p - segment) / (to - segment || .001))
    entry.height = fromHeight + (entry.targetHeight - fromHeight) * local
    Object.assign(element.style, { height: `${entry.height}px`, minHeight: '0', overflow: 'hidden', flexShrink: '0',
      marginTop: `${top * p - gap * (1 - p)}px`, marginBottom: `${bottom * p}px`,
      paddingTop: `${paddingTop * p}px`, paddingBottom: `${paddingBottom * p}px`, borderTopWidth: `${borderTop * p}px`, borderBottomWidth: `${borderBottom * p}px`,
      opacity: String(p), transform: `translateY(${18 * (1 - p)}px)` })
  }
  const resize = (): void => {
    if (finished || !to) return
    const height = element.style.height, current = getComputedStyle(element)
    const edges = number(current.paddingTop) + number(current.paddingBottom) + number(current.borderTopWidth) + number(current.borderBottomWidth)
    element.style.height = 'auto'
    const target = element.getBoundingClientRect().height + paddingTop + paddingBottom + borderTop + borderBottom - edges
    element.style.height = height
    if (Math.abs(target - entry.targetHeight) > 1) { fromHeight = entry.height; segment = entry.progress; entry.targetHeight = target }
  }
  const observer = new ResizeObserver(() => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(resize) })
  const observeChildren = (): void => {
    observer.disconnect()
    for (const child of element.children) {
      if (style.display.includes('flex') && child instanceof HTMLElement && !childFlex.has(child)) { childFlex.set(child, child.style.flexShrink); child.style.flexShrink = '0' }
      observer.observe(child)
    }
  }
  const mutations = new MutationObserver(records => {
    if (records.every(record => (record.target instanceof Element ? record.target : record.target.parentElement)?.closest('[data-motion-ignore]'))) return
    observeChildren(); resize()
  })
  const finish = (): void => {
    if (finished) return
    finished = true; cancelAnimationFrame(frame); cancelAnimationFrame(resizeFrame); observer.disconnect(); mutations.disconnect()
    for (const key of properties) element.style[key] = saved[key]
    for (const [child, value] of childFlex) child.style.flexShrink = value
    if (flowEntries.get(element) === entry) flowEntries.delete(element)
    done()
  }
  const tick = (now: number): void => {
    if (reduceMotion() || !element.isConnected || !element.getBoundingClientRect().width) { finish(); return }
    const elapsed = Math.min(1, (now - started) / duration)
    if (elapsed >= 1) resize()
    entry.progress = from + (to - from) * smooth(elapsed)
    paint()
    if (elapsed >= 1) finish()
    else frame = requestAnimationFrame(tick)
  }
  flowEntries.set(element, entry); paint(); observeChildren()
  mutations.observe(element, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['src', 'open', 'hidden'] })
  frame = requestAnimationFrame(tick)
  return entry
}

function fadeSubmittedDraft(id: string, origin: NonNullable<ReturnType<typeof origins.get>>): void {
  if (!origin.source.isConnected || draftSignature(origin.source) !== origin.signature) return
  const parts = origin.source.querySelector('.composer-main')
    ? [...origin.source.querySelectorAll<HTMLElement>(':scope>.composer-main,:scope>.attach-bar')] : [origin.source]
  const saved = parts.map(node => {
    const property: 'color' | 'opacity' = node instanceof HTMLTextAreaElement ? 'color' : 'opacity'
    const value = node.style[property]
    node.style[property] = property === 'color' ? 'transparent' : '0'
    return { node, property, value }
  })
  const observer = new MutationObserver(() => { if (draftSignature(origin.source) !== origin.signature) cancel() })
  const cancel = (): void => {
    observer.disconnect(); origin.source.removeEventListener('input', cancel, true)
    saved.forEach(({ node, property, value }) => { node.style[property] = value })
    sourceFades.delete(id)
    stopFlightObserver()
  }
  origin.source.addEventListener('input', cancel, true)
  observer.observe(origin.source, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['src', 'data-empty'] })
  sourceFades.set(id, { source: origin.source, cancel })
}

function stopFlightObserver(): void {
  if (!flights.size && !sourceFades.size) { flightObserver?.disconnect(); flightObserver = undefined }
}

export function animateSentContent(element: HTMLElement | null, key?: string): (() => void) | undefined {
  if (!element || !key) return
  const id = aliases.get(key) || key, origin = origins.get(id)
  if (!origin) return
  flights.get(element)?.cancel()
  origins.delete(id)
  for (const [scope, value] of aliases) if (value === id) aliases.delete(scope)
  if (reduceMotion() || Date.now() - origin.at > 30_000 || !element.getBoundingClientRect().width) { queueDepartures.get(id)?.cancel(); return }
  const copy = origin.copy
  copy.style.overflow = 'hidden'
  copy.dataset.sendFlight = id
  document.body.appendChild(copy)
  fadeSubmittedDraft(id, origin)
  const row = element.classList.contains('bubble') ? element.parentElement! : element.closest<HTMLElement>('.user-append-step') || element
  let finished = false, frame = 0
  const entry = animateFlowEntry(row, sendDuration, 0, () => finish())
  const animation = copy.animate([{ opacity: Number(copy.style.opacity) }, { opacity: 0, offset: 2 / 3 }, { opacity: 0 }], { duration: sendDuration, easing: 'ease-in-out', fill: 'both' })
  const follow = (): void => {
    if (finished) return
    const rect = element.getBoundingClientRect(), p = entry.progress
    Object.assign(copy.style, { left: `${origin.rect.left + (rect.left - origin.rect.left) * p}px`, top: `${origin.rect.top + (rect.top - origin.rect.top) * p}px`,
      width: `${origin.rect.width + (rect.width - origin.rect.width) * p}px`, height: `${origin.rect.height + (rect.height - origin.rect.height) * p}px` })
    frame = requestAnimationFrame(follow)
  }
  const finish = (): void => {
    if (finished) return
    finished = true
    cancelAnimationFrame(frame); animation.cancel(); copy.remove(); entry.cancel(); flights.delete(element)
    stopFlightObserver()
  }
  const cancel = (): void => { sourceFades.get(id)?.cancel(); finish() }
  flights.set(element, { key: id, cancel })
  queueDepartures.get(id)?.start()
  if (!flightObserver) {
    flightObserver = new MutationObserver(() => {
      for (const [target, flight] of flights) if (!target.isConnected || !target.getBoundingClientRect().width) flight.cancel()
      for (const fade of sourceFades.values()) if (!fade.source.isConnected || !fade.source.getBoundingClientRect().width) fade.cancel()
    })
    flightObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'hidden', 'class'] })
  }
  follow()
  return cancel
}

export function useSentContentMotion(ref: RefObject<HTMLElement>, key?: string): void {
  useLayoutEffect(() => {
    const element = ref.current
    animateSentContent(element, key)
    return () => { if (element) flights.get(element)?.cancel() }
  }, [key])
}

export function captureQueuedSendOrigin(key?: string): void {
  if (!key) return
  const row = document.querySelector<HTMLElement>(`[data-queue-send-key="${CSS.escape(key)}"]`)
  if (row) captureSendOrigin(row, key)
  const origin = origins.get(key)
  if (origin) origin.received = true
}

export function QueuedSendCard({ sendKey, ...props }: HTMLAttributes<HTMLDivElement> & { sendKey?: string }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  useSentContentMotion(ref, sendKey)
  return createElement('div', { ...props, ref })
}

type QueueSnapshot = { copy?: HTMLElement; rows: { key: string; copy: HTMLElement; nextKey?: string }[] }

/** Capture before React removes rows; retain only their occupied space during delivery. */
export class QueuedSendStack extends Component<{ queue: QueueItem[]; children: ReactNode }, {}, QueueSnapshot | null> {
  private root: HTMLDivElement | null = null
  private collapses = new Set<() => void>()
  private rootCollapse?: () => void
  private sendKeys = new Set<string>()

  getSnapshotBeforeUpdate(previous: Readonly<{ queue: QueueItem[]; children: ReactNode }>): QueueSnapshot | null {
    const root = this.root
    if (!root) return null
    const next = new Map(this.props.queue.map(item => [item.clientTurnKey || item.id, item]))
    const pending = (item?: QueueItem): boolean => !!item && (!item.state || item.state === 'pending')
    for (const item of previous.queue) if (!pending(item) && pending(next.get(item.clientTurnKey || item.id))) cancelSendOrigin(item.clientTurnKey || item.id)
    const rows: QueueSnapshot['rows'] = []
    for (const row of root.querySelectorAll<HTMLElement>('[data-queue-send-key]:not([aria-hidden])')) {
      const key = row.dataset.queueSendKey!, item = next.get(key)
      if (pending(item) || !origins.get(key)?.received && item?.state !== 'dispatching' && item?.state !== 'steering') continue
      const received = origins.get(key)?.received
      captureSendOrigin(row, key); origins.get(key)!.received = received; this.sendKeys.add(key)
      const copy = row.cloneNode(true) as HTMLElement
      copy.removeAttribute('title')
      copy.dataset.queueCollapse = key; copy.inert = true; copy.setAttribute('aria-hidden', 'true')
      Object.assign(copy.style, { height: `${row.getBoundingClientRect().height}px`, minHeight: '0', pointerEvents: 'none', boxSizing: 'border-box', flexShrink: '0' })
      rows.push({ key, copy, nextKey: row.nextElementSibling instanceof HTMLElement ? row.nextElementSibling.dataset.queueSendKey : undefined })
    }
    return rows.length ? { copy: [...next.values()].some(pending) ? undefined : root.cloneNode(true) as HTMLElement, rows } : null
  }

  componentDidUpdate(_previous: unknown, _previousState: unknown, snapshot?: QueueSnapshot | null): void {
    const root = this.root!
    const pending = this.props.queue.some(item => !item.state || item.state === 'pending')
    if (pending) { this.rootCollapse?.(); this.rootCollapse = undefined }
    for (const key of this.sendKeys) if (!this.props.queue.some(item => (item.clientTurnKey || item.id) === key) && origins.has(key) && !origins.get(key)?.received) cancelSendOrigin(key)
    if (!snapshot || reduceMotion()) return
    root.style.display = ''
    if (!pending) {
      for (const cancel of this.collapses) cancel()
      const children = [...snapshot.copy!.children] as HTMLElement[]
      children.forEach(child => {
        child.inert = true; child.setAttribute('aria-hidden', 'true'); child.dataset.queueCollapse = 'stack'
        root.appendChild(child)
      })
      let entry: FlowEntry | undefined
      const cancel = (): void => {
        entry?.cancel(); children.forEach(child => child.remove())
        root.style.display = this.props.queue.some(item => !item.state || item.state === 'pending') ? '' : 'none'
        for (const { key } of snapshot.rows) queueDepartures.delete(key)
        this.rootCollapse = undefined
      }
      const start = (): void => {
        if (entry) return
        children.filter(child => child.classList.contains('queue-card')).forEach(child => { child.style.visibility = 'hidden' })
        for (const { key } of snapshot.rows) queueDepartures.delete(key)
        entry = animateFlowEntry(root, sendDuration, 1, cancel, 0)
      }
      this.rootCollapse = cancel
      for (const { key } of snapshot.rows) queueDepartures.set(key, { start, cancel })
      if ([...flights.values()].some(flight => snapshot.rows.some(row => row.key === flight.key))) start()
      return
    }
    for (const { copy, nextKey } of snapshot.rows) {
      root.insertBefore(copy, nextKey ? root.querySelector(`[data-queue-send-key="${CSS.escape(nextKey)}"]`) : null)
      const key = copy.dataset.queueCollapse!
      let entry: FlowEntry | undefined
      const cancel = (): void => { entry?.cancel(); copy.remove(); this.collapses.delete(cancel); queueDepartures.delete(key) }
      const start = (): void => { if (!entry) { copy.style.visibility = 'hidden'; queueDepartures.delete(key); entry = animateFlowEntry(copy, sendDuration, 1, cancel, 0) } }
      this.collapses.add(cancel); queueDepartures.set(key, { start, cancel })
      if ([...flights.values()].some(flight => flight.key === key)) start()
    }
  }

  componentWillUnmount(): void {
    this.rootCollapse?.()
    for (const cancel of this.collapses) cancel()
    for (const key of this.sendKeys) cancelSendOrigin(key)
  }

  render(): ReactNode {
    return createElement('div', { className: 'queue-stack', ref: (node: HTMLDivElement | null): void => { this.root = node }, style: { display: this.props.queue.some(item => !item.state || item.state === 'pending') ? undefined : 'none' } }, this.props.children)
  }
}

type MotionSnapshot = { rect: DOMRect; copy: HTMLElement; signature: string }

/** Observe actual DOM changes, including child request state, without remounting inputs. */
export function useLayoutMotion(ref: RefObject<HTMLElement>, enabled = true, selector = '[data-motion-key]', move = true): void {
  useLayoutEffect(() => {
    const root = ref.current
    if (!root || !enabled) return
    let previous = new Map<string, MotionSnapshot>(), frame = 0, initial = true
    const running = new Map<string, { element: HTMLElement; cancel: () => void }>()
    const entries = new Map<string, FlowEntry>()
    const update = (): void => {
      frame = 0
      const interrupted = new Map<string, DOMRect>()
      for (const [key, row] of running) {
        if (!row.element.isConnected) continue
        const rect = row.element.getBoundingClientRect()
        if (rect.width && rect.height) interrupted.set(key, rect)
      }
      for (const row of running.values()) row.cancel()
      running.clear()
      const next = new Map<string, MotionSnapshot>()
      for (const element of root.querySelectorAll<HTMLElement>(selector)) {
        const key = element.dataset.motionKey!
        if (element.closest('.router-history-segment')) {
          entries.get(key)?.cancel()
          const rect = element.getBoundingClientRect()
          next.set(key, { rect, copy: visualCopy(element, rect), signature: element.textContent || '' })
          continue
        }
        let entry = entries.get(key)
        if (entry && entry.element !== element) {
          const progress = entry.progress; entry.cancel()
          entry = animateFlowEntry(element, Math.max(1, 360 * (1 - progress)), progress, () => entries.delete(key)); entries.set(key, entry)
        }
        entry?.resize()
        const rect = element.getBoundingClientRect()
        if (entry) rect.height = entry.targetHeight
        if (!rect.width || !rect.height) continue
        const signature = element.textContent + '|' + [...element.querySelectorAll('button,input')].map(node => `${(node as HTMLButtonElement).disabled}:${(node as HTMLInputElement).checked}`).join(',')
        const old = previous.get(key)
        const reuse = old && old.signature === signature
        const copy = reuse ? old.copy : visualCopy(element, rect)
        if (reuse) Object.assign(copy.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` })
        next.set(key, { rect, copy, signature })
        if (initial || reduceMotion()) continue
        const from = interrupted.get(key) || old?.rect
        if (entry) continue
        if (!old && element.classList.contains('router-assignment')) {
          const nextEntry = animateFlowEntry(element, 360, 0, () => entries.delete(key)); entries.set(key, nextEntry)
          continue
        }
        const moved = move && from && (Math.abs(from.left - rect.left) > 1 || Math.abs(from.top - rect.top) > 1)
        const resized = old && Math.abs(old.rect.height - rect.height) > 1
        if (!old || moved || resized || old.signature !== signature) {
          let target = element, restore = (): void => {}
          if (moved) {
            target = visualCopy(element, rect)
            document.body.appendChild(target)
            const opacity = element.style.opacity
            element.style.opacity = '0'
            restore = () => { target.remove(); element.style.opacity = opacity }
          }
          const animation = target.animate(moved ? [
            { transform: `translate(${from!.left - rect.left}px,${from!.top - rect.top}px)` }, { transform: 'translate(0,0)' }
          ] : !old ? [
            { opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }
          ] : [
            { opacity: .55, ...(resized ? { height: `${old.rect.height}px`, overflow: 'hidden' } : {}) },
            { opacity: 1, ...(resized ? { height: `${rect.height}px`, overflow: 'hidden' } : {}) }
          ], { duration: moved ? 240 : !old ? 200 : 180, easing: 'cubic-bezier(.2,.8,.2,1)' })
          const row = { element: target, cancel: () => { animation.cancel(); restore() } }
          running.set(key, row)
          void animation.finished.then(() => { restore(); if (running.get(key) === row) running.delete(key) }, () => {})
        }
      }
      if (!initial && !reduceMotion()) for (const [key, old] of previous) if (!next.has(key)) {
        const copy = old.copy
        document.body.appendChild(copy)
        const animation = copy.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-6px)' }], { duration: 160, easing: 'ease-out' })
        const row = { element: copy, cancel: () => { animation.cancel(); copy.remove() } }
        running.set(key, row)
        void animation.finished.then(() => { copy.remove(); if (running.get(key) === row) running.delete(key) }, () => {})
      }
      previous = next; initial = false
      for (const [key, entry] of entries) if (!next.has(key)) entry.cancel()
    }
    update()
    const observer = new MutationObserver(records => {
      const relevant = records.some(record => {
        const target = record.target instanceof Element ? record.target : record.target.parentElement
        if (target?.closest('[data-motion-ignore]')) return false
        return !!target?.closest(selector) || [...record.addedNodes, ...record.removedNodes].some(node =>
          node instanceof HTMLElement && (node.matches(selector) || !!node.querySelector(selector) ||
            !!node.dataset.motionKey && previous.has(node.dataset.motionKey) ||
            [...node.querySelectorAll<HTMLElement>('[data-motion-key]')].some(child => previous.has(child.dataset.motionKey!))))
      })
      if (relevant) {
        const insertedCard = records.some(record => [...record.addedNodes].some(node =>
          node instanceof HTMLElement && (node.matches('.router-assignment') || !!node.querySelector('.router-assignment'))))
        if (insertedCard) { cancelAnimationFrame(frame); update() }
        else if (!frame) frame = requestAnimationFrame(update)
      }
    })
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'disabled', 'aria-busy', 'aria-expanded'] })
    return () => { observer.disconnect(); cancelAnimationFrame(frame); for (const row of running.values()) row.cancel(); for (const entry of entries.values()) entry.cancel() }
  }, [ref, enabled, selector, move])
}
