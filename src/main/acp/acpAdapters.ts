import type { ACPProvider } from './acpProvider.ts'

/**
 * Adapters that speak the stable ACP v1 protocol.
 *
 * Every place that used to hard-code `['kimi','grok','deepseek']` now routes
 * through this helper, so adding a provider cannot silently skip a guard.
 */
export const ACP_ADAPTERS = ['kimi', 'grok', 'deepseek', 'mcode'] as const

export type ACPAdapterId = (typeof ACP_ADAPTERS)[number]

export function isACPAdapter(adapter: string | undefined): adapter is ACPAdapterId {
  return !!adapter && (ACP_ADAPTERS as readonly string[]).includes(adapter)
}

/** Map an adapter id onto its ACP provider, or undefined for non-ACP agents. */
export function acpProviderFor(adapter: string | undefined): ACPProvider | undefined {
  if (adapter === 'deepseek') return 'deepseek'
  if (adapter === 'kimi') return 'kimi'
  if (adapter === 'mcode') return 'mcode'
  if (adapter === 'grok') return 'grok'
  return undefined
}
