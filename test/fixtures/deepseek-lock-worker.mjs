import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const [runtime, root, mode] = process.argv.slice(2)
const require = createRequire(join(runtime, 'package.json'))
const imported = name => import(pathToFileURL(require.resolve(name)).href)
const { Context } = await imported('@deepseek-ai/cordis')
const { SESSION_FORMAT_VERSION } = await imported('@deepseek-ai/dsh-session')
const persistence = await imported('@deepseek-ai/dsh-session-persistence-jsonl')
const ctx = new Context()
// 0.2.1 publishes the persistence plugin as a named Cordis plugin instead of a default export.
await ctx.plugin(persistence.default ?? persistence, { root, compression: 'none' })
const id = 'uniagent-isolated-lock-verification'
try {
  if (mode === 'hold') {
    const handle = await ctx.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id, createdAt: 1000, cwd: root, isSeeded: false })
    await handle.append([
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } }
    ])
    process.stdout.write('holding\n')
    await new Promise(resolve => process.once('message', message => { if (message === 'release') resolve() }))
    await handle.close()
    process.stdout.write('released\n')
  } else {
    let handle
    try {
      handle = await ctx.sessionPersistence.open(id, mode === 'read' ? 'read' : 'write')
      const history = await handle.read()
      process.stdout.write(JSON.stringify({ status: 'opened', count: history.events.length }) + '\n')
    } catch (error) {
      if (error.name !== 'SessionAlreadyOwnedError') throw error
      process.stdout.write(JSON.stringify({ status: 'occupied' }) + '\n')
    } finally { await handle?.close() }
  }
} finally {
  await ctx.fiber.dispose()
  process.disconnect?.()
}
