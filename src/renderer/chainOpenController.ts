export type ChainOpenState = {
  manualOpenIds: Set<string>
  manualClosedIds: Set<string>
}

export function reconcileChainOpenState(
  state: ChainOpenState,
  validIds: ReadonlySet<string>
): ChainOpenState {
  return {
    manualOpenIds: new Set([...state.manualOpenIds].filter((id) => validIds.has(id))),
    manualClosedIds: new Set([...state.manualClosedIds].filter((id) => validIds.has(id)))
  }
}

export function toggleChainOpen(
  state: ChainOpenState,
  id: string,
  autoOpenId: string | null
): ChainOpenState {
  const manualOpenIds = new Set(state.manualOpenIds)
  const manualClosedIds = new Set(state.manualClosedIds)
  const open = manualOpenIds.has(id) || (autoOpenId === id && !manualClosedIds.has(id))
  if (open) {
    manualOpenIds.delete(id)
    manualClosedIds.add(id)
  } else {
    manualClosedIds.delete(id)
    manualOpenIds.add(id)
  }
  return { manualOpenIds, manualClosedIds }
}

export function isChainOpen(state: ChainOpenState, id: string, autoOpenId: string | null): boolean {
  return state.manualOpenIds.has(id) || (autoOpenId === id && !state.manualClosedIds.has(id))
}
