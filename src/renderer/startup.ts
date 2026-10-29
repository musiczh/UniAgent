import { createStartupAnimation } from './startupAnimation'

const screen = document.getElementById('ua-startup')!
const title = document.getElementById('ua-startup-title')!
const stage = document.getElementById('ua-startup-stage')!
const restart = document.getElementById('ua-startup-restart') as HTMLButtonElement
const clockKey = 'ua.startup-started-at'
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)')
const reducedMotion = (): boolean => motionPreference.matches
let failed = false
let stageText = stage.textContent
let stageRevision = 0
let stageAnimation: Animation | undefined
let elapsed = 0

// The boot document and the React document share a clock across navigation.
try {
  const startedAt = Number(sessionStorage.getItem(clockKey)) || Date.now()
  sessionStorage.setItem(clockKey, String(startedAt))
  elapsed = Math.max(0, Date.now() - startedAt)
  screen.style.setProperty('--ua-elapsed', `${-elapsed}ms`)
} catch { /* storage is optional for the loading screen */ }
const animation = createStartupAnimation(screen, elapsed, motionPreference)

function cancelStageAnimation(): void {
  stageRevision++
  stageAnimation?.cancel()
}

export function updateStartup(stageName: string, error = false): void {
  if (screen.hidden || failed && !error) return
  if (error) {
    failed = true
    cancelStageAnimation()
    animation.fail()
    screen.classList.add('error')
    screen.setAttribute('aria-busy', 'false')
    screen.setAttribute('aria-modal', 'true')
    title.textContent = '启动异常'
    restart.hidden = false
    return
  }
  if (stageText === stageName) return
  stageText = stageName
  const current = getComputedStyle(stage)
  const from = { opacity: current.opacity, transform: current.transform, filter: current.filter }
  cancelStageAnimation()
  if (reducedMotion()) { stage.textContent = stageName; return }
  const revision = stageRevision
  stageAnimation = stage.animate([
    from,
    { opacity: 0, transform: 'translateY(-6px)', filter: 'blur(2px)' }
  ], { duration: 160, easing: 'ease-in', fill: 'forwards' })
  void stageAnimation.finished.then(() => {
    if (revision !== stageRevision) return
    stage.textContent = stageName
    stageAnimation?.cancel()
    stageAnimation = stage.animate([
      { opacity: 0, transform: 'translateY(7px)', filter: 'blur(2px)' },
      { opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' }
    ], { duration: 220, easing: 'ease-out', fill: 'forwards' })
  }).catch(() => {})
}

export function enterStartup(onComplete: () => void): () => void {
  if (screen.hidden) { onComplete(); return () => {} }
  if (failed) return () => {}
  cancelStageAnimation()
  screen.setAttribute('aria-busy', 'false')
  screen.setAttribute('aria-modal', 'false')
  return animation.enter(() => {
    try { sessionStorage.removeItem(clockKey) } catch { /* no persistent state */ }
    onComplete()
  })
}

restart.addEventListener('click', () => {
  restart.disabled = true
  restart.textContent = '正在重新启动…'
  void window.uniagent.restartApp().catch(() => {
    restart.disabled = false
    restart.textContent = '重新启动'
  })
})
const offFailure = window.uniagent.onStartupFailed(() => updateStartup('', true))
window.addEventListener('pagehide', () => { cancelStageAnimation(); animation.dispose(); offFailure() }, { once: true })
