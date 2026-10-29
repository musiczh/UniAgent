// 选中即评论 — pure DOM helpers for capturing a text selection inside an agent
// reply and (re)applying persistent highlight <mark>s + numbered badges. Kept
// framework-free so it can be unit-tested and reused by EventStream without
// pulling React into the offset math.

import { resolveCommentAnchor, type CommentAnchor } from '@shared/comments'

export interface Annotation {
  anchor?: CommentAnchor
  number?: number
  hideBadge?: boolean
  id: string
  /** Absolute Markdown file path; file annotations use seq -1. */
  filePath?: string
  /** the agent reply event's seq this annotation belongs to */
  seq: number
  /** char offsets into the reply's `.agent-md` textContent, [start, end) */
  start: number
  end: number
  /** the selected text (== textContent.slice(start,end)) */
  quote: string
  /** the user's comment on that selection */
  comment: string
}

export interface CapturedSelection {
  seq: number
  start: number
  end: number
  quote: string
  /** Plain text of the complete agent message that owns the selection. */
  selectedMessageText: string
  rect: DOMRect
}

// Char offset of a (container, offset) DOM point within `root`, measured as the
// number of text characters that precede it (same metric applyAnnotations uses),
// so capture and re-apply agree exactly. Handles both Text and Element anchors.
function offsetIn(root: HTMLElement, container: Node, offset: number): number {
  const range = document.createRange()
  range.selectNodeContents(root)
  range.setEnd(container, offset)
  return textWithoutBadges(range.cloneContents()).length
}

// Badge numbers are UI, not part of the Markdown offsets used for highlights.
function textWithoutBadges(root: HTMLElement | DocumentFragment): string {
  const copy = root.cloneNode(true) as HTMLElement | DocumentFragment
  copy.querySelectorAll('.ua-anno-badge').forEach((badge) => badge.remove())
  return copy.textContent || ''
}

// The `.agent-md` reply element that fully contains the current selection, plus
// its owning event seq — or null when the selection escapes a single reply.
function replyElementFor(range: Range): { md: HTMLElement; seq: number } | null {
  const anchor = range.commonAncestorContainer
  const el = anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement
  const md = el?.closest('.agent-md') as HTMLElement | null
  if (!md) return null
  const seqEl = md.closest('[data-seq]') as HTMLElement | null
  if (!seqEl?.dataset.seq) return null
  return { md, seq: Number(seqEl.dataset.seq) }
}

/** Capture the live selection if it lands inside one annotatable agent reply. */
export function captureSelection(): CapturedSelection | null {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  const hit = replyElementFor(range)
  if (!hit) return null
  const start = offsetIn(hit.md, range.startContainer, range.startOffset)
  const end = offsetIn(hit.md, range.endContainer, range.endOffset)
  if (end <= start) return null
  const selectedMessageText = textWithoutBadges(hit.md)
  const quote = selectedMessageText.slice(start, end).trim()
  if (!quote) return null
  const rect = range.getBoundingClientRect()
  return { seq: hit.seq, start, end, quote, selectedMessageText, rect }
}

/** Remove any highlight marks / badges previously injected into a reply. */
export function stripAnnotations(root: HTMLElement): void {
  root.querySelectorAll('span.ua-anno-badge').forEach((b) => b.remove())
  root.querySelectorAll('mark.ua-annotation-hl').forEach((m) => {
    const parent = m.parentNode
    if (!parent) return
    while (m.firstChild) parent.insertBefore(m.firstChild, m)
    parent.removeChild(m)
  })
  root.normalize()
}

interface Seg {
  node: Text
  ls: number
  le: number
  globalStart: number
  planIdx: number
  isLast: boolean
}

// Collect the per-text-node slices a [start,end) range covers, without mutating.
function collectSegs(root: HTMLElement, start: number, end: number, planIdx: number): Seg[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const segs: Omit<Seg, 'isLast'>[] = []
  let off = 0
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = (n.nodeValue || '').length
    const s = Math.max(start, off)
    const e = Math.min(end, off + len)
    // Table separators count toward offsets, but wrapping them creates anonymous
    // table cells/rows and breaks the grid. Only wrap content inside the cells.
    const tableStructure = n.parentElement?.matches('table, thead, tbody, tfoot, tr, colgroup')
    if (s < e && !tableStructure) segs.push({ node: n as Text, ls: s - off, le: e - off, globalStart: s, planIdx })
    off += len
  }
  return segs.map((seg, i) => ({ ...seg, isLast: i === segs.length - 1 }))
}

/**
 * Re-apply the given annotations to a freshly-rendered reply element: wrap each
 * [start,end) range in a `<mark class="ua-annotation-hl">` and drop a numbered
 * badge after the last wrapped node. Idempotent — strips previous marks first.
 * Ranges are applied from the DOM end backwards so earlier offsets stay valid.
 */
export function applyAnnotations(root: HTMLElement, annotations: Annotation[], editable = false): void {
  stripAnnotations(root)
  if (!annotations.length) return
  // Badge numbers follow the comment list; segments still apply backwards.
  const sorted = annotations
  const plainText = annotations.some((annotation) => annotation.filePath || annotation.anchor) ? textWithoutBadges(root) : ''
  const marks: (HTMLElement | null)[] = sorted.map(() => null)
  const ranges: Array<{ start: number; end: number; index: number }> = []
  sorted.forEach((a, i) => {
    if (a.anchor) {
      const range = resolveCommentAnchor(plainText, a.anchor)
      if (range) ranges.push({ ...range, index: i })
      return
    }
    if (a.filePath && plainText.slice(a.start, a.end).trim() !== a.quote) return
    ranges.push({ start: a.start, end: a.end, index: i })
  })
  // Recollect text nodes for each range: overlapping comments can split nodes
  // already wrapped by another comment, while their text offsets remain stable.
  for (const range of ranges.sort((a, b) => b.start - a.start)) {
    for (const seg of collectSegs(root, range.start, range.end, range.index).reverse()) {
      let t: Text = seg.node
      if (seg.le < (t.nodeValue || '').length) t.splitText(seg.le)
      if (seg.ls > 0) t = t.splitText(seg.ls)
      const mark = document.createElement('mark')
      mark.className = 'ua-annotation-hl'
      if (sorted[seg.planIdx].anchor) mark.classList.add('ai-comment-highlight')
      mark.dataset.annoId = sorted[seg.planIdx].id
      if (editable) {
        mark.setAttribute('role', 'button')
        mark.setAttribute('aria-label', (sorted[seg.planIdx].anchor ? '打开侧边评论 ' : '编辑评论 ') + (sorted[seg.planIdx].number || seg.planIdx + 1))
        mark.tabIndex = 0
      }
      t.parentNode?.replaceChild(mark, t)
      mark.appendChild(t)
      if (seg.isLast) marks[seg.planIdx] = mark
    }
  }
  marks.forEach((mark, i) => {
    if (!mark || sorted[i].hideBadge) return
    const badge = document.createElement('span')
    badge.className = 'ua-anno-badge'
    badge.textContent = String(sorted[i].number || i + 1)
    if (sorted[i].anchor) badge.classList.add('ai-comment-badge')
    badge.dataset.annoId = sorted[i].id
    badge.title = sorted[i].anchor ? '打开侧边评论 ' + (sorted[i].number || i + 1) : sorted[i].comment || '待补充评论'
    if (editable) {
      badge.setAttribute('role', 'button')
      badge.setAttribute('aria-label', (sorted[i].anchor ? '打开侧边评论 ' : '编辑评论 ') + (sorted[i].number || i + 1))
      badge.tabIndex = 0
    }
    mark.after(badge)
  })
}
