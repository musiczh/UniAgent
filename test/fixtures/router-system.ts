import { RouterContextService } from '../../src/main/router/context'
import { titleMetadata } from '../../src/shared/taskTitle'
import { DEFAULT_ROUTER_CONFIG, type RouterDecision, type RouterRequest } from '../../src/shared/router'
import type { Project, Session } from '../../src/shared/types'
import type { Requirement } from '../../src/shared/requirementTypes'
import type { ReviewCase } from './router-reviews'

// New synthetic contracts, frozen before model evaluation. They are not user
// feedback, reconstructed production history, or an independent real-world label set.
export async function routerSystemCases(): Promise<Array<ReviewCase & { syntheticExpectation: Partial<RouterDecision> }>> {
  const now = 1794822000000
  const projects = [
    { id: 'ledger', name: '云账台', primaryDirectory: '/fixture/ledger' },
    { id: 'notes', name: '笔记台', primaryDirectory: '/fixture/notes' }
  ].map(row => ({ ...row, createdAt: now, updatedAt: now, additionalDirectories: [] } as Project))
  const scopes = [
    ['settlement', '结算工作流', 'ledger', '本需求承载云账台结算工作流，包括结算批次、对账文件导出、结果反馈与结算异常处理。导出的当前字段约定仍须沿原任务验收。'],
    ['ledger-theme', '云账台外观', 'ledger', '只负责云账台全局主题配色，不负责结算流程及其结果反馈。'],
    ['note-import', '笔记导入', 'notes', '承载笔记台资料导入、导入结果反馈及导入异常处理。'],
    ['notification-a', '结算通知', 'ledger', '承载结算结果通知。'],
    ['notification-b', '订阅通知', 'ledger', '承载用户订阅结果通知。']
  ]
  const requirements = scopes.map(([id, name, projectId]) => ({ id, name, projectId, createdAt: now, updatedAt: now, status: 'active' } as Requirement))
  const task: Session = { id: 'export-task', title: '调研文件导出可行性', createdAt: now - 10000, updatedAt: now, status: 'idle',
    config: { agentId: 'codex', projectId: 'ledger', requirementId: 'settlement', workdir: '/fixture/ledger' },
    taskMetadata: { ...titleMetadata({ id: 'export-task', title: '调研文件导出可行性' }, false),
      description: '实现结算对账 CSV 文件导出。已确定列顺序、金额精度和空值表达，目前继续验收同一导出功能；沿用本任务保存的字段约定和样本文件，尚有金额精度项未通过。',
      generationState: 'ready', generatedInputId: 'export-2', generatedAt: now } }
  const context = new RouterContextService({ projects: () => projects, requirements: async () => requirements, sessions: () => [task],
    seed: () => ({ primaryIntent: '调研结算文件导出可行性', inputId: 'export-2' }),
    events: async () => [
      { sessionId: task.id, seq: 1, ts: now - 10000, type: 'user_message', payload: { text: '调研结算文件导出可行性' } },
      { sessionId: task.id, seq: 2, ts: now - 1000, type: 'user_message', payload: { text: '按原样本继续' } },
      { sessionId: task.id, seq: 3, ts: now, type: 'agent_message', payload: { text: '继续核对中。' } }
    ], overview: async () => { throw Error('use registered sources') },
    routing: async id => ({ snapshot: { status: 'missing', sourceRevision: id + '-v1' }, sources: { revision: id + '-v1', documents: [
      { id: 'a-local-spec', kind: 'spec', title: '局部样式规格', content: '结果列表的标题使用紧凑字重，保留列表展开与滚动。'.repeat(70), contentHash: 'local', status: 'active', freshness: 'verified', summary: '', sources: [], dependencies: [], updatedAt: now },
      { id: 'core', kind: 'core', title: '需求目标与范围', content: scopes.find(row => row[0] === id)![3], contentHash: id, status: 'active', freshness: 'verified', summary: '', sources: [], dependencies: [], updatedAt: now }
    ] } }) }, () => now)
  const objects = await context.objects()
  const rows: Array<[string, string, Partial<RouterDecision>]> = [
    ['S01', '云账台结算流程的结果反馈提示需要延长显示时间，请作为独立交互改动处理。', { action: 'create_task_in_requirement', requirementId: 'settlement' }],
    ['S02', '笔记台资料导入失败提示需要显示异常摘要，作为独立功能改动。', { action: 'create_task_in_requirement', requirementId: 'note-import' }],
    ['S03', '沿用导出任务已确定的 CSV 列顺序、金额精度与样本文件，继续验收金额精度未通过项。', { action: 'reuse_task', taskId: 'export-task' }],
    ['S04', '在云账台结算需求中新开独立任务，新增结算失败告警推送，不依赖导出任务的字段或样本。', { action: 'create_task_in_requirement', requirementId: 'settlement' }],
    ['S05', '在云账台增加库存盘点能力，建立独立库存盘点需求及首个任务；现有结算和外观需求不承载库存。', { action: 'create_requirement_and_task', projectId: 'ledger' }],
    ['S06', '把结果提示改小一点。两个项目都有结果提示，我尚未指定项目。', { action: 'clarify' }],
    ['S07', '只在云账台处理通知，结算通知或订阅通知还没有确定，需要改通知文案。', { action: 'clarify' }],
    ['S08', '围绕云账台结算工作流，撰写对账文件导出方案说明，作为独立文档任务，不继续原导出验收。', { action: 'create_task_in_requirement', requirementId: 'settlement' }]
  ]
  return rows.map(([id, prompt, syntheticExpectation]) => ({ id, syntheticExpectation, objects: structuredClone(objects), queries: [], traces: [],
    availability: 'synthetic-contract', gaps: ['合成契约样本，不是用户评价；没有图片、原生生产历史或外部工具。'],
    request: { requestId: id, prompt, scope: { kind: 'global' }, config: DEFAULT_ROUTER_CONFIG, version: 1, state: 'queued', delivery: 'pending', createdAt: now, updatedAt: now } as RouterRequest }))
}
