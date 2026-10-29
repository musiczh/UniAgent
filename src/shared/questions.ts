// 需求3(问题卡片) — a unified internal shape for every interactive question /
// information-request, so a single form covers all agents (renderer AND the Feishu
// bridge). `single` uses radios/select, `multi` uses checkboxes/multi-select (with
// min/maxItems), `text` uses an input (password when secret). `allowOther` appends a
// free-text "其他" choice to a choice field.
//
// This module is PURE (no React) so the Electron main process (feishuBridge) and the
// renderer (EventStream) share ONE parsing/encoding contract — the bridge must never
// re-invent question parsing.
export type NormalizedField = {
  id: string
  title?: string
  prompt: string
  detail?: string
  type: 'single' | 'multi' | 'text'
  options: Array<{ value: string; label: string; description?: string }>
  allowOther: boolean
  secret: boolean
  required: boolean
  minItems?: number
  maxItems?: number
}

export function questionAnswerKind(kind: string, method?: string): string {
  if (method === 'zcode/userInput') return 'zcode'
  if (method === '_x.ai/ask_user_question') return 'grok'
  return method === '_uniagent/ask_user_question' ? 'deepseek' : kind
}

/** Display a submitted provider answer using the same labels in App and Feishu. */
export function questionAnswerValues(kind: string, field: NormalizedField, answer: any): string[] {
  if (Array.isArray(answer?.answers)) {
    const native = answer.answers.find((entry: any) => entry?.id === field.id)
    const selected = Array.isArray(native?.selected) ? native.selected.filter((value: unknown) => typeof value === 'string') : []
    return [...selected.map((value: string) => field.options.find(option => option.value === value)?.label ?? value),
      ...(typeof native?.custom === 'string' && native.custom ? [native.custom] : [])]
  }
  const raw = kind === 'zcode' ? answer?.content?.answers?.[field.id]
    : kind === 'grok' ? answer?.answers?.[field.id]
    : kind === 'elicitation' ? answer?.content?.[field.id] : answer?.answers?.[field.id]?.answers
  const values = Array.isArray(raw) ? raw.map(String) : (kind === 'elicitation' || kind === 'zcode') && raw != null ? [String(raw)] : []
  return values.map(value => field.options.find(option => option.value === value)?.label ?? value)
}

/** Both channels submit the same required fields and selection counts. */
export function validateQuestionAnswer(kind: string, fields: NormalizedField[], answer: unknown): void {
  if (!fields.length) throw new Error('提问内容无效')
  for (const field of fields) {
    const native = kind === 'zcode' ? (answer as any)?.content?.answers?.[field.id] : undefined
    if (native !== undefined && typeof native !== 'string' && !(Array.isArray(native) && native.every(value => typeof value === 'string'))) {
      throw new Error('提问答案格式无效：' + (field.prompt || field.id))
    }
    const values = questionAnswerValues(kind, field, answer)
    const count = values.filter(value => value.trim()).length
    const minimum = field.minItems ?? (field.required ? 1 : 0)
    if (count < minimum || (field.maxItems !== undefined && values.length > field.maxItems) ||
      (field.type !== 'multi' && values.length > 1)) throw new Error('请完整填写提问后再提交：' + (field.prompt || field.title || field.id))
    const selections = kind === 'zcode' ? (Array.isArray(native) ? native : native === undefined ? [] : [native]) : values
    if (field.type !== 'text' && !field.allowOther && selections.some(value => !field.options.some(option => (kind === 'zcode' ? option.value : option.label) === value))) {
      throw new Error('请选择问题提供的选项：' + (field.prompt || field.title || field.id))
    }
  }
}

/** A choice field's "其他" sentinel value (its typed text is stored separately). */
export const OTHER_VALUE = '__other__'

/** Codex reuses MCP elicitation for consent prompts; these are approvals, not forms. */
export function isMcpToolApproval(params: any): boolean {
  return params?._meta?.codex_approval_kind === 'mcp_tool_call'
}

export function mcpToolApprovalScopes(params: any): Array<'session' | 'always'> {
  const persist = params?._meta?.persist
  const scopes = Array.isArray(persist) ? persist : [persist]
  return ['session', 'always'].filter((scope) => scopes.includes(scope)) as Array<'session' | 'always'>
}

export function mcpToolApprovalDetail(params: any): {
  serverName: string
  toolName: string
  description: string
  parameters: Array<{ name: string; value: unknown }>
} {
  const meta = params?._meta || {}
  return {
    serverName: params?.serverName || 'MCP Server',
    toolName: meta.tool_title || meta.tool_name || String(params?.message || '').match(/"([^"]+)"/)?.[1] || 'MCP 工具',
    description: String(meta.tool_description || '').trim(),
    parameters: Array.isArray(meta.tool_params_display)
      ? meta.tool_params_display.map((entry: any) => ({
          name: String(entry.display_name || entry.name || ''),
          value: entry.value
        }))
      : Object.entries(meta.tool_params || {}).map(([name, value]) => ({ name, value }))
  }
}

export function mcpToolApprovalAnswer(
  action: 'accept' | 'decline',
  persist?: 'session' | 'always'
): unknown {
  return { action, content: null, _meta: persist ? { persist } : null }
}

/**
 * 需求3 — normalize a question/elicitation request into NormalizedField[]. Covers
 * codex/traex `item/tool/requestUserInput` (params.questions[]) and MCP
 * `mcpServer/elicitation/request` (params.requestedSchema). Never fabricates
 * protocol fields — an unrecognized shape degrades to a single free-text field so
 * the reply still round-trips (and the legacy `.approval-answer` box is kept).
 */
export function normalizeQuestions(kind: string, params: any): NormalizedField[] {
  if (!params || typeof params !== 'object') return []
  // MCP elicitation: parse the JSON schema's properties.
  const schema = params.requestedSchema || params.schema
  if (kind === 'elicitation' && schema && typeof schema === 'object' && schema.properties) {
    const required: string[] = Array.isArray(schema.required) ? schema.required : []
    const props = schema.properties as Record<string, any>
    return Object.keys(props).map((key) => {
      const prop = props[key] || {}
      const title = prop.title || key
      const prompt = prop.description || prop.title || key
      const isRequired = required.includes(key)
      // Single-select: enum (+ optional enumNames) or oneOf/anyOf of consts.
      const enumVals: any[] | undefined = Array.isArray(prop.enum) ? prop.enum : undefined
      const enumNames: any[] | undefined = Array.isArray(prop.enumNames) ? prop.enumNames : undefined
      const composite = prop.oneOf || prop.anyOf
      if (enumVals) {
        return {
          id: key,
          title,
          prompt,
          type: 'single' as const,
          options: enumVals.map((v, i) => ({
            value: String(v),
            label: String(enumNames?.[i] ?? v)
          })),
          allowOther: false,
          secret: false,
          required: isRequired
        }
      }
      if (Array.isArray(composite)) {
        return {
          id: key,
          title,
          prompt,
          type: 'single' as const,
          options: composite.map((entry: any) => ({
            value: String(entry.const ?? entry.value ?? entry.title ?? ''),
            label: String(entry.title ?? entry.const ?? entry.value ?? ''),
            description: entry.description
          })),
          allowOther: false,
          secret: false,
          required: isRequired
        }
      }
      // Multi-select: array of an enum with maxItems > 1.
      if (prop.type === 'array' && prop.items) {
        const itemEnum: any[] | undefined = Array.isArray(prop.items.enum) ? prop.items.enum : undefined
        const itemNames: any[] | undefined = Array.isArray(prop.items.enumNames)
          ? prop.items.enumNames
          : undefined
        const itemComposite: any[] | undefined = Array.isArray(prop.items.oneOf)
          ? prop.items.oneOf
          : Array.isArray(prop.items.anyOf) ? prop.items.anyOf : undefined
        if (itemEnum || itemComposite) {
          const options = itemEnum
            ? itemEnum.map((v, i) => ({ value: String(v), label: String(itemNames?.[i] ?? v) }))
            : itemComposite!.map((entry: any) => ({
                value: String(entry.const ?? entry.value ?? entry.title ?? ''),
                label: String(entry.title ?? entry.const ?? entry.value ?? ''),
                description: entry.description
              }))
          return {
            id: key,
            title,
            prompt,
            type: 'multi' as const,
            options,
            allowOther: false,
            secret: false,
            required: isRequired,
            minItems: typeof prop.minItems === 'number' ? prop.minItems : undefined,
            maxItems: typeof prop.maxItems === 'number' ? prop.maxItems : undefined
          }
        }
      }
      // Plain string/number/boolean → free text (password when marked secret).
      return {
        id: key,
        title,
        prompt,
        type: 'text' as const,
        options: [],
        allowOther: false,
        secret: prop.format === 'password' || prop.secret === true,
        required: isRequired
      }
    })
  }
  // codex / traex question: params.questions[]. Each question may be single-select
  // (radios), multi-select (checkboxes, when `multiSelect === true`), or free text.
  const qs = params.questions || params.inputs
  if (Array.isArray(qs) && qs.length) {
    if (['zcode','grok'].includes(kind) && (qs.some(q => typeof q?.question !== 'string' || !q.question.trim()) ||
      new Set(qs.map(q => q.question)).size !== qs.length)) return []
    return qs.map((q: any, idx: number) => {
      const id = kind === 'zcode' || kind === 'grok' ? q.question : q.id || q.questionId || `q${idx}`
      const rawOptions = Array.isArray(q.options) ? q.options : []
      const options = rawOptions.map((o: any) => {
        if (typeof o === 'string') return { value: o, label: o }
        const label = String(o.label ?? o.value ?? o.name ?? '')
        return {
          value: kind === 'grok' || kind === 'zcode' ? String(o.value ?? o.id ?? label) : label,
          label,
          description: o.description
        }
      })
      // codex `AskUserQuestion` carries a per-question `multiSelect` boolean; when
      // set, render checkboxes instead of radios so several options can be picked.
      const isMulti = q.multiSelect === true || q.multi === true || q.allowMultiple === true
      const type = options.length ? (isMulti ? ('multi' as const) : ('single' as const)) : ('text' as const)
      return {
        id,
        title: q.header || q.title,
        prompt: q.prompt || q.question || q.label || '',
        ...(typeof q.detail === 'string' ? { detail: q.detail } : {}),
        type,
        options,
        allowOther: kind === 'zcode' ? params.freeText === true : q.isOther === true || q.allowOther === true || options.length === 0,
        secret: q.isSecret === true,
        required: q.required !== false,
        minItems: typeof q.minItems === 'number' ? q.minItems : undefined,
        maxItems: typeof q.maxItems === 'number' ? q.maxItems : undefined
      }
    })
  }
  // Fallback: a single free-text prompt (keeps the legacy .approval-answer box).
  const prompt = params.prompt || params.question || ''
  if (kind === 'zcode') return [] // Native replies require the original questions, even for free text.
  if (prompt) {
    return [
      {
        id: 'q0',
        prompt,
        type: 'text',
        options: [],
        allowOther: false,
        secret: false,
        required: true
      }
    ]
  }
  return []
}

/**
 * 需求3 — encode collected answers back into each source's reply wire shape.
 * codex question → {answers:{[id]:{answers:string[]}}} (labels kept byte-for-byte,
 * including any 「（推荐）」suffix). MCP elicitation → ElicitResult
 * {action:'accept', content:{[prop]: value|array|text}}. Never invents fields.
 */
export function encodeAnswer(
  kind: string,
  fields: NormalizedField[],
  collected: Record<string, { choice: string[]; text: string; other: string }>
): unknown {
  if (kind === 'grok') return encodeGrokQuestionAnswer(fields, collected)
  // codex question replies echo the human-readable OPTION LABEL (kept byte-for-byte,
  // incl. any 「（推荐）」suffix); MCP elicitation replies echo the RAW enum VALUE the
  // schema defined. `useLabel` selects which to emit for a choice field.
  const resolveField = (f: NormalizedField, useLabel: boolean): string[] => {
    const state = collected[f.id] || { choice: [], text: '', other: '' }
    if (f.type === 'text') return state.text ? [state.text] : []
    const values = state.choice.map((v) => {
      if (v === OTHER_VALUE) return state.other
      const opt = f.options.find((o) => o.value === v)
      if (!opt) return v
      return useLabel ? opt.label : opt.value
    })
    return values.filter((v) => v.length > 0)
  }

  if (kind === 'deepseek') {
    return { answers: fields.map((field) => {
      const state = collected[field.id] || { choice: [], text: '', other: '' }
      const custom = field.type === 'text' ? state.text : state.choice.includes(OTHER_VALUE) ? state.other : ''
      const selected = field.type === 'text' ? [] : state.choice.filter(value => value !== OTHER_VALUE).map(value =>
        field.options.find(option => option.value === value)?.label ?? value
      )
      return { id: field.id, selected, ...(custom ? { custom } : {}) }
    }) }
  }

  if (kind === 'elicitation' || kind === 'zcode') {
    const content: Record<string, unknown> = {}
    for (const f of fields) {
      const state = collected[f.id] || { choice: [], text: '', other: '' }
      if (f.type === 'text') {
        if (state.text) content[f.id] = state.text
      } else if (f.type === 'multi') {
        content[f.id] = resolveField(f, false)
      } else {
        const one = resolveField(f, false)[0]
        if (one !== undefined) content[f.id] = one
      }
    }
    return { action: 'accept', content: kind === 'zcode' ? { answers: content } : content }
  }
  // codex / traex question.
  const answers: Record<string, { answers: string[] }> = {}
  for (const f of fields) {
    answers[f.id] = { answers: resolveField(f, true) }
  }
  return { answers }
}

export type GrokQuestionReply = { outcome: 'accepted'; answers: Record<string, string[]> } | { outcome: 'cancelled' }

/** Grok's reverse RPC takes labels in a flat map, including free-text answers. */
export function encodeGrokQuestionAnswer(
  fields: NormalizedField[],
  collected: Record<string, { choice: string[]; text: string; other: string }>
): GrokQuestionReply {
  const answers: Record<string, string[]> = Object.fromEntries(fields.map(field => {
    const state = collected[field.id] || { choice: [], text: '', other: '' }
    const values = field.type === 'text' ? [state.text] : state.choice.map(value => {
      if (value === OTHER_VALUE && field.allowOther) return state.other
      const option = field.options.find(entry => entry.value === value)
      if (!option) throw new Error('Grok 提问答案包含未知选项')
      return option.label
    })
    return [field.id, values.filter(value => value.length > 0)]
  }))
  const reply = { outcome: 'accepted' as const, answers }
  validateGrokQuestionReply(fields, reply)
  return reply
}

/** Validate again at the main-process boundary; never pass renderer objects through. */
export function validateGrokQuestionReply(fields: NormalizedField[], value: unknown): GrokQuestionReply {
  const reply = value as any
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new Error('Grok 提问答案格式无效')
  if (reply.outcome === 'cancelled' && Object.keys(reply).length === 1) return { outcome: 'cancelled' }
  if (reply.outcome !== 'accepted' || Object.keys(reply).some(key => !['outcome', 'answers'].includes(key)) ||
    !reply.answers || typeof reply.answers !== 'object' || Array.isArray(reply.answers) ||
    Object.keys(reply.answers).length !== fields.length || fields.some(field => !Object.hasOwn(reply.answers, field.id)) ||
    Object.values(reply.answers).some(values => !Array.isArray(values) || values.length > 100 ||
      values.some(value => typeof value !== 'string' || value.length > 65536) || new Set(values).size !== values.length)) {
    throw new Error('Grok 提问答案格式无效')
  }
  for (const field of fields) {
    if (field.type !== 'text' && !field.allowOther && reply.answers[field.id].some((value: string) => !field.options.some(option => option.label === value))) {
      throw new Error('Grok 提问答案必须使用原始选项标签')
    }
  }
  validateQuestionAnswer('grok', fields, reply)
  return { outcome: 'accepted', answers: Object.fromEntries(fields.map(field => [field.id, [...reply.answers[field.id]]])) }
}
