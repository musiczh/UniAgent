import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname, basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export async function buildMonitor(output = resolve(root, 'release/monitor')) {
  await mkdir(output, { recursive: true })
  const result = await build({ entryPoints: [resolve(root, 'monitor/dashboard.tsx')], outdir: output, entryNames: 'dashboard-[hash]',
    bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic', metafile: true,
    define: { 'process.env.NODE_ENV': JSON.stringify('production') } })
  const script = Object.entries(result.metafile.outputs).find(([, data]) => data.entryPoint)?.[0]
  if (!script) throw new Error('Monitor entry was not built')
  const css = await readFile(resolve(root, 'monitor/style.css'), 'utf8')
  const style = 'style-' + createHash('sha256').update(css).digest('hex').slice(0, 12) + '.css'
  await writeFile(join(output, style), css)
  const html = (await readFile(resolve(root, 'monitor/index.html'), 'utf8')).replace('./dashboard.js', './' + basename(script)).replace('./style.css', './' + style)
  await writeFile(join(output, 'index.html'), html)
  const files = ['index.html', basename(script), style]
  await writeFile(join(output, 'manifest.json'), JSON.stringify({ files }, null, 2) + '\n')
  return { output, files }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await buildMonitor()))
