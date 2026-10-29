import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { MarkdownEditorController } from '../markdownEditor'
import { detectSlash, type ComposerPasteEvent, type MarkdownInputHandle, type MarkdownSlashMatch } from '../markdownInput'
import { continueMarkdownList } from '../listContinuation'
import { useAutoResize } from '../hooks'

interface Props {
  value: string
  onChange: (value: string) => void
  onKeyDown: (event: KeyboardEvent) => void
  onPaste?: (event: ComposerPasteEvent) => void
  onSelectionChange: (match: MarkdownSlashMatch | null) => void
  className: string
  placeholder: string
  disabled?: boolean
  autoFocus?: boolean
  minHeight?: number
}

/** Load the editing engine after the lightweight, usable input has painted. */
export const MarkdownEditor = forwardRef<MarkdownInputHandle, Props>(function MarkdownEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null)
  const fallback = useRef<HTMLTextAreaElement>(null)
  const controller = useRef<MarkdownEditorController>()
  const composing = useRef(false)
  const latest = useRef(props)
  latest.current = props
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState(false)
  useAutoResize(fallback, props.value, 1 / 3, props.minHeight || 46)

  useImperativeHandle(ref, () => ({
    focus(position) {
      if (controller.current) controller.current.focus(position)
      else {
        fallback.current?.focus()
        if (position === 'end' && fallback.current) fallback.current.setSelectionRange(fallback.current.value.length, fallback.current.value.length)
      }
    },
    clear() {
      controller.current?.clear()
      latest.current.onChange('')
    },
    replaceSlash(match, replacement) {
      if (controller.current) controller.current.replaceSlash(match, replacement)
      else if (fallback.current) {
        const value = fallback.current.value
        const next = value.slice(0, match.start) + replacement + value.slice(match.end)
        latest.current.onChange(next)
        requestAnimationFrame(() => {
          fallback.current?.focus()
          fallback.current?.setSelectionRange(match.start + replacement.length, match.start + replacement.length)
        })
      }
    }
  }), [])

  useEffect(() => {
    let active = true
    const failed = (error: unknown) => {
      if (!active) return
      console.error('Markdown editor failed to load', error)
      setLoadError(true)
    }
    void import('../markdownEditor').then(({ createMarkdownEditor }) => {
      const mount = () => {
        if (!active || !host.current) return
        if (composing.current) { requestAnimationFrame(mount); return }
        try {
          const shouldFocus = document.activeElement === fallback.current
          controller.current = createMarkdownEditor({
            element: host.current,
            value: latest.current.value,
            disabled: latest.current.disabled,
            placeholder: latest.current.placeholder,
            onChange: value => latest.current.onChange(value),
            onSelectionChange: match => latest.current.onSelectionChange(match),
            onKeyDown: event => latest.current.onKeyDown(event),
            onPaste: event => latest.current.onPaste?.(event)
          })
          setReady(true)
          if (shouldFocus) requestAnimationFrame(() => { if (active) controller.current?.focus('end') })
        } catch (error) { failed(error) }
      }
      mount()
    }).catch(failed)
    return () => { active = false; controller.current?.destroy(); controller.current = undefined }
  }, [])

  useLayoutEffect(() => { controller.current?.setValue(props.value) }, [props.value])
  useLayoutEffect(() => {
    controller.current?.setOptions(!!props.disabled, props.placeholder)
  }, [props.disabled, props.placeholder])

  return <div className={`markdown-editor ${props.className}`} style={{ '--editor-min-height': `${props.minHeight || 46}px` } as React.CSSProperties}>
    <div ref={host} hidden={!ready} />
    {!ready && <textarea
      ref={fallback}
      className="markdown-editor-fallback"
      value={props.value}
      placeholder={props.placeholder}
      aria-label={props.placeholder}
      disabled={props.disabled}
      autoFocus={props.autoFocus}
      onCompositionStart={() => { composing.current = true }}
      onCompositionEnd={() => { composing.current = false }}
      onChange={event => props.onChange(event.target.value)}
      onSelect={event => props.onSelectionChange(detectSlash(event.currentTarget.value, event.currentTarget.selectionStart))}
      onPaste={props.onPaste}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return
        props.onKeyDown(event.nativeEvent)
        if (event.defaultPrevented || event.nativeEvent.defaultPrevented || event.key !== 'Enter' || event.shiftKey) return
        const input = event.currentTarget
        const next = continueMarkdownList(input.value, input.selectionStart, input.selectionEnd)
        if (!next) return
        event.preventDefault()
        props.onChange(next.value)
        requestAnimationFrame(() => input.setSelectionRange(next.caret, next.caret))
      }}
      rows={2}
    />}
    {loadError && <div className="composer-send-error" role="status">Markdown 编辑器加载失败，当前仍可输入和发送纯文本。</div>}
  </div>
})
