import { createHash } from 'node:crypto'
import type { SubmittedUserMessage, UAEvent } from '../shared/types.ts'
import { stripAssistantContext } from './assistant/context'

export const submittedTextHash = (text: unknown): string =>
  createHash('sha256').update(String(text ?? '')).digest('hex')

/**
 * Re-attach the local submission record to the matching restored native user
 * message. Matching by ordinal *and* the visible-text hash keeps provider-
 * generated context (assistant wrappers, tool notices) from impersonating a
 * user bubble; a mismatch deliberately leaves the native text as-is.
 */
export function hydrateSubmittedUserMessages(
  events: UAEvent[],
  submitted: readonly SubmittedUserMessage[] | undefined
): UAEvent[] {
  if (!submitted?.length) return events
  const hydrated = [...events]
  const byOrdinal = new Map(submitted.map((snapshot) => [snapshot.userOrdinal, snapshot]))
  let userOrdinal = -1
  for (let eventIndex = 0; eventIndex < hydrated.length; eventIndex++) {
    const event = hydrated[eventIndex]
    if (event.type !== 'user_message' && event.type !== 'goal_message') continue
    userOrdinal++
    const snapshot = byOrdinal.get(userOrdinal)
    const nativeText = String(event.payload?.text || '')
    let text = snapshot?.assistantText !== undefined ? stripAssistantContext(nativeText) : nativeText
    // Claude's adapter folds attachment paths into the prompt text because its
    // native faces have no image flag. That copy is duplicate bookkeeping: the
    // snapshot already carries the attachments, so strip it before matching and
    // rendering (assistant sessions and native sessions alike).
    let strippedAttachmentSuffix = false
    if (snapshot?.attachments?.length) {
      const suffix = `\n\n附件:\n${snapshot.attachments.map(attachment => `- ${attachment.path}`).join('\n')}`
      if (text.endsWith(suffix)) {
        text = text.slice(0, -suffix.length)
        strippedAttachmentSuffix = true
      }
    }
    if (
      !snapshot ||
      event.type !== snapshot.type ||
      submittedTextHash(text) !== snapshot.textHash
    ) continue
    hydrated[eventIndex] = {
        ...event,
        payload: {
          ...event.payload,
          ...(snapshot.assistantText === undefined
            ? (strippedAttachmentSuffix ? { text } : {})
            : { text: snapshot.assistantText }),
          ...(snapshot.assistantMessageId === undefined ? {} : { assistantMessageId: snapshot.assistantMessageId }),
          ...(snapshot.source === undefined ? {} : { source: snapshot.source }),
          ...(snapshot.command === undefined ? {} : { command: snapshot.command }),
          ...(snapshot.attachments === undefined ? {} : { attachments: structuredClone(snapshot.attachments) }),
          ...(snapshot.nativeContext === undefined ? {} : { nativeContext: structuredClone(snapshot.nativeContext) }),
          ...(snapshot.comments === undefined ? {} : { comments: structuredClone(snapshot.comments) }),
          ...(snapshot.displayText === undefined ? {} : { displayText: snapshot.displayText }),
          ...(snapshot.appendedToTurn ? { appendedToTurn: true } : {})
        }
      }
  }
  return hydrated
}
