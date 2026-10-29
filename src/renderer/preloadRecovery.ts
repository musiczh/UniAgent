const PRELOAD_RELOAD_KEY = 'ua-preload-reload'

export function recoverFromPreloadError(
  event: Event,
  buildId: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> = sessionStorage,
  reload: () => void = () => window.location.reload()
): void {
  event.preventDefault()
  if (storage.getItem(PRELOAD_RELOAD_KEY) === buildId) return
  storage.setItem(PRELOAD_RELOAD_KEY, buildId)
  reload()
}
