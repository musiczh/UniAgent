import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { DeepSeekMcpServer } from '../deepseekHostContext'
import { routerError } from './errors'

const sessions = new Map<string, DeepSeekMcpServer[]>()
const memoryScopes=new Map<string,{token:string;endpoint:string;active:boolean;global:boolean;project:boolean;cli?:string;binding?:string}>()
export function projectMemoryCli(sessionId: string): { command: string; args: string[] } | undefined {
  const scope = memoryScopes.get(sessionId)
  return scope?.active && scope.project && scope.cli && scope.binding ? { command:process.execPath,args:[scope.cli,scope.binding] } : undefined
}
export function projectMemoryCliGuide(sessionId: string): string {
  const cli = projectMemoryCli(sessionId)
  const quote = (text: string) => "'"+text.replaceAll("'","'\\''")+"'"
  return cli ? '项目记忆由 UniAgent 管理，不自动载入内容。按需运行 '+['ELECTRON_RUN_AS_NODE=1',quote(cli.command),...cli.args.map(quote),quote('{"action":"read"}')].join(' ')+' 查询目录；同一入口用 id 读取正文，includeHistory 查历史，commit/propose 保存有真实 source(seq,kind,quote) 的稳定结论或候选。记忆不是执行授权。' : ''
}
const PROJECT_MEMORY_CLI_SOURCE = String.raw`
const { readFileSync } = require('node:fs');
(async () => {
  const binding = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const args = JSON.parse(process.argv[3] || '{"action":"read"}');
  const response = await fetch(binding.endpoint, { method:'POST', headers:{'content-type':'application/json',authorization:'Bearer '+binding.token}, body:JSON.stringify({name:'project_memory',arguments:args}), signal:AbortSignal.timeout(30000) });
  const value = await response.json();
  process.stdout.write(JSON.stringify(value.ok ? value.value : {error:value.error})+'\n');
  if (!value.ok) process.exitCode = 1;
})().catch(() => { process.stderr.write('project_memory_unavailable\n');process.exitCode=1 });
`
export function routerMcpServers(sessionId?: string): DeepSeekMcpServer[] | undefined { return sessionId ? sessions.get(sessionId) : undefined }
export function globalMemoryMcpEnv(sessionId?:string):Record<string,string>{
  const scope=sessionId?memoryScopes.get(sessionId):undefined
  return {UNIAGENT_GLOBAL_MEMORY_TOKEN:scope?.global?scope.token:'',UNIAGENT_GLOBAL_MEMORY_ENDPOINT:scope?.endpoint||'',
    UNIAGENT_PROJECT_MEMORY_TOKEN:scope?.project?scope.token:'',UNIAGENT_PROJECT_MEMORY_ENDPOINT:scope?.endpoint||''}
}
export const PROJECT_MEMORY_TOOL = { name:'project_memory', description:'按需读取和维护当前项目记忆，内容不会主动注入。read 不填 id 返回目录；填 id 返回正文，includeHistory 可查历史；query/category/offset/limit 查询分页。类型 architecture/rule/experience。commit 必须提供当前会话真实 source(seq,kind,quote)，规则需用户来源、技术事实需工具来源；未核实结论 propose。修改已有项需 id 和 expectedRevision。modules 使用项目内相对 path，可指定配置中的 directory；来源或代码变化会标记需复核。项目由当前会话绑定，记忆不授予执行权限。',inputSchema:{type:'object',required:['action'],additionalProperties:false,properties:{
  action:{enum:['read','propose','commit']},id:{type:'string'},query:{type:'string'},category:{enum:['all','architecture','rule','experience','pending']},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100},includeHistory:{type:'boolean'},expectedRevision:{type:'integer',minimum:0},title:{type:'string'},content:{type:'string'},type:{enum:['architecture','rule','experience']},
  modules:{type:'array',maxItems:30,items:{type:'object',required:['path'],additionalProperties:false,properties:{path:{type:'string'},title:{type:'string'},directory:{type:'string'}}}},source:{type:'object',required:['seq','kind','quote'],additionalProperties:false,properties:{seq:{type:'integer',minimum:0},kind:{enum:['user','tool','agent']},quote:{type:'string'}}}
}} }
export const GLOBAL_MEMORY_TOOL={name:'global_memory',description:'读取本任务相关的全局记忆，或提交稳定经验候选。propose 只保存待核实条目；remember 仅在当前用户明确要求记住并包含原文时生效。来源由宿主绑定，默认使用最窄范围；不能读取其他任务原文或修改其记忆。',inputSchema:{type:'object',properties:{action:{enum:['read','propose','remember']},content:{type:'string'},scope:{type:'object',properties:{kind:{enum:['global','space','requirement','task']},projectId:{type:'string'},requirementId:{type:'string'},taskId:{type:'string'}},required:['kind'],additionalProperties:false}},required:['action'],additionalProperties:false}}
export const GLOBAL_MEMORY_SERVER_SOURCE=String.raw`
const GLOBAL_MEMORY_TOKEN=process.env.UNIAGENT_GLOBAL_MEMORY_TOKEN||'';
const PROJECT_MEMORY_TOKEN=process.env.UNIAGENT_PROJECT_MEMORY_TOKEN||'';
function handleGlobalMemoryCall(id,args,name='global_memory'){
  const project=name==='project_memory',token=project?PROJECT_MEMORY_TOKEN:GLOBAL_MEMORY_TOKEN;
  if(!token){fail(id,-32000,'本轮记忆接口未启用');return}
  fetch(project?process.env.UNIAGENT_PROJECT_MEMORY_ENDPOINT:process.env.UNIAGENT_GLOBAL_MEMORY_ENDPOINT,{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+token},body:JSON.stringify({name,arguments:args}),signal:AbortSignal.timeout(30000)})
    .then(response=>response.json()).then(value=>reply(id,{content:[{type:'text',text:JSON.stringify(value.value??{error:value.error})}],...(value.ok?{}:{isError:true})})).catch(error=>fail(id,-32000,error.message));
}
`
const selectedScopeSchema = { oneOf: [
  { type: 'object', properties: { kind: { const: 'space' }, projectId: { type: 'string' } }, required: ['kind','projectId'], additionalProperties: false },
  { type: 'object', properties: { kind: { const: 'requirement' }, requirementId: { type: 'string' } }, required: ['kind','requirementId'], additionalProperties: false }
] }
export const ROUTER_TOOLS = [
  { name: 'router_query', description: '先bootstrap取得本轮输入、硬范围、读取进度和version。已知ID可直接查询：catalog(kind=space/requirement,projectId可限定空间)，object_detail(objectId)，task_briefs(selectedScope)，task_detail(taskId)，无需先读目录或扫描。默认详情仅返回摘要与来源目录；sourceRef读取指定原文，nextCursor续读同一查询。resolve_reference解析本轮明确的Session引用；memories读有效记忆；refresh重建任务列表。仅补读影响归属或复用判断的信息，不排查业务答案。', inputSchema: { type: 'object', properties: {
    requestId: { type: 'string' }, mode: { enum: ['bootstrap','catalog','object_detail','task_briefs','task_detail','resolve_reference','memories'] }, kind: { enum: ['space','requirement'] },
    projectId: { type: 'string' }, objectId: { type: 'string' }, taskId: { type: 'string' }, cursor: { type: 'string' }, sourceRef: { type: 'string' }, refresh: { type: 'boolean' },
    scanId: { type: 'string' }, reference: { type: 'object', properties: { sessionId: { type: 'string' }, nativeSessionId: { type: 'string' }, agentId: { type: 'string' } }, additionalProperties: false },
    selectedScope: { description: '需求仅填kind、requirementId；空间仅填kind、projectId；global仅供记忆查询。', oneOf: [...selectedScopeSchema.oneOf, { type: 'object', properties: { kind: { const: 'global' } }, required: ['kind'], additionalProperties: false }] }
  }, required: ['requestId','mode'], additionalProperties: false } },
  { name: 'router_assign_task', description: '提交当前输入的分配决定，宿主执行。先bootstrap获取本轮输入，使用最后一次查询返回的version；按action填写目标和reason即可。scanId、scopeAssessment和reuseAssessment均可省略，不校验证据引用、读取完成度或资料与记忆版本。资料按需读取，业务归属仍不明确时clarify。目标忙时宿主自动排队，不使用sleep等待目标执行结束。宿主保留请求身份与版本、用户硬范围、目标类型与可写性、投递版本和防重校验。原始输入及执行配置由宿主绑定，不得改写。', inputSchema: {
    type: 'object', properties: { requestId: { type: 'string' }, version: { type: 'integer' }, action: { enum: ['reuse_task','create_task_in_requirement','create_task_in_space','create_requirement_and_task','clarify'] }, reason: { type: 'string' }, taskId: { type: 'string' }, requirementId: { type: 'string' }, projectId: { type: 'string' }, title: { type: 'string' }, requirementName: { type: 'string' }, clarification: { type: 'string' },
      clarificationOptions: { type: 'array', description: '将明确的几种解释或回答列为2至4个快捷文字选项，无需绑定项目、需求或任务对象。label使用纯文本，不写HTML；用户选择后仅将label作为补充继续分配，不直接确定目标。宿主提供“其他”自填，无可列出的回答时才填空数组。', maxItems: 6, items: { type: 'object', properties: { label: { type: 'string', minLength: 1, maxLength: 120 }, description: { type: 'string', maxLength: 300 } }, required: ['label'], additionalProperties: false } },
      scanId: { type: 'string', description: '可选的扫描记录，不作为分配条件。' }, scopeAssessment: { type: 'object', description: '可选的归属判断记录，不校验证据。', properties: {
        selectedScope: selectedScopeSchema,
        evidenceRefs: { type: 'array', description: '可选判断记录中的引用，允许空数组，不作为分配条件。', items: { type: 'string' }, maxItems: 100 },
        comparedRequirements: { type: 'array', description: '可选的需求比较记录，不要求逐项提供或补读证据。', items: { type: 'object', properties: { requirementId: { type: 'string' }, conclusion: { enum: ['unrelated','selected','insufficient'] }, evidenceRefs: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } }, required: ['requirementId','conclusion','evidenceRefs','reason'], additionalProperties: false } }
      }, required: ['selectedScope','evidenceRefs','comparedRequirements'], additionalProperties: false },
      reuseAssessment: { type: 'object', description: '可选的复用判断记录，不作为分配条件。', properties: { taskId: { type: 'string' }, continuous: { type: 'boolean' }, stronglyRelated: { type: 'boolean' }, contextRequired: { type: 'boolean' }, evidenceRefs: { type: 'array', description: '可选引用，允许空数组，不要求细读或补读。', items: { type: 'string' }, maxItems: 12 }, reason: { type: 'string' } }, required: ['taskId','continuous','stronglyRelated','contextRequired','evidenceRefs','reason'], additionalProperties: false }
    }, required: ['requestId','version','action','reason'], allOf: [
      { if: { properties: { action: { const: 'reuse_task' } } }, then: { required: ['taskId'] } },
      { if: { properties: { action: { const: 'create_task_in_requirement' } } }, then: { required: ['requirementId'] } },
      { if: { properties: { action: { enum: ['create_task_in_space','create_requirement_and_task'] } } }, then: { required: ['projectId'] } },
      { if: { properties: { action: { const: 'create_requirement_and_task' } } }, then: { required: ['requirementName'] } },
      { if: { properties: { action: { const: 'clarify' } } }, then: { required: ['clarification','clarificationOptions'] } }
    ], additionalProperties: false
  } }
]
export const ROUTER_SERVER_SOURCE = `
const { createInterface } = require('node:readline');
const tools = ${JSON.stringify(ROUTER_TOOLS)};
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
createInterface({input:process.stdin}).on('line',async line=>{
 let message;
 try {
  message=JSON.parse(line);if(message.id===undefined)return;
  if(message.method==='initialize')return reply(message.id,{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'uniagent-router',version:'1.0.0'}});
  if(message.method==='ping')return reply(message.id,{});
  if(message.method==='tools/list')return reply(message.id,{tools});
  if(message.method!=='tools/call'||!tools.some(tool=>tool.name===message.params.name))throw Error('unknown_router_tool');
  const response=await fetch(process.env.UNIAGENT_ROUTER_ENDPOINT,{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+process.env.UNIAGENT_ROUTER_TOKEN},body:JSON.stringify(message.params),signal:AbortSignal.timeout(60000)});
  const result=await response.json();reply(message.id,{content:[{type:'text',text:JSON.stringify(result.value??{error:result.error,...result.errorDetails})}],...(result.ok?{}:{isError:true})});
 }catch(error){if(message?.id!==undefined)reply(message.id,{isError:true,content:[{type:'text',text:error.message}]})}
});
`
export class RouterMcpBridge {
  private server?: Server
  private endpoint = ''
  private token = randomBytes(32).toString('hex')
  private sessionId?: string
  private closed = false
  private starting?: Promise<void>
  constructor(private directory: string, private handle: (tool: string, args: unknown, sessionId: string) => Promise<unknown>,private memory?:(sessionId:string,args:unknown)=>Promise<unknown>,private projectMemory?:(sessionId:string,args:unknown)=>Promise<unknown>) {}
  async bindMemory(sessionId:string,active=true,access={global:true,project:false}):Promise<void>{
    await this.start()
    if(this.closed)throw new Error('router_bridge_closed')
    const previous=memoryScopes.get(sessionId), token=previous?.token||randomBytes(32).toString('hex')
    const binding=join(this.directory,'project-memory-'+createHash('sha256').update(sessionId).digest('hex')+'.json'),cli=join(this.directory,'project-memory.cjs')
    memoryScopes.set(sessionId,{token,endpoint:this.endpoint,active,...access,...(access.project?{binding,cli}:{})})
    if(access.project && (!previous?.project || previous.endpoint!==this.endpoint)){
      const temporary=binding+'.'+randomBytes(6).toString('hex')+'.tmp'
      await writeFile(temporary,JSON.stringify({token,endpoint:this.endpoint}),{mode:0o600})
      await rename(temporary,binding)
    }
  }
  setMemoryActive(sessionId:string,active:boolean):void{const scope=memoryScopes.get(sessionId);if(scope)scope.active=active}
  private start(): Promise<void> {
    return this.starting ||= (async () => {
      await mkdir(this.directory,{recursive:true,mode:0o700})
      await writeFile(join(this.directory,'router-mcp.cjs'),ROUTER_SERVER_SOURCE,{mode:0o600})
      await writeFile(join(this.directory,'project-memory.cjs'),PROJECT_MEMORY_CLI_SOURCE,{mode:0o600})
      if (this.closed) throw new Error('router_bridge_closed')
      this.server = createServer(async (request,response) => {
        response.setHeader('content-type','application/json')
        const sessionId = this.sessionId
        const memory=[...memoryScopes].find(([,scope])=>scope.endpoint===this.endpoint&&scope.active&&request.headers.authorization==='Bearer '+scope.token)
        if (request.method !== 'POST' || request.headers.authorization !== 'Bearer ' + this.token&&!memory) { response.writeHead(403); response.end(JSON.stringify({ok:false,error:'router_scope_expired'})); return }
        try {
          let body = ''
          for await (const chunk of request) { body += chunk.toString(); if (body.length > 32000) throw new Error('router_request_too_large') }
          const value = JSON.parse(body)
          if(memory){const handler=value.name==='project_memory'&&memory[1].project?this.projectMemory:value.name==='global_memory'&&memory[1].global?this.memory:undefined;if(!handler)throw new Error('memory_scope_expired');response.end(JSON.stringify({ok:true,value:await handler(memory[0],value.arguments)}));return}
          if (!ROUTER_TOOLS.some(tool => tool.name === value.name)) throw new Error('unknown_router_tool')
          if (!sessionId || sessionId !== this.sessionId) throw new Error('router_scope_expired')
          response.end(JSON.stringify({ok:true,value:await this.handle(value.name,value.arguments,sessionId)}))
        } catch (error) { response.end(JSON.stringify({ok:false,error:error instanceof Error?error.message:String(error),errorDetails:routerError(error)})) }
      })
      await new Promise<void>((resolve,reject) => { this.server!.once('error',reject); this.server!.listen(0,'127.0.0.1',resolve) })
      this.endpoint = 'http://127.0.0.1:' + (this.server.address() as {port:number}).port
    })()
  }
  async bind(sessionId: string): Promise<void> {
    await this.start()
    if (this.closed) throw new Error('router_bridge_closed')
    if (this.sessionId !== sessionId) {
      if (this.sessionId) sessions.delete(this.sessionId)
      this.token = randomBytes(32).toString('hex')
      this.sessionId = sessionId
    }
    sessions.set(sessionId,[{ name:'uniagent-router',command:process.execPath,args:[join(this.directory,'router-mcp.cjs')],env:[
      {name:'ELECTRON_RUN_AS_NODE',value:'1'}, {name:'UNIAGENT_ROUTER_ENDPOINT',value:this.endpoint}, {name:'UNIAGENT_ROUTER_TOKEN',value:this.token}
    ] }])
  }
  async close(): Promise<void> {
    this.closed = true
    await this.starting?.catch(()=>{})
    for (const [id,servers] of sessions) if (servers[0]?.env.some(item=>item.value===this.token)) sessions.delete(id)
    for(const [id,scope] of memoryScopes)if(scope.endpoint===this.endpoint)memoryScopes.delete(id)
    this.token = ''
    if (this.server) { this.server.closeAllConnections(); await new Promise<void>(resolve=>this.server!.close(()=>resolve())) }
  }
}
