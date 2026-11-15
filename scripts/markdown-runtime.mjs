import { build } from 'esbuild'
import { resolve } from 'node:path'

const moduleId = 'virtual:uniagent-markdown-worker-url'
const devPath = '/@uniagent/markdown-highlight-worker.js'

export async function buildMarkdownWorker() {
  const result = await build({
    entryPoints: [resolve('src/renderer/markdownHighlight.worker.ts')],
    bundle: true, write: false, platform: 'browser', format: 'iife', minify: true,
  })
  return result.outputFiles[0].text
}

export function markdownRuntimePlugin() {
  let command
  let runtime
  const code = () => runtime ||= buildMarkdownWorker().catch(error => { runtime = undefined; throw error })
  return {
    name: 'uniagent-markdown-worker',
    configResolved(config) { command = config.command },
    resolveId(id) { if (id === moduleId) return '\0' + moduleId },
    async load(id) {
      if (id !== '\0' + moduleId) return
      if (command === 'serve') return `export default ${JSON.stringify(devPath)}`
      const ref = this.emitFile({ type: 'asset', name: 'markdown-highlight-worker.js', source: await code() })
      return `export default import.meta.ROLLUP_FILE_URL_${ref}`
    },
    configureServer(server) {
      server.middlewares.use(devPath, async (_request, response, next) => {
        try { response.setHeader('Content-Type', 'text/javascript'); response.end(await code()) }
        catch (error) { next(error) }
      })
    },
  }
}
