import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EventStream } from '../../src/renderer/components/EventStream'

// Click the real step/history disclosures, retaining their state between SSR passes.
// Other hooks use React's server dispatcher, including the real team context.
export function renderOpenChains(element: React.ReactElement<any>, options: { processed?: boolean } = {}): string {
  const dispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
  const states = new Map<string, any[]>()
  let clicks: Array<() => void> = []
  const wrap = (node: React.ReactNode, path = 'root'): React.ReactNode => {
    if (Array.isArray(node)) return node.map((child, i) => wrap(child, `${path}/${i}`))
    if (!React.isValidElement<any>(node)) return node
    const Original: any = node.type
    const props = { ...node.props, children: wrap(node.props.children, `${path}/children`) }
    if (typeof Original !== 'function') return React.cloneElement(node, props)
    const Component = () => {
      const previous = dispatcher.current
      const slots = states.get(path) || []
      states.set(path, slots)
      let index = 0
      const retainState = ['EventStream', 'ProcessStepRow', 'ProcessStageFold'].includes(Original.name) || options.processed && Original.name === 'ProcessedFold'
      if (retainState) dispatcher.current = {
        ...previous,
        useState(initial: any) {
          const slot = index++
          if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial
          return [slots[slot], (next: any) => { slots[slot] = typeof next === 'function' ? next(slots[slot]) : next }]
        }
      }
      let tree: React.ReactNode
      try { tree = Original(props) } finally { dispatcher.current = previous }
      const collect = (child: React.ReactNode): void => {
        React.Children.forEach(child, item => {
          if (!React.isValidElement<any>(item)) return
          if (item.type === 'button' && item.props['aria-expanded'] === false &&
              ['process-step-meta', 'steps-fold-row'].includes(item.props.className)) clicks.push(item.props.onClick)
          if (options.processed && item.type === 'div' && item.props.className === 'processed-fold closed') {
            const head = React.Children.toArray(item.props.children).find((node: any) => node.props?.className === 'processed-head') as React.ReactElement<any> | undefined
            if (head) clicks.push(head.props.onClick)
          }
          collect(item.props.children)
        })
      }
      collect(tree)
      return wrap(tree, `${path}/output`)
    }
    return React.createElement(Component, { key: node.key })
  }
  for (let pass = 0; pass < 8; pass++) {
    clicks = []
    const markup = renderToStaticMarkup(wrap(element) as React.ReactElement)
    if (!clicks.length) return markup
    for (const click of clicks) click()
  }
  throw new Error('disclosures did not settle after eight render passes')
}
