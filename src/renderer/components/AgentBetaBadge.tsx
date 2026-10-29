export function AgentBetaBadge({ agentId }: { agentId: string }): JSX.Element | null {
  if (agentId === 'codex' || agentId === 'traex') return null
  return <span className="agent-beta-badge">BETA</span>
}
