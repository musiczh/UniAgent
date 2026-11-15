import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

// The existing official assets and tokenizer library stay entirely off the main thread.
const workerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { Tokenizer } = require(workerData.library);
const ready = Promise.all(['tokenizer.json','tokenizer_config.json','manifest.json'].map(name => readFile(join(workerData.directory,name),'utf8'))).then(([json,config,raw]) => {
  const manifest = JSON.parse(raw);
  for (const [name,data] of [['tokenizer.json',json],['tokenizer_config.json',config]])
    if (createHash('sha256').update(data).digest('hex') !== manifest.sha256[name]) throw Error('任务描述 tokenizer 资源校验失败');
  return new Tokenizer(JSON.parse(json),JSON.parse(config));
});
ready.catch(() => {});
parentPort.on('message', async ({id,text}) => {
  try { const tokenizer = await ready; parentPort.postMessage({id,count:tokenizer.encode(text,{add_special_tokens:false}).ids.length}); }
  catch (error) { parentPort.postMessage({id,error:error.message}); }
});
`

export class TaskTitleTokenCounter {
  private worker?: Worker
  private nextId = 0
  private readonly pending = new Map<number, { resolve: (count: number) => void; reject: (error: Error) => void }>()
  constructor(private readonly directory = (process as NodeJS.Process & { resourcesPath?: string; defaultApp?: boolean }).resourcesPath && !(process as NodeJS.Process & { defaultApp?: boolean }).defaultApp
    ? join((process as NodeJS.Process & { resourcesPath: string }).resourcesPath, 'tokenizers/deepseek-v4') : resolve('resources/tokenizers/deepseek-v4')) {}

  count(text: string): Promise<number> {
    if (!this.worker) {
      const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url)
      const worker = this.worker = new Worker(workerSource, { eval: true, workerData: { directory: this.directory, library: require.resolve('@huggingface/tokenizers') } })
      worker.unref()
      const fail = (error: Error) => {
        if (this.worker !== worker) return
        this.worker = undefined
        for (const request of this.pending.values()) request.reject(error)
        this.pending.clear()
      }
      worker.on('error', fail)
      worker.on('exit', () => fail(new Error('任务描述计数进程已退出')))
      worker.on('message', ({ id, count, error }) => {
        const request = this.pending.get(id)
        if (!request) return
        this.pending.delete(id)
        error ? request.reject(new Error(error)) : request.resolve(count)
        if (!this.pending.size) worker.unref()
      })
    }
    const id = ++this.nextId
    this.worker.ref()
    return new Promise((resolveCount, reject) => {
      this.pending.set(id, { resolve: resolveCount, reject })
      try { this.worker!.postMessage({ id, text }) }
      catch (error) { this.pending.delete(id); reject(error) }
    })
  }

  async validate(text: string): Promise<void> {
    if (await this.count(text) > 200) throw Object.assign(new Error('任务描述超过 200 token'), { code: 'task_description_too_long' })
  }
  async close(): Promise<void> { await this.worker?.terminate() }
}
const counter = new TaskTitleTokenCounter()
export const validateTaskDescription = (text: string): Promise<void> => counter.validate(text)
