import type { UAEvent } from './types'

export function viewImagePath(event: UAEvent): string | undefined {
  if (event.type !== 'tool_call' || !['view_image', 'viewImage'].includes(event.payload?.name)) return undefined
  let input = event.payload.input ?? event.payload.raw?.arguments
  if (typeof input === 'string') {
    try { input = JSON.parse(input) } catch { return undefined }
  }
  const path = input?.path
  return typeof path === 'string' && path.trim().length > 0 && !path.includes('\0') ? path : undefined
}

/** A native image block a tool returned: resolved from the provider log, not from disk. */
export interface NativeImageSelector {
  eventSeq: number
  blockIndex: number
  toolResult?: boolean
  childSessionId?: string
}

const selectorOf = (value: unknown): NativeImageSelector | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const { eventSeq, blockIndex, toolResult, childSessionId } = value as Record<string, unknown>
  if (typeof eventSeq !== 'number' || !Number.isSafeInteger(eventSeq) || eventSeq < 0) return undefined
  if (typeof blockIndex !== 'number' || !Number.isSafeInteger(blockIndex) || blockIndex < 0) return undefined
  if (toolResult !== undefined && typeof toolResult !== 'boolean') return undefined
  if (childSessionId !== undefined && (typeof childSessionId !== 'string' || !childSessionId.trim())) return undefined
  return { eventSeq, blockIndex, ...(toolResult ? { toolResult } : {}), ...(childSessionId ? { childSessionId } : {}) }
}

/** Tool-returned images ride on the call that produced them, so the row can preview them inline. */
export function nativeImageSelectors(event: UAEvent): NativeImageSelector[] {
  const images = event.type === 'tool_call' ? event.payload?.nativeImages : undefined
  return Array.isArray(images) ? images.flatMap((value) => { const selector = selectorOf(value); return selector ? [selector] : [] }) : []
}

/** Best-effort display name: the path the tool read, else the recorded attachment name. */
export function nativeImageName(event: UAEvent, selector: NativeImageSelector): string {
  let input = event.payload?.input ?? event.payload?.raw?.arguments
  if (typeof input === 'string') {
    try { input = JSON.parse(input) } catch { input = undefined }
  }
  const path = input?.file_path ?? input?.path
  if (typeof path === 'string' && path.trim()) return path.split(/[\\/]/).pop() || '图片'
  const content = event.payload?.content
  if (Array.isArray(content)) {
    const attachment = content[selector.blockIndex]?.attachment
    if (attachment && typeof attachment.name === 'string' && attachment.name.trim()) return attachment.name
  }
  return '图片'
}

/** Older projections split a tool-returned image into its own `image_generation`
 * event, which the timeline rendered as a standalone card between two steps.
 * Adopt those events back onto the call that produced them, so restored turns read
 * like live ones; an image whose call is no longer in the window keeps its card. */
export function adoptToolResultImages(events: UAEvent[]): UAEvent[] {
  const isLegacyToolImage = (event: UAEvent): boolean => event.type === 'tool_call'
    && event.payload?.name === 'image_generation' && event.payload?.result?.nativeImage?.toolResult === true
  if (!events.some(isLegacyToolImage)) return events
  const owners = new Map<number, number>()
  events.forEach((event, index) => {
    if (event.type !== 'tool_call' && event.type !== 'command_exec') return
    const seq = event.payload?.nativeEventSeq
    // The owning result precedes its image event, so the first event at a seq wins.
    if (typeof seq === 'number' && !owners.has(seq)) owners.set(seq, index)
  })
  const additions = new Map<number, NativeImageSelector[]>()
  const dropped = new Set<number>()
  events.forEach((event, index) => {
    if (!isLegacyToolImage(event)) return
    const nativeImage = event.payload.result.nativeImage
    const owner = owners.get(nativeImage.eventSeq)
    if (owner === undefined || owner >= index) return
    const selector = selectorOf({ eventSeq: nativeImage.eventSeq, blockIndex: nativeImage.blockIndex,
      toolResult: true, childSessionId: nativeImage.childSessionId })
    if (!selector) return
    const list = additions.get(owner) ?? []
    if (!list.some((item) => item.eventSeq === selector.eventSeq && item.blockIndex === selector.blockIndex)) list.push(selector)
    additions.set(owner, list)
    dropped.add(index)
  })
  if (dropped.size === 0) return events
  return events.flatMap((event, index) => {
    if (dropped.has(index)) return []
    const extra = additions.get(index)
    if (!extra) return [event]
    const existing = nativeImageSelectors(event)
    const merged = [...existing, ...extra.filter((item) =>
      !existing.some((known) => known.eventSeq === item.eventSeq && known.blockIndex === item.blockIndex))]
    return [{ ...event, payload: { ...event.payload, nativeImages: merged } }]
  })
}
