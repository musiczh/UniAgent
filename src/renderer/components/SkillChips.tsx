import type {
  ComposerCommand,
  NativeCandidate,
  ResolvedNativeTurnContext
} from '@shared/nativeCapabilities'
import { UiIcon } from './Icons'

function NativeCapabilityChip({
  kind,
  name,
  title,
  candidateId,
  onRemove
}: {
  kind: NativeCandidate['kind']
  name: string
  title?: string
  candidateId?: string
  onRemove?: () => void
}): JSX.Element {
  return (
    <span
      className={`capability-chip capability-chip-${kind}`}
      {...(candidateId ? { 'data-candidate': candidateId } : {})}
      title={title || name}
    >
      <span className="capability-chip-kind">
        <UiIcon name={kind === 'mcp' ? 'plug' : 'sparkles'} size={12} />
        {kind === 'mcp' ? 'MCP' : kind === 'command' ? 'Command' : 'Skill'}
      </span>
      <span className="capability-chip-name">{name}</span>
      {onRemove && (
        <button
          type="button"
          className="capability-chip-x"
          onClick={onRemove}
          title="移除"
          aria-label={`移除 ${name}`}
        >
          <UiIcon name="close" size={11} />
        </button>
      )}
    </span>
  )
}

function CommandCapabilityChip({
  command,
  onRemove
}: {
  command: ComposerCommand
  onRemove?: () => void
}): JSX.Element {
  const label = command === 'goal' ? 'Goal' : 'Plan'
  return (
    <span
      className={`capability-chip composer-command-chip composer-command-${command}`}
      data-command={command}
    >
      <span className="capability-chip-kind">
        <UiIcon name={command === 'goal' ? 'target' : 'templates'} size={12} />
        命令
      </span>
      <span className="capability-chip-name">{label}</span>
      {onRemove && (
        <button
          type="button"
          className="capability-chip-x"
          onClick={onRemove}
          title="移除"
          aria-label={`移除 ${command}`}
        >
          <UiIcon name="close" size={11} />
        </button>
      )}
    </span>
  )
}

export function replaceComposerCommand(
  _current: ComposerCommand | null,
  next: ComposerCommand
): ComposerCommand {
  return next
}

/** One ordered capability row: the unique command is always first. */
export function ComposerCapabilityChips({
  command,
  candidates,
  onRemoveCommand,
  onRemoveCandidate
}: {
  command: ComposerCommand | null
  candidates: NativeCandidate[]
  onRemoveCommand: () => void
  onRemoveCandidate: (id: string) => void
}): JSX.Element | null {
  if (!command && candidates.length === 0) return null
  return (
    <div className="composer-capability-chips">
      {command && (
        <CommandCapabilityChip command={command} onRemove={onRemoveCommand} />
      )}
      {candidates.filter((candidate) => candidate.kind !== 'command').map((candidate) => (
        <NativeCapabilityChip
          key={candidate.id}
          kind={candidate.kind}
          name={candidate.name}
          title={candidate.description || candidate.name}
          candidateId={candidate.id}
          onRemove={() => onRemoveCandidate(candidate.id)}
        />
      ))}
    </div>
  )
}

/** Read-only snapshot of the Skill/MCP selections attached to a sent turn. */
export function SentCapabilityChips({
  context,
  command
}: {
  context?: ResolvedNativeTurnContext
  command?: ComposerCommand
}): JSX.Element | null {
  const skills = Array.isArray(context?.skills)
    ? context.skills.filter((skill) => !!skill?.name)
    : []
  const mcpServers = Array.isArray(context?.mcpServers)
    ? context.mcpServers.filter((server) => !!server?.name)
    : []
  if (!command && skills.length === 0 && mcpServers.length === 0) return null

  return (
    <div className="composer-capability-chips bubble-capability-chips" aria-label="本消息使用的能力">
      {command && (
        <CommandCapabilityChip command={command} />
      )}
      {skills.map((skill, index) => (
        <NativeCapabilityChip
          key={`skill:${skill.path}:${index}`}
          kind="skill"
          name={skill.name}
          title={skill.path}
        />
      ))}
      {mcpServers.map((server, index) => (
        <NativeCapabilityChip
          key={`mcp:${server.name}:${index}`}
          kind="mcp"
          name={server.name}
        />
      ))}
    </div>
  )
}
