import versions from './agentCompatibility.json'
import type { AgentDef } from './types'

export function testedAgentVersion(adapter: string): string | undefined {
  return (versions as Record<string, string[]>)[adapter]?.at(-1)
}

export function agentVersionWarning(agent?: Pick<AgentDef, 'adapter' | 'name' | 'version' | 'installed' | 'lifecycle'>): { message: string; testedVersion?: string } | undefined {
  if (!agent?.installed) return
  const version = (agent.lifecycle?.currentVersion || agent.version)?.match(/(?:^|[\s(])v?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)(?=$|[\s)])/i)?.[1]
  const tested = (versions as Record<string, string[]>)[agent.adapter]
  if (version && (!tested || tested.includes(version))) return
  return { message: `${version ? `当前 ${agent.name} ${version} 未经此版 UniAgent 验证` : `当前 ${agent.name} 版本无法识别`}，可能存在兼容问题。建议更新至最新版 UniAgent。`,
    testedVersion: tested?.at(-1) }
}
