// Measure the real layout immediately before and after temporary height removal.
export function installMotionFinishDriver() {
  const samples = [], watched = new WeakSet()
  const watch = element => {
    if (watched.has(element) || !element.style.height) return
    watched.add(element)
    Object.defineProperty(element.style, 'height', {
      configurable: true,
      get() { return this.getPropertyValue('height') },
      set(value) {
        if (value === '') {
          const before = element.getBoundingClientRect()
          queueMicrotask(() => {
            const after = element.getBoundingClientRect()
            samples.push({ key: element.dataset.clientTurnKey || element.dataset.routerRequest,
              before: before.height, after: after.height, gap: Math.abs(after.height - before.height),
              positionGap: Math.abs(after.top - before.top) })
          })
        }
        this.setProperty('height', value)
      }
    })
  }
  return { samples, watch }
}
