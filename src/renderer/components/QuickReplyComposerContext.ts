import { createContext } from 'react'

export const QuickReplyComposerContext = createContext<{ sessionId: string; selection?: { text: string; nonce: number }; onConsumed?: (nonce: number) => void } | null>(null)
