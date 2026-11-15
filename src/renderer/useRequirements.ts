import { useEffect, useState } from 'react'
import type { Requirement } from '@shared/requirementTypes'

export function useRequirements(enabled = true): { requirements: Requirement[]; error: string; loading: boolean; retry: () => void } {
  const [requirements, setRequirements] = useState<Requirement[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [retryKey, setRetryKey] = useState(0)
  useEffect(() => {
    if (!enabled) { setRequirements([]); setError(''); setLoading(false); return }
    let live = true, generation = 0
    const refresh = (): void => {
      const ticket = ++generation
      void window.uniagent.listRequirements().then(rows => {
        if (live && ticket === generation) { setRequirements(rows); setError(''); setLoading(false) }
      }, reason => { if (live && ticket === generation) { setError(String(reason)); setLoading(false) } })
    }
    const stop = window.uniagent.onRequirementsChanged(refresh)
    refresh()
    return () => { live = false; stop() }
  }, [enabled, retryKey])
  return { requirements, error, loading, retry: () => { setLoading(true); setRetryKey(key => key + 1) } }
}
