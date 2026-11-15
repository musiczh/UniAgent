import type { Session, SessionConfig } from '../shared/types'

let prepare: ((session: Session) => Promise<void>) | undefined
export function configureProjectMemoryRuntime(provider?: typeof prepare): void { prepare = provider }
export function hasProjectMemoryContext(config: SessionConfig): boolean { return !!prepare && !!config.projectId && !config.managedPurpose }
export async function prepareProjectMemory(session: Session): Promise<void> {
  if (hasProjectMemoryContext(session.config)) await prepare!(session)
}
