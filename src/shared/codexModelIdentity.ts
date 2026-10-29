import type { CodexModelSourceRef, SessionConfig } from './types'

const PREFIX = 'uniagent-model:'

/** Native IDs remain unchanged; supplemental selector keys never go on the wire. */
export function codexModelKey(model: string, source: CodexModelSourceRef): string {
  return source.kind === 'native' ? model
    : `${PREFIX}${source.kind}:${encodeURIComponent(source.sourceId || '')}:${encodeURIComponent(model)}`
}

export function parseCodexModelKey(key: string): { model: string; source: CodexModelSourceRef } | undefined {
  if (!key.startsWith(PREFIX)) return undefined
  const parts = key.slice(PREFIX.length).split(':')
  if (parts.length !== 3 || !['local', 'third-party'].includes(parts[0])) throw new Error('无效的 Codex 模型来源')
  const sourceId = decodeURIComponent(parts[1])
  const model = decodeURIComponent(parts[2])
  if (!sourceId || !model) throw new Error('无效的 Codex 模型来源')
  return { model, source: { kind: parts[0] as 'local' | 'third-party', sourceId } }
}

export function codexWireModel(config: Pick<SessionConfig, 'model'>): string | undefined {
  return config.model ? parseCodexModelKey(config.model)?.model ?? config.model : undefined
}

export function codexSessionProvider(source?: CodexModelSourceRef): string | undefined {
  if (!source || source.kind === 'native') return undefined
  return source.kind === 'local' ? 'uniagent-local' : `uniagent-${source.sourceId}`
}

/** Supplemental sources cannot consume another provider's compaction state. */
export function codexProviderChanged(previous: SessionConfig, next: SessionConfig): boolean {
  const source = (config: SessionConfig): CodexModelSourceRef =>
    config.modelSource ?? (config.model ? parseCodexModelKey(config.model)?.source : undefined) ?? { kind: 'native' }
  const before = source(previous)
  const after = source(next)
  return before.kind !== after.kind || (before.kind !== 'native' && before.sourceId !== after.sourceId)
}
