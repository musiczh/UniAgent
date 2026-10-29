import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Attachment, Session, UAEvent } from '../../shared/types'
import type { AssistantWeixinState } from '../../shared/weixin'
import { appendWeixinContext } from '../../shared/weixin'
import { parseAssistantCommand } from '../../shared/assistant'
import { asInteractionRequest, planFeedbackInAnswer } from '../../shared/interactionRequests'
import type { Orchestrator } from '../orchestrator'
import { WeixinApi, WeixinApiError, WEIXIN_BASE_URL, weixinUrl, type WeixinMessage } from './weixinApi'
import { WeixinStore } from './weixinStore'
import { WeixinInteractions } from './weixinInteractions'

interface Dependencies {
  store: WeixinStore
  api: WeixinApi
  orchestrator: Pick<Orchestrator, 'getSessionById' | 'getEvents' | 'forceSend' | 'interrupt' | 'respondToRequest' | 'setArchived' | 'currentTurnAgentMessageText' | 'getWeixinSendTurn'>
  createSession(prompt: string, attachments: Attachment[], bind: (session: Session) => Promise<void>, assertCurrent: () => void): Promise<Session>
  command(sessionId: string, command: 'new' | 'clear', requestId: string): Promise<Session>
  onState(): void
  onError(message: string): void
  attachmentsDirectory: string
}
const IMAGE_EXTENSIONS = new Set(['.png','.jpg','.jpeg','.gif','.webp'])
const safeError = (error: unknown): string => error instanceof Error ? error.message : '微信操作失败'

export class WeixinBridge {
  private state: AssistantWeixinState = { configured: false, phase: 'idle' }
  private controller?: AbortController
  private flight?: Promise<void>
  private generation = 0
  private verifyCode?: string
  private interactions = new WeixinInteractions()
  private sends = Promise.resolve()
  private incoming = Promise.resolve()
  private restoring?: Promise<void>
  private finalSends = new Set<string>()
  constructor(private deps: Dependencies) {}
  getState(): AssistantWeixinState {
    return { ...this.state, configured: !!this.deps.store.get().account, sessionId: this.deps.store.get().sessionId }
  }
  owns(sessionId: string): boolean { return this.deps.store.get().sessionId === sessionId }
  private publish(patch: Partial<AssistantWeixinState>): void { this.state = { ...this.state, ...patch }; this.deps.onState() }
  private assertCurrent(generation: number): void {
    if (generation !== this.generation || this.controller?.signal.aborted) throw new Error('微信连接已停止或变更')
  }
  restore(): Promise<void> {
    return this.restoring ||= (async () => {
      try { await this.deps.store.load(); if (this.deps.store.get().account) this.connect() }
      catch (error) { this.publish({ phase: 'failed', message: safeError(error) }) }
    })()
  }
  private connect(): void {
    if (this.controller && !this.controller.signal.aborted) return
    const controller = this.controller = new AbortController()
    const generation = ++this.generation
    this.publish({ phase: 'connecting', message: '正在连接微信…', qrContent: undefined })
    this.flight = this.monitor(generation, controller.signal).catch(error => {
      if (!controller.signal.aborted && generation === this.generation) this.publish({ phase: 'failed', message: safeError(error) })
    })
  }
  private async stop(): Promise<void> {
    this.generation++
    this.controller?.abort()
    await this.flight?.catch(() => {})
    await this.incoming
    await this.sends
    this.controller = undefined; this.flight = undefined
    this.interactions.clear()
    this.finalSends.clear()
  }
  async disconnect(): Promise<AssistantWeixinState> {
    await this.restore()
    await this.stop()
    await this.deps.store.reset()
    this.publish({ phase: 'idle', message: undefined, qrContent: undefined })
    return this.getState()
  }
  async login(): Promise<AssistantWeixinState> {
    await this.restore()
    await this.stop()
    const controller = this.controller = new AbortController()
    const generation = ++this.generation
    this.verifyCode = undefined
    this.publish({ phase: 'connecting', message: '正在获取微信二维码…', qrContent: undefined })
    try {
      const result = await this.deps.api.qr(controller.signal)
      this.assertCurrent(generation)
      if (typeof result.qrcode !== 'string' || !result.qrcode || typeof result.qrcode_img_content !== 'string' || !result.qrcode_img_content || result.qrcode_img_content.length > 2048) throw new Error('微信未返回有效二维码')
      this.publish({ phase: 'awaiting-scan', qrContent: result.qrcode_img_content, message: '请使用微信扫码并确认授权' })
      this.flight = this.pollLogin(result.qrcode, generation, controller.signal).catch(error => {
        if (!controller.signal.aborted && generation === this.generation) this.publish({ phase: 'failed', message: safeError(error), qrContent: undefined })
      })
    } catch (error) {
      if (!controller.signal.aborted && generation === this.generation) this.publish({ phase: 'failed', message: safeError(error), qrContent: undefined })
    }
    return this.getState()
  }
  verify(code: string): AssistantWeixinState {
    if (this.state.phase !== 'awaiting-code' || typeof code !== 'string' || !/^[\dA-Za-z]{4,16}$/.test(code.trim())) throw new Error('请输入手机显示的有效配对码')
    this.verifyCode = code.trim()
    this.publish({ phase: 'awaiting-confirmation', message: '正在验证配对码…' })
    return this.getState()
  }
  private async pollLogin(qrcode: string, generation: number, signal: AbortSignal): Promise<void> {
    let base = WEIXIN_BASE_URL
    const deadline = Date.now() + 5 * 60_000
    while (!signal.aborted && Date.now() < deadline) {
      const code = this.verifyCode; this.verifyCode = undefined
      const result = await this.deps.api.qrStatus(qrcode, base, signal, code)
      this.assertCurrent(generation)
      if (result.status === 'confirmed') {
        const { bot_token: token, ilink_bot_id: botId, ilink_user_id: userId } = result
        if (!token || !botId || !userId) throw new Error('微信授权信息不完整，请重新扫码')
        const account = { token, botId, userId, baseUrl: weixinUrl(result.baseurl || base) }
        const previous = this.deps.store.get()
        const sameAccount = previous.account?.botId === botId && previous.account?.userId === userId
        if (!sameAccount) await this.deps.store.reset()
        this.assertCurrent(generation)
        await this.deps.store.update({ account })
        this.assertCurrent(generation)
        this.publish({ qrContent: undefined, phase: 'connecting', message: '授权成功，正在连接微信…' })
        await this.monitor(generation, signal)
        return
      }
      if (result.status === 'expired' || result.status === 'verify_code_blocked') {
        this.publish({ phase: 'expired', qrContent: undefined, message: result.status === 'expired' ? '二维码已过期，请重新扫码绑定' : '配对码验证次数过多，请重新扫码绑定' })
        return
      }
      if (result.status === 'scaned_but_redirect' && result.redirect_host) base = weixinUrl(`https://${result.redirect_host}`)
      else if (result.status === 'scaned') this.publish({ phase: 'awaiting-confirmation', message: '已扫码，请在微信确认授权' })
      else if (result.status === 'need_verifycode') this.publish({ phase: 'awaiting-code', message: '请输入微信手机端显示的配对码' })
      else if (result.status === 'binded_redirect') throw new Error('此微信已绑定其它实例，请在微信确认绑定后重试')
      await delay(1000, undefined, { signal })
    }
    if (!signal.aborted) this.publish({ phase: 'expired', qrContent: undefined, message: '扫码等待已超时，请重新获取二维码' })
  }
  private async monitor(generation: number, signal: AbortSignal): Promise<void> {
    const { sessionId } = this.deps.store.get()
    if (sessionId) for (const event of await this.deps.orchestrator.getEvents(sessionId)) this.interactions.register(event)
    let failures = 0
    while (!signal.aborted) {
      this.assertCurrent(generation)
      const saved = this.deps.store.get()
      if (!saved.account) return
      try {
        const result = await this.deps.api.updates(saved.account, saved.cursor, signal)
        this.assertCurrent(generation)
        failures = 0
        if (this.state.phase !== 'connected') this.publish({ phase: 'connected', message: saved.pending.length
          ? '上次有微信消息的处理结果未能确认，为避免重复执行未自动重试，请核对会话后重新发送。' : undefined })
        for (const message of result.msgs || []) {
          this.assertCurrent(generation)
          await this.receive(message, generation)
        }
        if (typeof result.get_updates_buf === 'string' && result.get_updates_buf) await this.deps.store.update({ cursor: result.get_updates_buf })
        await delay(200, undefined, { signal })
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof WeixinApiError && error.code === -14) {
          this.publish({ phase: 'expired', message: error.message })
          return
        }
        this.publish({ phase: 'reconnecting', message: '微信连接中断，正在重试…' })
        await delay(Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)), undefined, { signal })
      }
    }
  }
  receive(message: WeixinMessage, generation = this.generation): Promise<void> {
    const run = this.incoming.then(() => this.receiveNow(message, generation))
    this.incoming = run.catch(() => {})
    return run
  }
  private async receiveNow(message: WeixinMessage, generation: number): Promise<void> {
    this.assertCurrent(generation)
    const saved = this.deps.store.get()
    const account = saved.account
    if (!account || message.message_type !== 1 || message.group_id || message.from_user_id !== account.userId ||
      message.to_user_id && message.to_user_id !== account.botId || !message.message_id || !message.context_token) return
    const id = message.message_id
    if (saved.handled.includes(id) || saved.pending.includes(id)) return
    await this.deps.store.update({ pending: [...saved.pending, id].slice(-500), contextToken: message.context_token })
    this.assertCurrent(generation)
    try {
      const items = message.item_list || []
      const text = items.flatMap(item => item.type === 1 ? [item.text_item?.text || ''] : item.type === 3 ? [item.voice_item?.text || ''] : []).join('\n').trim()
      const session = saved.sessionId ? this.deps.orchestrator.getSessionById(saved.sessionId) : undefined
      const command = parseAssistantCommand(text)
      if (text === '/help') await this.reply('直接发送任务即可。\n/new：新建微信对话\n/clear：清空微信当前对话，保留长期记忆\n/stop：中断当前任务\n/status：查看当前状态\n回答问题：编号后填写选项序号或回答文字，可按题目说明补充内容。\n同意／拒绝／选择：必须带请求编号。', generation)
      else if (text === '/status') await this.reply(session ? `当前微信对话：${session.title}\n状态：${session.status}` : '微信已连接；发送任务后会创建独立对话。', generation)
      else if (text === '/stop') {
        if (session) this.deps.orchestrator.interrupt(session.id)
        await this.reply(session ? '已请求中断当前任务。' : '当前没有运行中的微信任务。', generation)
      } else if (command && session) await this.executeCommand(session.id, command, createHash('sha256').update(id).digest('hex'), generation)
      else if (command) await this.reply('当前尚未创建微信对话，直接发送任务即可开始。', generation)
      else {
        const handled = session ? await this.interactions.receive(session.id, text, async result => {
          this.assertCurrent(generation)
          const accepted = await this.deps.orchestrator.respondToRequest(session.id, result.requestId, result.answer, { source: 'weixin' })
          if (!accepted?.handled) throw new Error('该请求已处理或失效，请使用最新编号')
          if (result.event.payload.kind === 'planMode' && (result.answer as any).feedback && !planFeedbackInAnswer(result.event.payload.method)) {
            await this.deps.orchestrator.forceSend(session.id, appendWeixinContext((result.answer as any).feedback), undefined, undefined, { source: 'weixin' }, false)
          }
        }) : undefined
        if (handled) await this.reply(handled, generation)
        else if (text.startsWith('/')) await this.reply('未知指令。发送 /help 查看支持的指令。', generation)
        else if (!text && !items.some(item => item.type === 2 || item.type === 4)) await this.reply('目前支持文本、图片、文件，以及带转写文字的语音。', generation)
        else {
          const attachments = await this.attachments(items, generation)
          const prompt = appendWeixinContext(text)
          if (session) {
            if (session.config.assistantChannel !== 'weixin' || !session.config.assistantSnapshot || session.readOnly || session.teamBinding || session.handoffId) throw new Error('当前微信对话不可用，请在桌面端检查')
            if (session.archived) this.deps.orchestrator.setArchived(session.id, false)
            await this.deps.orchestrator.forceSend(session.id, prompt, attachments, undefined, { source: 'weixin' }, false)
          } else await this.deps.createSession(prompt, attachments, async created => {
            this.assertCurrent(generation)
            await this.deps.store.update({ sessionId: created.id, pushedSeq: -1 })
            this.deps.onState()
          }, () => this.assertCurrent(generation))
        }
      }
    } catch (error) {
      this.assertCurrent(generation)
      await this.reply(safeError(error), generation)
    }
    this.assertCurrent(generation)
    const current = this.deps.store.get()
    await this.deps.store.update({ handled: [...current.handled, id].slice(-500), pending: current.pending.filter(item => item !== id) })
  }
  async executeCommand(sessionId: string, command: 'new' | 'clear', requestId: string, generation = this.generation): Promise<Session> {
    if (!this.owns(sessionId)) throw new Error('当前会话不属于微信绑定')
    this.assertCurrent(generation)
    const next = await this.deps.command(sessionId, command, requestId)
    this.assertCurrent(generation)
    await this.deps.store.update({ sessionId: next.id, pushedSeq: -1 })
    this.interactions.clear(sessionId)
    this.deps.onState()
    await this.reply(command === 'new' ? '已开启新的微信对话。' : '已清空微信当前对话，长期记忆已保留。', generation)
      .catch(error => this.deps.onError(safeError(error)))
    return next
  }
  executeCommandFromApp(sessionId: string, command: 'new' | 'clear', requestId: string): Promise<Session> {
    const run = this.incoming.then(() => this.executeCommand(sessionId, command, requestId))
    this.incoming = run.then(() => {}, () => {})
    return run
  }
  private async attachments(items: NonNullable<WeixinMessage['item_list']>, generation: number): Promise<Attachment[]> {
    const attachments: Attachment[] = []
    for (const item of items.filter(item => item.type === 2 || item.type === 4)) {
      this.assertCurrent(generation)
      const bytes = await this.deps.api.download(item, this.controller!.signal)
      const prefix = Buffer.from(bytes.subarray(0,12))
      const format = prefix.subarray(0,8).toString('hex') === '89504e470d0a1a0a' ? 'png'
        : prefix.subarray(0,3).toString('hex') === 'ffd8ff' ? 'jpeg'
        : ['GIF87a','GIF89a'].includes(prefix.subarray(0,6).toString()) ? 'gif'
        : prefix.subarray(0,4).toString() === 'RIFF' && prefix.subarray(8,12).toString() === 'WEBP' ? 'webp' : undefined
      if (item.type === 2 && !format) throw new Error('微信图片格式无法识别，请使用 PNG、JPEG、GIF 或 WebP')
      const name = basename(item.file_item?.file_name || `微信图片.${format}`).replace(/[\x00-\x1f/\\]/g, '_') || '微信附件'
      const path = join(this.deps.attachmentsDirectory, `${randomUUID()}-${name}`)
      await mkdir(this.deps.attachmentsDirectory, { recursive: true, mode: 0o700 })
      await writeFile(path, bytes, { mode: 0o600 })
      attachments.push({ kind: item.type === 2 ? 'image' : 'file', path, name, ...(item.type === 2 ? { mime: `image/${format}` } : {}) })
    }
    return attachments
  }
  handleEvent(raw: UAEvent): void {
    if (!this.owns(raw.sessionId) || !this.deps.store.get().account) return
    const event = asInteractionRequest(raw)
    const generation = this.generation
    if (event.type === 'approval_request') {
      const text = this.interactions.register(event)
      if (text) void this.reply(text, generation).catch(error => this.deps.onError(safeError(error)))
    } else if (event.type === 'turn_started') {
      void this.reply('正在处理。完成后会在这里回复。\n发送 /stop 可以中断当前任务。', generation).catch(error => this.deps.onError(safeError(error)))
    } else if (event.type === 'turn_completed') {
      const key = `${event.sessionId}/${event.seq}`
      if (event.seq <= this.deps.store.get().pushedSeq || this.finalSends.has(key)) return
      this.finalSends.add(key)
      if (this.finalSends.size > 200) this.finalSends.delete(this.finalSends.values().next().value!)
      const text = this.deps.orchestrator.currentTurnAgentMessageText(event.sessionId, event.seq)
      const result = event.state === 'success' ? text || '本轮处理已完成。' : event.state === 'cancelled' ? '当前任务已中断。' : `当前任务未完成。${text ? '\n' + text : '请在 UniAgent 查看错误详情。'}`
      void this.reply(result, generation).then(() => this.deps.store.update(current =>
        generation === this.generation && current.sessionId === event.sessionId ? { pushedSeq: Math.max(current.pushedSeq,event.seq) } : undefined
      )).catch(error => this.deps.onError(safeError(error)))
    }
  }
  private reply(text: string | string[], generation: number): Promise<void> {
    return this.enqueueSend(async () => {
      const saved = this.deps.store.get()
      if (!saved.account || !saved.contextToken) throw new Error('微信尚未建立可回复的对话')
      // Bound segments avoid flooding Weixin with token-by-token output.
      for (const message of typeof text === 'string' ? [text] : text) {
        const characters = Array.from(message)
        for (let index = 0; index < characters.length; index += 1800) {
          this.assertCurrent(generation)
          await this.deps.api.send(saved.account, saved.contextToken, { type: 1, text_item: { text: characters.slice(index,index + 1800).join('') } }, this.controller!.signal)
        }
      }
    })
  }
  private enqueueSend<T>(run: () => Promise<T>): Promise<T> {
    const next = this.sends.then(run)
    this.sends = next.then(() => {}, () => {})
    return next
  }
  sendToSession(sessionId: string, text: string | undefined, paths: string[], requestedAt: number): Promise<string[]> {
    const turn = this.deps.orchestrator.getWeixinSendTurn(sessionId)
    const generation = this.generation
    const assert = () => {
      this.assertCurrent(generation)
      if (!turn || !Number.isFinite(requestedAt) || requestedAt < turn.ts || this.deps.orchestrator.getWeixinSendTurn(sessionId) !== turn || !this.owns(sessionId)) throw new Error('仅当前微信轮次可以向绑定的微信对话发送附件')
    }
    return this.enqueueSend(async () => {
      assert()
      const session = this.deps.orchestrator.getSessionById(sessionId)
      const saved = this.deps.store.get()
      if (!session || !saved.account || !saved.contextToken) throw new Error('微信会话尚未就绪')
      if ((text?.length || 0) > 3500 || paths.length > 10 || !text?.trim() && !paths.length) throw new Error('微信发送文案或附件数量无效')
      const files: Array<{ handle: Awaited<ReturnType<typeof open>>; name: string; image: boolean }> = []
      try {
        const root = paths.length ? await realpath(session.config.workdir) : ''
        for (const input of [...new Set(paths)]) {
          if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw new Error('附件路径无效')
          const path = await realpath(isAbsolute(input) ? input : resolve(root, input))
          const rel = relative(root, path)
          if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('附件必须位于当前会话的工作目录内')
          const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
          const stat = await handle.stat()
          if (!stat.isFile() || !stat.size || stat.size > 25 * 1024 * 1024) { await handle.close(); throw new Error('微信附件须为非空普通文件且不超过 25 MB') }
          files.push({ handle, name: basename(path), image: IMAGE_EXTENSIONS.has(extname(path).toLowerCase()) })
        }
        const sent: string[] = []
        if (text?.trim()) {
          assert()
          await this.deps.api.send(saved.account, saved.contextToken, { type: 1, text_item: { text: text.trim() } }, this.controller!.signal)
          sent.push('文案')
        }
        for (const file of files) {
          assert()
          const item = await this.deps.api.upload(saved.account, await file.handle.readFile(), file.name, file.image, this.controller!.signal)
          assert()
          await this.deps.api.send(saved.account, saved.contextToken, item, this.controller!.signal)
          sent.push(file.name)
        }
        return sent
      } finally { await Promise.all(files.map(file => file.handle.close())) }
    })
  }
  async close(): Promise<void> { await this.stop(); await this.deps.store.close() }
}
