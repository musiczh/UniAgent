/** Codex reports a rollout recorded under one model being resumed with another. */
export function resumeModelMismatch(text: unknown): { recorded: string; resuming: string } | null {
  if (typeof text !== 'string') return null
  const match = /^This session was recorded with model `([^`]+)` but is resuming with `([^`]+)`\./.exec(text)
  return match ? { recorded: match[1], resuming: match[2] } : null
}

/** Provider guidance belongs in the conversation, not the runtime error report. */
export function isConversationHint(text: unknown): boolean {
  return typeof text === 'string' && (
    text.startsWith('Heads up: Long threads and multiple compactions can cause the model to be less accurate.') ||
    text.startsWith('Skill descriptions were shortened to fit the ') ||
    resumeModelMismatch(text) !== null
  )
}

/** Local trust setup is intentionally managed outside the conversation UI. */
export function isHiddenAgentWarning(text: unknown): boolean {
  return typeof text === 'string' && text.startsWith(
    'Project-local config, hooks, and exec policies are disabled in the following folders until the project is trusted'
  )
}
