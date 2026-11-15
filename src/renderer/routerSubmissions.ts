import { useSyncExternalStore } from 'react'
import type { Attachment } from '@shared/types'

export interface RouterSubmission {
  requestId: string
  routerSessionId?: string
  prompt: string
  attachments?: Attachment[]
  createdAt: number
  error?: string
}
let submissions: RouterSubmission[] = []
const listeners = new Set<() => void>()
const publish = (): void => { for (const listener of listeners) listener() }
export function stageRouterSubmission(input: Omit<RouterSubmission, 'createdAt'>): void {
  const previous = submissions.find(row => row.requestId === input.requestId)
  submissions = [...submissions.filter(row => row.requestId !== input.requestId && !row.error), { ...input, createdAt: previous?.createdAt || Date.now() }]
  publish()
}
export function failRouterSubmission(requestId: string, error: string): void {
  submissions = submissions.map(row => row.requestId === requestId ? { ...row, error } : row)
  publish()
}
export function retireRouterSubmissions(ids: Set<string>): void {
  if (!submissions.some(row => ids.has(row.requestId))) return
  submissions = submissions.filter(row => !ids.has(row.requestId)); publish()
}
export function useRouterSubmissions(): RouterSubmission[] {
  return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback) } }, () => submissions)
}
