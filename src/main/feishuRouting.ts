import { createHash } from 'node:crypto'
import { canRetryRouterRequest, type RouterInput, type RouterRequest, type RouterResolution } from '../shared/router'
import { OTHER_VALUE } from '../shared/questions'
import type { FeishuThreadLink, Session } from '../shared/types'

export function feishuRouteId(botAppId: string, messageId: string): string {
  const hash = createHash('sha256').update(JSON.stringify([botAppId, messageId])).digest('hex')
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`
}

export function feishuRouteCard(request: Pick<RouterRequest, 'requestId' | 'version' | 'state' | 'delivery'> & Partial<RouterRequest>, session?: Session, original?: FeishuThreadLink, supplement = false): object {
  const markdown = (content: string) => ({ tag: 'markdown', content })
  const text = (value: string) => value.replace(/[\\`*_\[\]<>]/g, '\\$&').slice(0, 2500)
  const action = (label: string, act: string, primary = false) => ({ tag: 'button', type: primary ? 'primary' : 'default',
    text: { tag: 'plain_text', content: label }, behaviors: [{ type: 'callback', value: { routeId: request.requestId, version: request.version, act } }] })
  let title = '路由中', color = 'blue'
  const elements: object[] = []
  const originalTopic = () => {
    if (!original) return
    elements.push(markdown('该任务已有飞书话题，后续进展与问答继续在原话题更新。'))
    const url = new URL(original.threadId ? 'https://applink.feishu.cn/client/thread/open' : 'https://applink.feishu.cn/client/chat/open')
    if (original.threadId) {
      for (const key of ['openthreadid', 'open_thread_id']) url.searchParams.set(key, original.threadId)
      for (const key of ['openchatid', 'open_chat_id']) url.searchParams.set(key, original.chatId)
      url.searchParams.set('thread_position', '0')
    } else {
      url.searchParams.set('openChatId', original.chatId)
      elements.push(markdown('原绑定缺少话题 ID，请在原聊天中查看对应话题。'))
    }
    elements.push({ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: original.threadId ? '打开原话题' : '打开原聊天' }, behaviors: [{ type: 'open_url', default_url: url.href }] })
  }
  const form = (label: string) => ({ tag: 'form', name: 'routeSupplement', elements: [
    ...(request.state === 'needs_input' ? [{ tag: 'select_static', name: 'routeChoice', required: true,
      placeholder: { tag: 'plain_text', content: '请选择一项' },
      options: [...(request.decision?.clarificationOptions || []).map((option,index) => ({ text: { tag: 'plain_text', content: option.label }, value: option.objectId || `option:${index}` })),
        { text: { tag: 'plain_text', content: '其他' }, value: OTHER_VALUE }] }] : []),
    { tag: 'input', name: 'routeAnswer', required: request.state !== 'needs_input', max_length: 1000, placeholder: { tag: 'plain_text', content: request.state === 'needs_input' ? '仅选择「其他」时填写你的答案…' : '补充目标、所属空间或其它信息…' } },
    { ...action(label, 'submitRouteSupplement', true), name: 'submitRouteSupplement', form_action_type: 'submit' }
  ] })
  if (request.supplements?.length) elements.push(markdown('**已补充信息**\n' + text(request.supplements.map(row => row.text || row.attachments?.map(item => item.name).join('、') || '').join('\n'))))
  if (request.delivery === 'unknown') {
    title = request.autoRecovery?.nextAt ? '正在核对投递' : '归属已确定，投递待确认'; color = 'orange'
    if (session) elements.push(markdown(`目标任务：${text(session.taskMetadata?.title || session.title)}`))
    elements.push(markdown(request.autoRecovery?.nextAt ? '正在核对原任务的接收记录，无需操作；不会重复发送。' : text(request.error || '暂时无法确认接收结果，原目标已保留，不会重复发送。')))
    if (!request.autoRecovery?.nextAt) elements.push(action('再次核对', 'verifyRoute', true))
    originalTopic()
    if (request.targetId) elements.push(action('在 UniAgent 中打开', 'openRoutedTask'))
  } else if (request.state === 'queued' && request.autoRecovery?.nextAt || request.state === 'routing' && request.autoRecovery?.attempts) {
    title = '正在自动恢复'
    elements.push(markdown(text(request.autoRecovery!.reason)), markdown(`第 ${request.autoRecovery!.attempts} 次自动恢复 · 原输入与附件已保留，无需操作。`))
    if (request.state === 'queued') elements.push(action('取消本次路由', 'cancelRoute'))
  } else if (session && (request.state === 'committing' || request.state === 'bound')) {
    const reused = request.decision?.action === 'reuse_task'
    title = reused ? '已加入已有任务' : '已自动归属'; color = 'green'
    elements.push(markdown(`**${reused ? '继续任务' : '新建任务'} · ${text(session.taskMetadata?.title || session.title)}**`))
    if (request.projectName) elements.push(markdown(`空间：${text(request.projectName)}`))
    if (request.requirementName) elements.push(markdown(`需求：${text(request.requirementName)}`))
    if (request.decision?.reason) elements.push(markdown(`原因：${text(request.decision.reason)}`))
    elements.push(markdown(`执行配置：${text([session.config.agentId, session.config.model, session.config.effort].filter(Boolean).join(' · '))}${reused ? '（沿用原任务配置）' : ''}`))
    if (request.delivery === 'queued') elements.push(markdown('本次输入已加入原任务队列，等待执行。'))
    else if (request.state === 'committing') elements.push(markdown('归属已确定，正在投递本次输入。'))
    originalTopic()
    elements.push(action('在 UniAgent 中打开', 'openRoutedTask'))
  } else if (request.state === 'bound') {
    title = '归属已确定，目标暂不可用'; color = 'orange'
    elements.push(markdown('目标任务暂时无法读取，未重新创建或投递。请在 UniAgent 中检查原任务。'))
  } else if (request.state === 'needs_input') {
    title = '需要补充归属信息'; color = 'orange'
    elements.push(markdown(text(request.question || '请在当前话题补充归属信息。')),
      markdown('请选择一项；选择「其他」时填写答案。也可在当前话题回复文字／附件，继续同一次分配。'),
      ...(request.decision?.clarificationOptions?.some(option => option.description) ? [markdown(request.decision.clarificationOptions.map(option => text(option.label) + (option.description ? '：' + text(option.description) : '')).join('\n'))] : []),
      form('继续分配'), action('改为手动选择', 'manualRoute'))
  } else if (request.state === 'failed') {
    title = '自动归属失败'; color = 'orange'
    elements.push(markdown(text(request.error || '路由未完成。')))
    if (request.autoRecovery?.attempts) elements.push(markdown(`已尝试自动恢复 ${request.autoRecovery.attempts} 次，原输入与附件已保留。`))
    if (canRetryRouterRequest(request)) elements.push(action('重试', 'retryRoute', true), action('补充信息后重试', 'supplementRoute'),
      ...(supplement ? [form('提交并重试')] : []), markdown('也可在当前话题补充文字或附件后继续原请求。'), action('手动选择', 'manualRoute'))
    else if (request.targetId) elements.push(action('在 UniAgent 中打开', 'openRoutedTask'))
  } else if (request.state === 'cancelled') {
    title = '已取消路由'; color = 'grey'
    elements.push(markdown('本次路由已取消。'))
    if (canRetryRouterRequest(request)) elements.push(action('重试', 'retryRoute'))
  } else {
    title = request.state === 'queued' ? '等待路由' : '路由中'
    elements.push(markdown(request.state === 'committing' ? '已确定归属，正在准备任务…' : '正在判断空间、需求与任务归属…'))
    if (request.version > 0 && (request.state === 'queued' || request.state === 'routing')) elements.push(action('取消本次路由', 'cancelRoute'))
  }
  return { schema: '2.0', config: { update_multi: true }, header: { template: color, title: { tag: 'plain_text', content: title } }, body: { elements } }
}

export function feishuRouteAnswer(request: RouterRequest, form: unknown): Pick<RouterResolution, 'action' | 'answer'> {
  const values = form && typeof form === 'object' ? form as Record<string, unknown> : {}
  if (request.state === 'needs_input') {
    const choice = values.routeChoice
    if (typeof choice !== 'string' || !choice) throw new Error('请选择一个澄清选项')
    if (choice !== OTHER_VALUE) {
      const option = request.decision?.clarificationOptions?.find((option,index) => (option.objectId || `option:${index}`) === choice)
      if (!option) throw new Error('澄清候选已变化，请重新选择')
      return { action: 'answer', answer: option.label }
    }
  }
  const answer = values.routeAnswer
  if (typeof answer !== 'string' || !answer.trim() || answer.length > 1000) throw new Error('请填写补充信息（最多 1000 字）')
  return { action: request.state === 'needs_input' ? 'answer' : 'retry', answer: answer.trim() }
}

export function feishuRouteSourceMatches(source: RouterInput['feishu'], botAppId: string | undefined, chatId: string): boolean {
  return !!source && source.botAppId === botAppId && source.chatId === chatId
}
