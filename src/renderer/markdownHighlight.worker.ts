import { code, type HighlightOptions } from '@streamdown/code'

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; options: HighlightOptions }>) => void) | null
  postMessage: (value: unknown) => void
}
scope.onmessage = ({ data: { id, options } }) => {
  const send = (result: ReturnType<typeof code.highlight>): void => {
    if (!result) return
    // Grammar state contains engine objects; only display tokens cross the worker boundary.
    const { grammarState: _grammarState, ...display } = result
    scope.postMessage({ id, result: display })
  }
  const cached = code.highlight(options, send)
  if (cached) send(cached)
}
