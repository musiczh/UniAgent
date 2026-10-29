import { AGENT_ICON_DATA } from './components/agentIconData'

// Embed the shared brand bytes at build time so the boot page needs no image requests.
export function embedStartupIcons(markup: string): string {
  return markup.replace(/\{\{startup-icon:(\w+)\}\}/g, (_match, id: string) => {
    const icon = AGENT_ICON_DATA[id]
    if (!icon) throw new Error(`Missing startup icon: ${id}`)
    return icon
  })
}
