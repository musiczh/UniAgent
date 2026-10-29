import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { pathToFileURL } from 'node:url'
import { type Session, type FilePreviewOptions, type FilePreviewResult } from '../shared/types'
import type { DetailExplanationContext } from '../shared/detailQuickChat'
import type { Orchestrator } from './orchestrator'

export class DetailWindow {
  private current?: { window: BrowserWindow; sessionId: string; context: DetailExplanationContext; nonce: number; started?: Promise<void> }
  private revision = 0
  private pendingSessionId?: string
  constructor(private deps: {
    owner: Orchestrator
    main(): BrowserWindow | null | undefined
    ui(path: string): string
    ready(sessionId: string): Promise<void>
    readFile?(sessionId: string, path: string, options?: FilePreviewOptions, root?: string): Promise<FilePreviewResult>
  }) {}
  register(): void {
    ipcMain.handle('detailWindow:action', async (event, action: string, value?: unknown) => {
      const entry = this.authorize(event)
      const { owner } = this.deps
      const id = entry.sessionId
      owner.assertUserSessionEnabled(id)
      switch (action) {
        case 'initial': return { sessionId: id, quote: entry.context.selectedText, selectedMessageText: entry.context.selectedMessageText, nonce: entry.nonce }
        case 'explain': {
          if (!entry.started) entry.started = this.deps.ready(id).then(() => {
            if (this.current !== entry || entry.window.isDestroyed()) return
            return owner.explainDetailSelection(id, entry.context)
          })
          await entry.started
          return
        }
        case 'events': return owner.getDetailEvents(id)
        case 'status': return owner.getDetailStatus(id)
        case 'send':
          if (typeof value !== 'string' || !value.trim()) throw new Error('请填写问题')
          await this.deps.ready(id)
          return owner.sendDetailMessage(id, value)
        case 'interrupt': return owner.interruptDetail(id)
        case 'readFile': {
          const request = value as { path?: string; options?: FilePreviewOptions; root?: string }
          if (!request || typeof request.path !== 'string' || !this.deps.readFile) throw new Error('invalid_detail_file')
          return this.deps.readFile(id, request.path, request.options, request.root)
        }
        case 'close': entry.window.close(); return
        case 'promote': {
          const saved = await owner.promoteDetailToSide(id)
          if (saved) this.deps.main()?.webContents.send('detailWindow:promoted', { sessionId: id, kind: 'side' })
          return saved
        }
        case 'promoteSession': {
          const session: Session = await owner.promoteDetailToSession(id)
          this.deps.main()?.webContents.send('detailWindow:promoted', { sessionId: id, kind: 'session', session })
          return session
        }
        default: throw new Error('unknown_detail_action')
      }
    })
  }
  private authorize(event: IpcMainInvokeEvent): NonNullable<DetailWindow['current']> {
    const entry = this.current
    if (!entry || entry.window.isDestroyed() || event.sender !== entry.window.webContents || event.senderFrame !== event.sender.mainFrame)
      throw new Error('untrusted_detail_window')
    const actual = new URL(event.senderFrame.url)
    const expected = process.env.ELECTRON_RENDERER_URL ? new URL('detail.html', process.env.ELECTRON_RENDERER_URL) : pathToFileURL(this.deps.ui('renderer/detail.html'))
    if (actual.origin !== expected.origin || actual.protocol !== expected.protocol || actual.pathname !== expected.pathname) throw new Error('untrusted_detail_origin')
    return entry
  }
  async open(sessionId: string, context: DetailExplanationContext): Promise<void> {
    if (!context || typeof context.selectedText !== 'string' || !context.selectedText.trim() || typeof context.selectedMessageText !== 'string' || context.sourceConversationId !== sessionId)
      throw new Error('无效的原文选区')
    const revision = ++this.revision
    this.pendingSessionId = sessionId
    // Open the reading UI immediately; agent preparation starts after it subscribes.
    await Promise.resolve()
    if (revision !== this.revision) return
    this.pendingSessionId = undefined
    this.current?.window.close()
    const bounds = this.deps.main()?.getBounds()
    const window = new BrowserWindow({ width: 396, height: 480, minWidth: 396, minHeight: 480,
      x: bounds ? bounds.x + bounds.width - 420 : undefined, y: bounds ? bounds.y + 100 : undefined,
      show: false, frame: false, transparent: true, hasShadow: true, resizable: false, title: '解释',
      webPreferences: { preload: this.deps.ui('preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false,
        additionalArguments: ['--ua-detail-window'] } })
    const entry = { window, sessionId, context, nonce: Date.now() }
    this.current = entry
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.on('closed', () => { if (this.current === entry) { this.current = undefined; this.deps.owner.closeDetail(sessionId) } })
    window.once('ready-to-show', () => window.show())
    try {
      if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(new URL('detail.html', process.env.ELECTRON_RENDERER_URL).href)
      else await window.loadFile(this.deps.ui('renderer/detail.html'))
    } catch (error) { window.close(); throw error }
  }
  forward(channel: string, payload: { sessionId: string }): void {
    const entry = this.current
    if (entry?.sessionId === payload.sessionId && !entry.window.isDestroyed()) entry.window.webContents.send(channel, payload)
  }
  close(sessionId?: string): void {
    if (!sessionId || this.pendingSessionId === sessionId) { ++this.revision; this.pendingSessionId = undefined }
    if (this.current && (!sessionId || this.current.sessionId === sessionId)) this.current.window.close()
  }
}
