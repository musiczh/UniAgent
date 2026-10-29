export type ACPJsonRpcId = number | string | null

export type ACPJsonRpcMessage = {
  jsonrpc: '2.0'
  id?: ACPJsonRpcId
  method?: string
  params?: any
  result?: any
  error?: { code?: number; message?: string; data?: any }
}

export interface ACPInitialize {
  protocolVersion: number
  _meta?: Record<string, any>
  agentInfo?: { name?: string; version?: string }
  authMethods?: Array<Record<string, any>>
  agentCapabilities?: {
    loadSession?: boolean
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean }
    sessionCapabilities?: {
      list?: unknown
      resume?: unknown
      fork?: unknown
      close?: unknown
      delete?: unknown
      additionalDirectories?: unknown
    }
    mcpCapabilities?: { http?: boolean; sse?: boolean }
    auth?: { logout?: unknown }
  }
}
