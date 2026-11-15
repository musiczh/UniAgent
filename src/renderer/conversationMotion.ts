import { useLayoutEffect, type RefObject } from 'react'
const origins = new Map<string, { rect: DOMRect; at: number }>()
const aliases = new Map<string, string>()
const flights = new Map<HTMLElement, { key: string; cancel: () => void }>()
let flightObserver: MutationObserver | undefined
const reduceMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches

export function captureSendOrigin(element: HTMLElement | null | undefined, key: string = crypto.randomUUID()): string {
  const now = Date.now()
  for (const [id, origin] of origins) if (now - origin.at > 30_000) cancelSendOrigin(id)
  if (element) origins.set(key, { rect: element.getBoundingClientRect(), at: now })
  return key
}

export function associateSendOrigin(scope: string, key: string): void { aliases.set(scope, key) }
export function cancelSendOrigin(key: string): void {
  origins.delete(key)
  for (const [scope, id] of aliases) if (id === key) aliases.delete(scope)
  for (const flight of flights.values()) if (flight.key === key) flight.cancel()
}

function visualCopy(element: HTMLElement, rect: DOMRect): HTMLElement {
  const copy = element.cloneNode(true) as HTMLElement
  const style = getComputedStyle(element)
  copy.removeAttribute('id')
  copy.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'))
  copy.querySelectorAll('input,textarea,select,button').forEach(node => { node.removeAttribute('name'); node.removeAttribute('form') })
  copy.inert = true
  copy.setAttribute('aria-hidden', 'true')
  Object.assign(copy.style, {
    position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`,
    height: `${rect.height}px`, margin: '0', zIndex: '10000', pointerEvents: 'none',
    animation: 'none', maxWidth: 'none', boxSizing: 'border-box',
    backgroundColor: style.backgroundColor, color: style.color, font: style.font,
    padding: style.padding, border: style.border, borderRadius: style.borderRadius, boxShadow: style.boxShadow
  })
  return copy
}

export function animateSentContent(element: HTMLElement | null, key?: string): (() => void) | undefined {
  if (!element || !key) return
  const id = aliases.get(key) || key, origin = origins.get(id)
  if (!origin) return
  flights.get(element)?.cancel()
  origins.delete(id); aliases.delete(key)
  if (reduceMotion() || Date.now() - origin.at > 30_000 || !element.getBoundingClientRect().width) return
  const rect = element.getBoundingClientRect()
  let copy = visualCopy(element, rect)
  if (element.classList.contains('bubble')) {
    const wrapper = visualCopy(element.parentElement!, rect)
    wrapper.replaceChildren(copy)
    Object.assign(wrapper.style, { display: 'block', padding: '0', border: '0', background: 'none' })
    Object.assign(copy.style, { position: 'static', width: '100%', height: '100%', opacity: '1' })
    copy = wrapper
  }
  copy.dataset.sendFlight = id
  document.body.appendChild(copy)
  const opacity = element.style.opacity
  element.style.opacity = '0'
  const animation = copy.animate([
    { transform: `translate(${origin.rect.left - rect.left}px,${origin.rect.top - rect.top}px) scale(.96)`, background: 'var(--bg-elev)', borderRadius: '12px' },
    { transform: 'translate(0,0) scale(1)', background: getComputedStyle(element).backgroundColor, borderRadius: getComputedStyle(element).borderRadius }
  ], { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' })
  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    copy.remove(); element.style.opacity = opacity; flights.delete(element)
    if (!flights.size) { flightObserver?.disconnect(); flightObserver = undefined }
  }
  const cancel = (): void => { animation.cancel(); finish() }
  flights.set(element, { key: id, cancel })
  if (!flightObserver) {
    flightObserver = new MutationObserver(() => {
      for (const [target, flight] of flights) if (!target.isConnected || !target.getBoundingClientRect().width) flight.cancel()
    })
    flightObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'hidden'] })
  }
  void animation.finished.then(finish, finish)
  return cancel
}

export function useSentContentMotion(ref: RefObject<HTMLElement>, key?: string): void {
  useLayoutEffect(() => {
    const element = ref.current
    const frame = requestAnimationFrame(() => { animateSentContent(element, key) })
    return () => { cancelAnimationFrame(frame); if (element) flights.get(element)?.cancel() }
  }, [key])
}

type MotionSnapshot = { rect: DOMRect; copy: HTMLElement; signature: string }

/** Observe actual DOM changes, including child request state, without remounting inputs. */
export function useLayoutMotion(ref: RefObject<HTMLElement>, enabled = true, selector = '[data-motion-key]', move = true): void {
  useLayoutEffect(() => {
    const root = ref.current
    if (!root || !enabled) return
    let previous = new Map<string, MotionSnapshot>(), frame = 0, initial = true
    const running = new Map<string, { element: HTMLElement; cancel: () => void }>()
    const update = (): void => {
      frame = 0
      const interrupted = new Map([...running].map(([key, row]) => [key, row.element.getBoundingClientRect()]))
      for (const row of running.values()) row.cancel()
      running.clear()
      const next = new Map<string, MotionSnapshot>()
      for (const element of root.querySelectorAll<HTMLElement>(selector)) {
        const rect = element.getBoundingClientRect(), key = element.dataset.motionKey!
        if (!rect.width || !rect.height) continue
        const signature = element.textContent + '|' + [...element.querySelectorAll('button,input')].map(node => `${(node as HTMLButtonElement).disabled}:${(node as HTMLInputElement).checked}`).join(',')
        next.set(key, { rect, copy: visualCopy(element, rect), signature })
        if (initial || reduceMotion()) continue
        const old = previous.get(key), from = interrupted.get(key) || old?.rect
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
      if (relevant && !frame) frame = requestAnimationFrame(update)
    })
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'disabled', 'aria-busy', 'aria-expanded'] })
    return () => { observer.disconnect(); cancelAnimationFrame(frame); for (const row of running.values()) row.cancel() }
  }, [ref, enabled, selector, move])
}
