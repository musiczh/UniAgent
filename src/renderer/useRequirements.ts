import { useEffect, useState } from 'react'
import type { Requirement } from '@shared/requirementTypes'

export function useRequirements(): { requirements: Requirement[]; error: string; loading: boolean } {
  const [requirements, setRequirements] = useState<Requirement[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
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
  }, [])
  return { requirements, error, loading }
}
