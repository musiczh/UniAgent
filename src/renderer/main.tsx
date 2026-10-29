import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { CommentProvider } from './comments'
import { recoverFromPreloadError } from './preloadRecovery'
import './styles.css'
import './commentStyles.css'
import { monitorRendererPerformance } from './performanceMonitor'

const stopPerformanceMonitor = monitorRendererPerformance()
window.addEventListener('pagehide', stopPerformanceMonitor, { once: true })

window.addEventListener('vite:preloadError', (event) => {
  recoverFromPreloadError(event, import.meta.url)
})

window.addEventListener('error', (event) => {
  void window.uniagent.reportDiagnostic({
    source: 'renderer',
    code: 'uncaught_exception',
    message: event.message || 'Renderer uncaught exception',
    stack: event.error instanceof Error ? event.error.stack : undefined
  }).catch(() => {})
})
window.addEventListener('unhandledrejection', (event) => {
  const error = event.reason
  void window.uniagent.reportDiagnostic({
    source: 'renderer',
    code: 'unhandled_rejection',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  }).catch(() => {})
})

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CommentProvider><App /></CommentProvider>
  </React.StrictMode>
)
