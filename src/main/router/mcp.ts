import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, writeFile, rename } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { homedir } from 'node:os'
import type { DeepSeekMcpServer } from '../deepseekHostContext'
import { routerError } from './errors'

const sessions = new Map<string, DeepSeekMcpServer[]>()
const memoryScopes=new Map<string,{token:string;endpoint:string;active:boolean;project:boolean;context:boolean;cli?:string;binding?:string}>()
const shellQuote = (text: string): string => "'" + text.replaceAll("'", "'\\''") + "'"
function contextCliCommand(sessionId: string, cli: { args: string[] }): string {
  return `~/${shellQuote(relative(homedir(), join(dirname(cli.args[0]), 'uniagent-context')))} ${shellQuote(sessionId)}`
}
export function projectMemoryCli(sessionId: string): { command: string; args: string[] } | undefined {
  const scope = memoryScopes.get(sessionId)
  return scope?.active && scope.project && scope.cli && scope.binding ? { command:process.execPath,args:[scope.cli,scope.binding] } : undefined
}
export function projectMemoryCliGuide(sessionId: string): string {
  const cli = projectMemoryCli(sessionId)
  return cli ? `项目记忆用 \`${contextCliCommand(sessionId, cli)} '{"action":"read"}'\` 查询；read(id) 读正文，commit/propose 用真实 source(seq,kind,quote) 保存结论，修改时带 expectedRevision。` : ''
}
export function runtimeContextCli(sessionId: string): { command: string; args: string[] } | undefined {
  const scope = memoryScopes.get(sessionId)
  return scope?.active && scope.context && scope.cli && scope.binding ? { command: process.execPath, args: [scope.cli, scope.binding] } : undefined
}
export function runtimeContextCliGuide(sessionId: string): string {
  const cli = runtimeContextCli(sessionId)
  return cli ? `无原生 MCP 时，用 \`${contextCliCommand(sessionId, cli)} '{"name":"uniagent_query","arguments":{"action":"context"}}'\` 查询当前会话；同一入口将 JSON 换为 {"name":"requirement_context","arguments":{...}} 调用已绑定需求工具。` : ''
}
const PROJECT_MEMORY_CLI_SOURCE = String.raw`
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join } = require('node:path');
(async () => {
  const scoped = process.argv[2] === '--session';
  const file = scoped ? join(__dirname, 'project-memory-' + createHash('sha256').update(process.argv[3]).digest('hex') + '.json') : process.argv[2];
  const binding = JSON.parse(readFileSync(file, 'utf8'));
  const args = JSON.parse(process.argv[scoped ? 4 : 3] || '{"action":"read"}');
  const request = args.name ? args : {name:'project_memory',arguments:args};
  const response = await fetch(binding.endpoint, { method:'POST', headers:{'content-type':'application/json',authorization:'Bearer '+binding.token}, body:JSON.stringify(request), signal:AbortSignal.timeout(30000) });
  const value = await response.json();
  process.stdout.write(JSON.stringify(value.ok ? value.value : {error:value.error,...(value.details?{details:value.details}:{})})+'\n');
  if (!value.ok) process.exitCode = 1;
})().catch(() => { process.stderr.write('project_memory_unavailable\n');process.exitCode=1 });
`
export function routerMcpServers(sessionId?: string): DeepSeekMcpServer[] | undefined { return sessionId ? sessions.get(sessionId) : undefined }
export function projectMemoryMcpEnv(sessionId?:string):Record<string,string>{
  const scope=sessionId?memoryScopes.get(sessionId):undefined
  return {UNIAGENT_PROJECT_MEMORY_TOKEN:scope?.project?scope.token:'',UNIAGENT_PROJECT_MEMORY_ENDPOINT:scope?.endpoint||''}
}
export const PROJECT_MEMORY_TOOL = { name:'project_memory', description:'按需读取和维护当前项目记忆，内容不会主动注入。read 不填 id 返回目录；填 id 返回正文，includeHistory 可查历史；query/category/offset/limit 查询分页。类型 architecture/rule/experience。commit 必须提供当前会话真实 source(seq,kind,quote)，规则需用户来源、技术事实需工具来源；未核实结论 propose。修改已有项需 id 和 expectedRevision。modules 使用项目内相对 path，可指定配置中的 directory；来源或代码变化会标记需复核。项目由当前会话绑定，记忆不授予执行权限。',inputSchema:{type:'object',required:['action'],additionalProperties:false,properties:{
  action:{enum:['read','propose','commit']},id:{type:'string'},query:{type:'string'},category:{enum:['all','architecture','rule','experience','pending']},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100},includeHistory:{type:'boolean'},expectedRevision:{type:'integer',minimum:0},title:{type:'string'},content:{type:'string'},type:{enum:['architecture','rule','experience']},
  modules:{type:'array',maxItems:30,items:{type:'object',required:['path'],additionalProperties:false,properties:{path:{type:'string'},title:{type:'string'},directory:{type:'string'}}}},source:{type:'object',required:['seq','kind','quote'],additionalProperties:false,properties:{seq:{type:'integer',minimum:0},kind:{enum:['user','tool','agent']},quote:{type:'string'}}}
}} }
export const PROJECT_MEMORY_SERVER_SOURCE=String.raw`
const PROJECT_MEMORY_TOKEN=process.env.UNIAGENT_PROJECT_MEMORY_TOKEN||'';
function handleProjectMemoryCall(id,args){
  if(!PROJECT_MEMORY_TOKEN){fail(id,-32000,'本轮项目记忆接口未启用');return}
  fetch(process.env.UNIAGENT_PROJECT_MEMORY_ENDPOINT,{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+PROJECT_MEMORY_TOKEN},body:JSON.stringify({name:'project_memory',arguments:args}),signal:AbortSignal.timeout(30000)})
    .then(response=>response.json()).then(value=>reply(id,{content:[{type:'text',text:JSON.stringify(value.value??{error:value.error})}],...(value.ok?{}:{isError:true})})).catch(error=>fail(id,-32000,error.message));
}
`
const selectedScopeSchema = { oneOf: [
  { type: 'object', properties: { kind: { const: 'space' }, projectId: { type: 'string' } }, required: ['kind','projectId'], additionalProperties: false },
  { type: 'object', properties: { kind: { const: 'requirement' }, requirementId: { type: 'string' } }, required: ['kind','requirementId'], additionalProperties: false }
] }
export const ROUTER_TOOLS = [
  { name: 'router_query', description: '按需查询归属与任务材料。本轮基础事实及version已随输入提供。catalog(kind=space)只列项目，kind=requirement配合projectId列需求；object_detail(objectId)读项目/需求；task_briefs(selectedScope)中space只列项目直属任务，不含需求任务，requirement只列该需求任务，自动候选限近72小时可写任务；task_detail(taskId)可直接读已定位的旧任务及归档资料，默认提供当前关键材料与来源目录。sourceRef读原文，cursor续读相同查询，refresh更新任务列表。查看返回的queryScope与coverage，不能将局部空列表当作全项目没有任务。', inputSchema: { type: 'object', properties: {
    requestId: { type: 'string' }, mode: { enum: ['catalog','object_detail','task_briefs','task_detail'] }, kind: { enum: ['space','requirement'] },
    projectId: { type: 'string' }, objectId: { type: 'string' }, taskId: { type: 'string' }, cursor: { type: 'string' },
    sourceRef: { type: 'string', description: '仅供 object_detail 或 task_detail 读取来源正文，须同时填写对应 objectId 或 taskId；可直接使用来源条目的 continueWith。列表的 sourceRefs 是入口，不是正文。' }, refresh: { type: 'boolean' },
    selectedScope: { description: '需求只填kind、requirementId；项目直属只填kind、projectId，不包含其需求任务。', ...selectedScopeSchema }
  }, required: ['requestId','mode'], allOf: [
    { if: { properties: { mode: { const: 'catalog' } } }, then: { required: ['kind'] } },
    { if: { properties: { mode: { const: 'object_detail' } } }, then: { required: ['objectId'] } },
    { if: { properties: { mode: { const: 'task_briefs' } } }, then: { required: ['selectedScope'] } },
    { if: { properties: { mode: { const: 'task_detail' } } }, then: { required: ['taskId'] } },
    { if: { required: ['sourceRef'] }, then: { properties: { mode: { enum: ['object_detail','task_detail'] } } } }
  ], additionalProperties: false } },
  { name: 'router_assign_task', description: '提交本轮分配，使用宿主上下文或最近工具结果的version；按action填写目标和reason。资料充分即可提交；必要补读后仍有实质歧义才clarify并给候选选择。宿主保留请求身份与版本、硬范围、目标类型与可写性、投递版本及防重，忙任务自动排队，原始输入与执行配置由宿主绑定。', inputSchema: {
    type: 'object', properties: { requestId: { type: 'string' }, version: { type: 'integer' }, action: { enum: ['reuse_task','create_task_in_requirement','create_task_in_space','create_requirement_and_task','clarify'] }, reason: { type: 'string' }, taskId: { type: 'string' }, requirementId: { type: 'string' }, projectId: { type: 'string' }, title: { type: 'string' }, requirementName: { type: 'string' }, clarification: { type: 'string' },
      initialRequirementContext: { type: 'string', description: '可选：基于本轮已读资料，补充当前任务相关目标、约束、已确认决定、背景与真实来源入口。含宿主资料包装最多 2000 token，超限请压缩后重新提交，不截断语义。仅目标首次初始化承接；复用已初始化任务不再次注入，不改原始业务请求或授权。' },
      clarificationOptions: { type: 'array', description: '必要澄清必须提供有依据的候选或可行处理选项，通常2至4个，并简述区别；不编造已有对象。无需绑定项目、需求或任务。label使用纯文本，用户选择后仅作为补充继续原请求，不直接确定目标。宿主提供“其他”自填，不提交空数组。', minItems: 1, maxItems: 6, items: { type: 'object', properties: { label: { type: 'string', minLength: 1, maxLength: 120 }, description: { type: 'string', maxLength: 300 } }, required: ['label'], additionalProperties: false } },
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
  constructor(private directory: string, private handle: (tool: string, args: unknown, sessionId: string) => Promise<unknown>,private projectMemory?:(sessionId:string,args:unknown)=>Promise<unknown>,private runtimeContext?:(sessionId:string,tool:string,args:unknown)=>Promise<unknown>) {}
  async bindMemory(sessionId:string,active=true,access={project:false}):Promise<void>{
    await this.start()
    if(this.closed)throw new Error('router_bridge_closed')
    const previous=memoryScopes.get(sessionId), token=previous?.token||randomBytes(32).toString('hex')
    const binding=join(this.directory,'project-memory-'+createHash('sha256').update(sessionId).digest('hex')+'.json'),cli=join(this.directory,'project-memory.cjs')
    memoryScopes.set(sessionId,{token,endpoint:this.endpoint,active,...access,context:!!this.runtimeContext,...(access.project||this.runtimeContext?{binding,cli}:{})})
    if((access.project||this.runtimeContext) && (!previous?.binding || previous.endpoint!==this.endpoint)){
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
      await writeFile(join(this.directory,'uniagent-context'), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} ${shellQuote(join(this.directory, 'project-memory.cjs'))} --session "$@"\n`, {mode:0o700})
      if (this.closed) throw new Error('router_bridge_closed')
      this.server = createServer(async (request,response) => {
        response.setHeader('content-type','application/json')
        const sessionId = this.sessionId
        const memory=[...memoryScopes].find(([,scope])=>scope.endpoint===this.endpoint&&scope.active&&request.headers.authorization==='Bearer '+scope.token)
        if (request.method !== 'POST' || request.headers.authorization !== 'Bearer ' + this.token&&!memory) { response.writeHead(403); response.end(JSON.stringify({ok:false,error:'router_scope_expired'})); return }
        try {
          let body = ''
          for await (const chunk of request) { body += chunk.toString(); if (body.length > (memory?.[1].context ? 1_048_576 : 32000)) throw new Error('router_request_too_large') }
          const value = JSON.parse(body)
          if (memory?.[1].context && ['uniagent_query','requirement_context'].includes(value.name)) {
            response.end(JSON.stringify({ok:true,value:await this.runtimeContext!(memory[0],value.name,value.arguments)})); return
          }
          if (body.length > 32000) throw new Error('router_request_too_large')
          if(memory){const handler=value.name==='project_memory'&&memory[1].project?this.projectMemory:undefined;if(!handler)throw new Error('memory_scope_expired');response.end(JSON.stringify({ok:true,value:await handler(memory[0],value.arguments)}));return}
          if (!ROUTER_TOOLS.some(tool => tool.name === value.name)) throw new Error('unknown_router_tool')
          if (!sessionId || sessionId !== this.sessionId) throw new Error('router_scope_expired')
          response.end(JSON.stringify({ok:true,value:await this.handle(value.name,value.arguments,sessionId)}))
        } catch (error) { response.end(JSON.stringify({ok:false,error:error instanceof Error?error.message:String(error),errorDetails:routerError(error),...(error instanceof Error&&'details' in error?{details:error.details}:{})})) }
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
