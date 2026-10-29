export type KimiSetupPhase = 'idle' | 'checking' | 'downloading' | 'verifying' | 'activating' | 'login' | 'completed' | 'cancelled' | 'failed'
export interface KimiSetupSnapshot {
  phase: KimiSetupPhase
  status?: 'uninstalled' | 'incompatible' | 'needs-auth' | 'needs-config' | 'ready'
  version?: string
  message?: string
  receivedBytes?: number
  totalBytes?: number
  cancellable: boolean
  region?: 'cn' | 'global'
  canReopen?: boolean
}
