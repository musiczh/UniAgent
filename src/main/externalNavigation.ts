/** Protocols that are safe to hand to the operating system's URL handler. */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:'])

export function isTrustedExternalUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    return EXTERNAL_PROTOCOLS.has(url.protocol)
  } catch {
    return false
  }
}

interface NavigationEvent {
  preventDefault(): void
}

interface ExternalNavigationWebContents {
  setWindowOpenHandler(
    handler: (details: { url: string }) => { action: 'deny' }
  ): void
  on(event: 'will-navigate', listener: (event: NavigationEvent, url: string) => void): void
}

type ExternalOpener = (url: string) => void | Promise<unknown>

/**
 * Keep every user-triggered navigation out of UniAgent. Both new-window links
 * (`window.open` / `target=_blank`) and same-window anchor navigation are
 * denied; trusted web URLs are handed to the system browser instead.
 */
export function installExternalNavigation(
  webContents: ExternalNavigationWebContents,
  openExternal: ExternalOpener
): void {
  const openIfTrusted = (url: string): void => {
    if (!isTrustedExternalUrl(url)) return
    void Promise.resolve(openExternal(url)).catch((err) => {
      console.error('[open-external]', url, err)
    })
  }

  webContents.setWindowOpenHandler(({ url }) => {
    openIfTrusted(url)
    return { action: 'deny' }
  })

  webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    openIfTrusted(url)
  })
}
