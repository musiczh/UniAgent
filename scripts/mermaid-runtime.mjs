import { createRequire } from 'node:module'
import { build } from 'esbuild'

const moduleId = 'virtual:uniagent-mermaid-runtime-url'
const devPath = '/@uniagent/mermaid-runtime.js'
const require = createRequire(import.meta.url)

/** Keep diagram code lazy and self-contained so a retry can reload one URL. */
export function mermaidRuntimePlugin() {
  let command
  let runtime
  const code = () => runtime ||= build({
    entryPoints: [require.resolve('mermaid')], bundle: true, write: false,
    platform: 'browser', format: 'esm', minify: true,
  }).then(result => result.outputFiles[0].text).catch(error => {
    runtime = undefined
    throw error
  })

  return {
    name: 'uniagent-mermaid-runtime',
    configResolved(config) { command = config.command },
    resolveId(id) { if (id === moduleId) return '\0' + moduleId },
    async load(id) {
      if (id !== '\0' + moduleId) return
      if (command === 'serve') return `export default ${JSON.stringify(devPath)}`
      const ref = this.emitFile({ type: 'asset', name: 'mermaid-runtime.js', source: await code() })
      return `export default import.meta.ROLLUP_FILE_URL_${ref}`
    },
    configureServer(server) {
      server.middlewares.use(devPath, async (_request, response, next) => {
        try {
          response.setHeader('Content-Type', 'text/javascript')
          response.end(await code())
        } catch (error) { next(error) }
      })
    },
  }
}
