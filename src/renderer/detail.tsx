import './styles.css'
import './commentStyles.css'
import { applyColorTheme } from './colorTheme'

const refreshColorTheme = () => { void window.uniagent.getDetailWindow().then(initial => applyColorTheme(initial.theme)).catch(() => {}) }
refreshColorTheme()
const stopColorTheme = window.uniagent.onUniAgentManagementChanged(resource => {
  if (resource === 'settings') refreshColorTheme()
})
window.addEventListener('pagehide', stopColorTheme, { once: true })

// Paint the existing loading UI before evaluating the conversation renderer.
requestAnimationFrame(() => {
  setTimeout(() => { void import('./detailChat').catch(() => window.close()) }, 0)
})
