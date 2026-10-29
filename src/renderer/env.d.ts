import type { UniAgentAPI } from '../preload'

declare global {
  interface Window {
    uniagent: UniAgentAPI
  }
}

export {}
