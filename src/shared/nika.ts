export type NikaStatus = 'ready' | 'stopped' | 'needs-auth' | 'uninstalled' | 'failed'
export interface NikaSnapshot {
  status: NikaStatus
  appPath?: string
  executable?: string
  appVersion?: string
  version?: string
  message?: string
}
/** Native IDs are meaningful only inside this exact Nika instance. No credentials are persisted. */
export interface NikaBinding { home: string; portBase: number }
export type NikaSetupAction = 'open' | 'install' | 'cancel'
