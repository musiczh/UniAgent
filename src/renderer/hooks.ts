import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { Attachment, PickedFile, PrefsData, SessionStatus } from '@shared/types'
import type { ComposerKeyEvent, ComposerPasteEvent, MarkdownInputHandle, MarkdownSlashMatch } from './markdownInput'
export { detectSlash } from './markdownInput'
import {
  emptyNativeCapabilitySnapshot,
  withMcpStartupStatus,
  type NativeCandidate,
  type NativeMcpStatusChange,
  type NativeCapabilitySnapshot
} from '@shared/nativeCapabilities'

export function useSessionAttention(sessionId: string | null): void {
  useEffect(() => {
    void window.uniagent.setBadgeVisibleSession(sessionId).catch(error => console.warn('[session-badge]', error))
  }, [sessionId])
}

export function useAgentPreferences(): PrefsData | null {
  const [prefs, setPrefs] = useState<PrefsData | null>(null)
  useEffect(() => {
    let active = true
    let pushed = false
    const stop = window.uniagent.onPrefsChanged(value => { pushed = true; setPrefs(value) })
    void window.uniagent.getPrefs().then(value => { if (active && !pushed) setPrefs(value) }).catch(() => {})
    return () => { active = false; stop() }
  }, [])
  return prefs
}

// Bound retained data URLs across sessions; evicted previews reload from disk.
const attachmentPreviewCache = new Map<string, string>()
const ATTACHMENT_CACHE_BYTES = 32 * 1024 * 1024
let attachmentPreviewBytes = 0

export function getCachedAttachmentPreview(path: string): string | undefined {
  const preview = attachmentPreviewCache.get(path)
  if (preview) {
    attachmentPreviewCache.delete(path)
    attachmentPreviewCache.set(path, preview)
  }
  return preview
}

export function cacheAttachmentPreview(path: string, dataUrl?: string): void {
  if (!dataUrl) return
  const previous = attachmentPreviewCache.get(path)
  if (previous) attachmentPreviewBytes -= previous.length * 2
  attachmentPreviewCache.delete(path)
  // Count UTF-16 conservatively; Chromium may store base64 in one-byte strings.
  const bytes = dataUrl.length * 2
  if (bytes > ATTACHMENT_CACHE_BYTES) return
  attachmentPreviewBytes += bytes
  attachmentPreviewCache.set(path, dataUrl)
  while (attachmentPreviewBytes > ATTACHMENT_CACHE_BYTES || attachmentPreviewCache.size > 128) {
    const oldest = attachmentPreviewCache.keys().next().value!
    attachmentPreviewBytes -= attachmentPreviewCache.get(oldest)!.length * 2
    attachmentPreviewCache.delete(oldest)
  }
}

/**
 * Auto-grow a textarea with its content, capped at `maxRatio` of the window
 * height (Doc1 需求1 — 输入框高度自适应，最高 1/3 窗高). Shrinks back down when
 * text is deleted. Recomputes on value, window, and textarea width changes.
 */
export function useAutoResize(
  ref: RefObject<HTMLTextAreaElement>,
  value: string,
  maxRatio = 1 / 3,
  minPx = 0
): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let width = 0
    const resize = (): void => {
      width = el.getBoundingClientRect().width
      if (!width) return
      const max = Math.round(window.innerHeight * maxRatio)
      // Measuring the live field at auto height clamps the transcript's scrollTop.
      const measure = el.cloneNode(false) as HTMLTextAreaElement
      measure.removeAttribute('id')
      measure.removeAttribute('autofocus')
      measure.tabIndex = -1
      measure.setAttribute('aria-hidden', 'true')
      Object.assign(measure.style, {
        position: 'fixed',
        visibility: 'hidden',
        pointerEvents: 'none',
        width: width + 'px',
        height: 'auto',
        overflowY: 'hidden'
      })
      measure.value = el.value
      el.after(measure)
      const contentHeight = measure.scrollHeight
      measure.remove()
      const next = Math.min(Math.max(contentHeight, minPx), max) + 'px'
      if (el.style.height !== next) el.style.height = next
      // Only scroll internally once we've hit the cap.
      const overflow = contentHeight > max ? 'auto' : 'hidden'
      if (el.style.overflowY !== overflow) el.style.overflowY = overflow
    }
    resize()
    const observer = new ResizeObserver(() => {
      if (el.getBoundingClientRect().width !== width) resize()
    })
    observer.observe(el)
    window.addEventListener('resize', resize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', resize)
    }
  }, [ref, value, maxRatio, minPx])
}

/**
 * Shared `/`-palette + skill-chip state for a prompt field (G2-6 + G2-7). Drives
 * the SlashMenu from the caret position, keeps the arrow-key active index, and
 * tracks the set of picked skills/MCPs as removable chips (codex-style). Picking
 * a candidate strips the `/token` and adds a chip instead of inlining a mention,
 * so the field stays clean and the selection is structured.
 */
export function useSlashField(
  editorRef: RefObject<MarkdownInputHandle>,
  candidates: NativeCandidate[]
): {
  slash: { start: number; end: number; query: string } | null
  slashOpen: boolean
  slashHits: NativeCandidate[]
  activeIndex: number
  setActiveIndex: (n: number) => void
  selectedIds: string[]
  setSelectedIds: React.Dispatch<React.SetStateAction<string[]>>
  pick: (c: NativeCandidate) => void
  removeCandidate: (id: string) => void
  closeSlash: () => void
  onKeyDownSlash: (e: ComposerKeyEvent) => boolean
  onSelectionChange: (match: MarkdownSlashMatch | null) => void
} {
  const [activeIndex, setActiveIndex] = useState(0)
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  const [slash, setSlash] = useState<MarkdownSlashMatch | null>(null)
  const onSelectionChange = useCallback((match: MarkdownSlashMatch | null) => {
    setSlash(current => current?.start === match?.start && current?.end === match?.end && current?.query === match?.query ? current : match)
  }, [])
  const slashOpen = slash != null
  const slashHits = useMemo(
    () => (slashOpen ? filterNativeCandidates(candidates, slash!.query) : []),
    [slashOpen, candidates, slash]
  )

  useEffect(() => setActiveIndex(0), [slash?.query])

  const closeSlash = useCallback(() => {
    // Strip the `/query` fragment entirely so the palette closes cleanly.
    if (!slash) return
    editorRef.current?.replaceSlash(slash, '')
  }, [slash, editorRef])

  const pick = useCallback(
    (c: NativeCandidate) => {
      if (!slash) return
      const replacement = applySlashCandidatePick('', { start: 0, end: 0 }, c).text
      editorRef.current?.replaceSlash(slash, replacement)
      if (c.kind !== 'command') {
        setSelectedIds((current) => addNativeCandidateId(current, c.id))
      }
      editorRef.current?.focus()
    },
    [slash, editorRef]
  )

  const removeCandidate = useCallback((id: string) => {
    setSelectedIds((current) => current.filter((candidateId) => candidateId !== id))
  }, [])

  const onKeyDownSlash = useCallback(
    (e: ComposerKeyEvent): boolean => {
      if (!slashOpen || slashHits.length === 0) return false
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % slashHits.length)
        return true
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + slashHits.length) % slashHits.length)
        return true
      }
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault()
        pick(slashHits[activeIndex])
        return true
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        closeSlash()
        return true
      }
      return false
    },
    [slashOpen, slashHits, activeIndex, pick, closeSlash]
  )

  return {
    slash,
    slashOpen,
    slashHits,
    activeIndex,
    setActiveIndex,
    selectedIds,
    setSelectedIds,
    pick,
    removeCandidate,
    closeSlash,
    onKeyDownSlash,
    onSelectionChange
  }
}

/** Filter helper shared by the slash palette + keyboard handler. */
export function filterNativeCandidates(candidates: NativeCandidate[], query: string): NativeCandidate[] {
  const q = query.toLowerCase()
  return candidates.filter(
    (c) => c.name.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q)
  )
}

export function addNativeCandidateId(current: readonly string[], id: string): string[] {
  return current.includes(id) ? [...current] : [...current, id]
}

export function applySlashCandidatePick(
  text: string,
  slash: { start: number; end: number },
  candidate: NativeCandidate
): { text: string; caret: number } {
  if (candidate.kind !== 'command') {
    const next = text.slice(0, slash.start) + text.slice(slash.end)
    return { text: next, caret: slash.start }
  }
  const insertion = `${candidate.command} `
  const next = text.slice(0, slash.start) + insertion + text.slice(slash.end)
  return { text: next, caret: slash.start + insertion.length }
}

export function retainNativeCandidateIds(
  selectedIds: readonly string[],
  candidates: readonly NativeCandidate[]
): string[] {
  const available = new Set(candidates.map((candidate) => candidate.id))
  return selectedIds.filter((id) => available.has(id))
}

export function buildNativeCapabilityScope(
  agentId: string | null | undefined,
  workdir: string | null | undefined,
  sessionId?: string
): string {
  return `${agentId || ''}::${workdir || ''}::${sessionId || ''}`
}

export function nativeCapabilityChangeMatches(
  change: { agentId: string; workdir: string; sessionId?: string },
  agentId: string,
  workdir: string,
  sessionId?: string
): boolean {
  return change.agentId === agentId &&
    change.workdir === workdir &&
    (!change.sessionId || change.sessionId === sessionId)
}

export function shouldApplyNativeCapabilityResponse(
  currentScope: string,
  responseScope: string,
  currentGeneration: number,
  responseGeneration: number
): boolean {
  return currentScope === responseScope && currentGeneration === responseGeneration
}

export function rollbackOptimisticSessionStatus(
  current: Record<string, SessionStatus>,
  sessionId: string,
  previousStatus: SessionStatus | undefined
): Record<string, SessionStatus> {
  if (current[sessionId] !== 'running') return current
  const next = { ...current }
  if (previousStatus === undefined) delete next[sessionId]
  else next[sessionId] = previousStatus
  return next
}

/** Load one provider-native capability snapshot with scope and generation guards. */
export function useNativeCapabilities(
  agentId: string | null | undefined,
  workdir: string | null | undefined,
  sessionId?: string
): { snapshot: NativeCapabilitySnapshot; ready: boolean } {
  const normalizedAgentId = agentId || ''
  const normalizedWorkdir = workdir || ''
  const scope = buildNativeCapabilityScope(normalizedAgentId, normalizedWorkdir, sessionId)
  const requestRef = useRef({ scope, generation: 0 })
  const mcpStatuses = useRef({ scope, values: new Map<string, NativeMcpStatusChange>() })
  if (mcpStatuses.current.scope !== scope) mcpStatuses.current = { scope, values: new Map() }
  const [snapshot, setSnapshot] = useState<NativeCapabilitySnapshot>(() =>
    emptyNativeCapabilitySnapshot(normalizedAgentId, normalizedWorkdir)
  )
  const [ready, setReady] = useState(false)

  const load = useCallback((force = false) => {
    const requestScope = buildNativeCapabilityScope(normalizedAgentId, normalizedWorkdir, sessionId)
    const requestGeneration = requestRef.current.generation + 1
    requestRef.current = { scope: requestScope, generation: requestGeneration }
    setSnapshot(emptyNativeCapabilitySnapshot(normalizedAgentId, normalizedWorkdir))
    setReady(false)
    if (!normalizedAgentId || !normalizedWorkdir) {
      setReady(true)
      return
    }
    void window.uniagent
      .getNativeCapabilities({
        agentId: normalizedAgentId,
        workdir: normalizedWorkdir,
        ...(sessionId ? { sessionId } : {}),
        ...(force ? { force: true } : {})
      })
      .then((next) => {
        if (shouldApplyNativeCapabilityResponse(
          requestRef.current.scope,
          requestScope,
          requestRef.current.generation,
          requestGeneration
        )) {
          setSnapshot({ ...next, candidates: next.candidates.map(candidate => {
            const status = mcpStatuses.current.values.get(candidate.name)
            return candidate.kind === 'mcp' && status ? withMcpStartupStatus(candidate, status) : candidate
          }) })
          setReady(true)
        }
      })
      .catch((error: unknown) => {
        if (!shouldApplyNativeCapabilityResponse(
          requestRef.current.scope,
          requestScope,
          requestRef.current.generation,
          requestGeneration
        )) return
        const message = error instanceof Error ? error.message : String(error)
        setSnapshot({
          ...emptyNativeCapabilitySnapshot(normalizedAgentId, normalizedWorkdir),
          errors: [message]
        })
        setReady(true)
      })
  }, [normalizedAgentId, normalizedWorkdir, sessionId])

  useEffect(() => load(false), [load])

  useEffect(() => window.uniagent.onNativeCapabilitiesChanged((change) => {
    if (nativeCapabilityChangeMatches(
      change,
      normalizedAgentId,
      normalizedWorkdir,
      sessionId
    )) {
      if (change.mcpStatus) {
        const status = change.mcpStatus
        mcpStatuses.current.values.set(status.name, status)
        setSnapshot(current => ({ ...current, candidates: current.candidates.map(candidate =>
          candidate.kind === 'mcp' && candidate.name === status.name ? withMcpStartupStatus(candidate, status) : candidate
        ) }))
      } else {
        load(true)
      }
    }
  }), [load, normalizedAgentId, normalizedWorkdir, sessionId])

  const snapshotMatchesScope =
    snapshot.agentId === normalizedAgentId && snapshot.workdir === normalizedWorkdir
  const visibleSnapshot = useMemo(
    () => snapshotMatchesScope
      ? snapshot
      : emptyNativeCapabilitySnapshot(normalizedAgentId, normalizedWorkdir),
    [normalizedAgentId, normalizedWorkdir, snapshot, snapshotMatchesScope]
  )
  return { snapshot: visibleSnapshot, ready: ready && snapshotMatchesScope }
}

/**
 * Shared attachment state (需求5). Both the Composer and the initial NewTaskPanel
 * let the user attach images/files: pick from disk, paste an image from the
 * clipboard, and remove chips. Extracted here so the two inputs behave
 * identically instead of the New-Task box lacking attachment support.
 */
export function useAttachments(options?: { enabled?: boolean; onUnsupported?: () => void }): {
  attachments: Attachment[]
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>
  addFiles: () => Promise<void>
  addPickedFiles: (files: PickedFile[]) => void
  replacePickedFiles: (files: PickedFile[]) => void
  pasteImage: (e: ComposerPasteEvent) => Promise<void>
  removeAttachment: (index: number) => void
  clearAttachments: () => void
  /**
   * 需求（附件预览）— safe in-renderer `data:` previews keyed by attachment path.
   * Clipboard pixels are encoded in the renderer; file-dialog previews arrive
   * with the selected attachment and are stripped before agent submission.
   */
  previews: Record<string, string>
} {
  const [attachmentState, setAttachmentState] = useState<{
    attachments: Attachment[]
    previews: Record<string, string>
  }>({ attachments: [], previews: {} })
  const enabled = options?.enabled !== false
  const onUnsupported = options?.onUnsupported
  const enabledRef = useRef(enabled)
  const generationRef = useRef(0)
  if (enabledRef.current !== enabled) {
    enabledRef.current = enabled
    generationRef.current += 1
  }
  useLayoutEffect(() => {
    if (!enabled) {
      setAttachmentState((current) =>
        current.attachments.length === 0 && Object.keys(current.previews).length === 0
          ? current
          : { attachments: [], previews: {} }
      )
    }
  }, [enabled])

  const setAttachments = useCallback<React.Dispatch<React.SetStateAction<Attachment[]>>>((update) => {
    setAttachmentState((current) => {
      const attachments = typeof update === 'function'
        ? update(current.attachments)
        : update
      if (attachments === current.attachments) return current
      return {
        attachments,
        previews: retainAttachmentPreviews(current.previews, attachments)
      }
    })
  }, [])

  const addPickedFiles = useCallback((files: PickedFile[]) => {
    if (!files.length) return
    files.forEach(({ path, previewDataUrl }) => cacheAttachmentPreview(path, previewDataUrl))
    setAttachmentState((current) => ({
      attachments: [
        ...current.attachments,
        ...files.map(({ previewDataUrl: _preview, ...attachment }) => attachment)
      ],
      previews: Object.fromEntries([
        ...Object.entries(current.previews),
        ...files.flatMap(({ path, previewDataUrl }) => previewDataUrl ? [[path, previewDataUrl]] : [])
      ])
    }))
  }, [])

  const replacePickedFiles = useCallback((files: PickedFile[]) => {
    files.forEach(({ path, previewDataUrl }) => cacheAttachmentPreview(path, previewDataUrl))
    setAttachmentState({
      attachments: files.map(({ previewDataUrl: _preview, ...attachment }) => attachment),
      previews: Object.fromEntries(
        files.flatMap(({ path, previewDataUrl }) => previewDataUrl ? [[path, previewDataUrl]] : [])
      )
    })
  }, [])

  const addFiles = useCallback(async () => {
    if (!enabled) {
      onUnsupported?.()
      return
    }
    const generation = generationRef.current
    const files = await window.uniagent.pickFiles()
    if (!enabledRef.current || generationRef.current !== generation) return
    addPickedFiles(files)
  }, [addPickedFiles, enabled, onUnsupported])

  const pasteImage = useCallback(async (e: ComposerPasteEvent) => {
    if (!e.clipboardData) return
    const imageItem = Array.from(e.clipboardData.items).find((it) => it.type.startsWith('image/'))
    const imageFile = Array.from(e.clipboardData.files).find((file) =>
      file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(file.name)
    )
    if (!imageItem && !imageFile) return
    e.preventDefault()
    if (!enabled) {
      onUnsupported?.()
      return
    }
    // Capture the blob synchronously — clipboardData is cleared after the await.
    const blob = imageItem?.getAsFile() || imageFile
    const dataUrl = blob ? await blobToDataUrl(blob) : undefined
    const generation = generationRef.current
    const att = await window.uniagent.saveClipboardImage(dataUrl)
    if (!enabledRef.current || generationRef.current !== generation) return
    if (att) {
      cacheAttachmentPreview(att.path, dataUrl)
      setAttachmentState((current) => ({
        attachments: [...current.attachments, att],
        // Safe preview: the renderer already holds the pixels, so encode a
        // `data:` URL (permitted by CSP) instead of loading file:// off disk.
        previews: dataUrl
          ? { ...current.previews, [att.path]: dataUrl }
          : current.previews
      }))
    }
  }, [enabled, onUnsupported])

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, j) => j !== index))
  }, [])

  const clearAttachments = useCallback(() => {
    setAttachmentState({ attachments: [], previews: {} })
  }, [])

  return {
    attachments: attachmentState.attachments,
    setAttachments,
    addFiles,
    addPickedFiles,
    replacePickedFiles,
    pasteImage,
    removeAttachment,
    clearAttachments,
    previews: attachmentState.previews
  }
}

/** Drop previews whose attachment no longer exists. */
export function retainAttachmentPreviews(
  previews: Record<string, string>,
  attachments: readonly Attachment[]
): Record<string, string> {
  const paths = new Set(attachments.map((attachment) => attachment.path))
  return Object.fromEntries(Object.entries(previews).filter(([path]) => paths.has(path)))
}

/** Give native <details> menus the expected outside-click and Escape behavior. */
export function useDismissableDetails(
  root: RefObject<HTMLElement>
): void {
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      closeOpenDetails(root.current, event.target as Node)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeOpenDetails(root.current)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [root])
}

function closeOpenDetails(root: HTMLElement | null, keepTarget?: Node): void {
  root?.querySelectorAll('details[open]').forEach((detail) => {
    if (!keepTarget || !detail.contains(keepTarget)) detail.removeAttribute('open')
  })
}

/** Turn an absolute path into an Attachment, guessing image vs file by ext. */
export function pathToAttachment(path: string): Attachment {
  const name = path.split('/').pop() || path
  const isImg = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)
  return { kind: isImg ? 'image' : 'file', path, name }
}

/** Read a clipboard image blob into a CSP-safe `data:` URL for preview. */
function blobToDataUrl(blob: Blob): Promise<string | undefined> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined)
    reader.onerror = () => resolve(undefined)
    reader.readAsDataURL(blob)
  })
}
