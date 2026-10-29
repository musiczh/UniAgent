export {
  KIMI_PERMISSION_MODES,
  acpLaunchArgs,
  assertACPProviderConfig,
  projectACPContract
} from './acpProvider.ts'

// Compatibility export while the existing Grok contract tests continue to
// import their historical module. The concrete implementation is shared.
export {
  GROK_PERMISSION_MODES,
  GrokACPRunner as ACPRunner,
  deleteGrokSession,
  deleteKimiSession,
  listGrokSessions,
  listKimiSessions,
  listMCodeSessions,
  forkMCodeSession,
  loadGrokSessionEvents,
  loadKimiSessionEvents,
  loadMCodeSessionEvents,
  loadDeepSeekSessionEvents,
  listDeepSeekSessions,
  forkDeepSeekSession,
  inspectDeepSeekInventory,
  probeGrokACP,
  probeKimiACP,
  type GrokACPContract as ACPContract
} from '../grokACPRunner.ts'
