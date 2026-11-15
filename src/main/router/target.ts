import { createHash } from 'node:crypto'
import type { Session } from '../../shared/types'
import { taskRequestFingerprint } from '../../shared/taskRequest'
import { taskInputRevision } from '../../shared/taskLifecycle'

export function routerTargetVersion(session: Session): string {
  return createHash('sha256').update(taskRequestFingerprint({ id: session.id, config: session.config,
    archived: session.archived === true, readOnly: session.readOnly === true, phase: session.taskState?.phase, inputRevision: taskInputRevision(session) })).digest('hex')
}
